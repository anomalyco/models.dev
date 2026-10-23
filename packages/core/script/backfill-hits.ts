import { Buffer } from "node:buffer";
import { rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { hitEvent } from "../src/hit.js";

const usage = `Backfill models.dev hits from the legacy opencode S3 lake into the platform lake.

  bun packages/core/script/backfill-hits.ts sql --to <s3-uri> [--before <time>] [--after <time>] [--no-path]
    Print an Athena UNLOAD of models.hit rows. After the old writer has stopped
    and Firehose has drained, omit --before to include the entire S3 history.
    Run it in the opencode-production-lake-workgroup workgroup, then download the
    export with: aws s3 sync <s3-uri> <dir>

  LAKE_ENDPOINT=<url> LAKE_TOKEN=<token> bun packages/core/script/backfill-hits.ts send <dir> [--dry-run] [--concurrency 4]
    Replay an export into the platform lake event stream. Progress is saved in
    <dir>/.backfill-hits.json, so rerunning resumes where it stopped.`;

const MAX_RECORDS = 10_000;
// Include JSON framing in the byte count; HTTP ingestion is limited to 5 MB.
const MAX_BYTES = 4_500_000;
const MAX_ATTEMPTS = 8;

const [command, ...args] = process.argv.slice(2);
if (command === "sql") sql(args);
else if (command === "send")
  await send(args).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
else fail(usage);

function sql(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      before: { type: "string" },
      after: { type: "string" },
      to: { type: "string" },
      "no-path": { type: "boolean", default: false },
    },
  });
  if (!values.to) fail(usage);
  if (!/^s3:\/\/[^']+\/$/.test(values.to))
    fail("--to must be an s3:// prefix ending in /");

  const columns = ["event_timestamp", "ip", "user_agent", "cf_country"];
  if (!values["no-path"]) columns.push("path");
  const after = values.after
    ? `\n    AND event_timestamp >= '${timestamp(values.after)}'`
    : "";
  const before = values.before
    ? `\n    AND event_timestamp < '${timestamp(values.before)}'`
    : "";
  console.log(`UNLOAD (
  SELECT ${columns.join(", ")}
  FROM "s3tablescatalog/opencode-production-lake"."inference"."event"
  WHERE event_type = 'models.hit'${after}${before}
)
TO '${values.to}'
WITH (format = 'JSON', compression = 'GZIP')`);
}

async function send(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      concurrency: { type: "string", default: "4" },
    },
  });
  const dir = positionals[0];
  if (!dir) fail(usage);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    fail("--concurrency must be a positive integer");
  const target = values["dry-run"] ? undefined : requireTarget();

  // Glob skips dotfiles, so the progress file is never replayed.
  const files = (
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true }),
    )
  ).sort();
  if (files.length === 0) fail(`No export files in ${dir}`);

  const manifest = await Promise.all(
    files.map(async (file) => {
      const hash = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path.join(dir, file)).stream())
        hash.update(chunk);
      return { file, sha256: hash.digest("hex") };
    }),
  );
  const progressPath = path.join(dir, ".backfill-hits.json");
  const checkpoint =
    target && (await Bun.file(progressPath).exists())
      ? await Bun.file(progressPath).json()
      : undefined;
  if (
    checkpoint &&
    (checkpoint.version !== 1 ||
      checkpoint.endpoint !== target?.endpoint ||
      JSON.stringify(checkpoint.manifest) !== JSON.stringify(manifest))
  )
    fail(
      "Checkpoint does not match this export and endpoint; use a separate directory for a new backfill",
    );
  const progress: Record<string, number | "done"> = checkpoint?.progress ?? {};
  if (
    Object.entries(progress).some(
      ([file, value]) =>
        !files.includes(file) ||
        (value !== "done" && (!Number.isSafeInteger(value) || value < 0)),
    )
  )
    fail("Invalid backfill checkpoint");
  const stats = { sent: 0, batches: 0, done: 0, first: "", last: "" };
  let saving = Promise.resolve();

  const save = () => {
    if (!target) return saving;
    saving = saving.then(async () => {
      await Bun.write(
        `${progressPath}.tmp`,
        JSON.stringify({
          version: 1,
          endpoint: target.endpoint,
          manifest,
          progress,
        }),
      );
      await rename(`${progressPath}.tmp`, progressPath);
    });
    return saving;
  };

  const post = async (batch: string[]) => {
    stats.batches++;
    if (!target) return;
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(target.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.token}`,
        },
        body: `[${batch.join(",")}]`,
      }).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      if (response instanceof Response && response.ok) {
        await response.body?.cancel();
        return;
      }

      const retryable =
        !(response instanceof Response) ||
        response.status === 429 ||
        response.status >= 500;
      const reason =
        response instanceof Response
          ? `${response.status} ${await response.text()}`
          : response.message;
      if (!retryable || attempt >= MAX_ATTEMPTS)
        throw new Error(`Stream rejected a batch: ${reason}`);
      const retryAfter =
        response instanceof Response
          ? Number(response.headers.get("retry-after")) * 1000
          : 0;
      const wait = Math.max(
        retryAfter || 0,
        Math.min(60_000, 1000 * 2 ** (attempt - 1)),
      );
      console.warn(`Retrying in ${wait}ms after ${reason}`);
      await Bun.sleep(wait);
    }
  };

  // Progress counts non-empty lines, so a resumed file skips exactly the rows
  // already sent regardless of batch sizes.
  const sendFile = async (file: string) => {
    const saved = progress[file];
    if (saved === "done") {
      stats.done++;
      return;
    }
    let consumed = 0;
    let batch: string[] = [];
    let size = 2;
    for await (const line of lines(path.join(dir, file))) {
      consumed++;
      if (consumed <= (saved ?? 0)) continue;
      const event = toEvent(line);
      const json = JSON.stringify(event);
      const bytes = Buffer.byteLength(json);
      if (bytes + 2 > MAX_BYTES)
        throw new Error(`Row ${consumed} exceeds the ingestion byte limit`);
      if (
        batch.length > 0 &&
        (batch.length >= MAX_RECORDS || size + bytes + 1 > MAX_BYTES)
      ) {
        await post(batch);
        stats.sent += batch.length;
        progress[file] = consumed - 1;
        await save();
        batch = [];
        size = 2;
      }
      batch.push(json);
      size += bytes + (batch.length > 1 ? 1 : 0);
      if (!stats.first || event.timestamp < stats.first)
        stats.first = event.timestamp;
      if (event.timestamp > stats.last) stats.last = event.timestamp;
    }
    if (batch.length > 0) {
      await post(batch);
      stats.sent += batch.length;
    }
    progress[file] = "done";
    await save();
    stats.done++;
  };

  const report = () =>
    console.log(
      `${target ? "Sent" : "Parsed"} ${stats.sent} events in ${stats.batches} batches, ${stats.done}/${files.length} files done`,
    );
  const timer = setInterval(report, 30_000);
  const queue = [...files];
  const errors: Error[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        if (errors.length) return;
        await sendFile(file).catch((error: unknown) => {
          errors.push(
            new Error(
              `${file}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        });
      }
    }),
  ).finally(() => clearInterval(timer));
  report();
  if (errors.length) throw errors[0];
  if (stats.first)
    console.log(`Event timestamps span ${stats.first} to ${stats.last}`);
}

async function* lines(file: string) {
  const head = await Bun.file(file).slice(0, 2).bytes();
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const bytes = gzip
    ? Bun.file(file).stream().pipeThrough(new DecompressionStream("gzip"))
    : Bun.file(file).stream();
  let rest = "";
  for await (const chunk of bytes.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) yield part;
  }
  if (rest.trim()) yield rest;
}

function toEvent(line: string) {
  const row = JSON.parse(line) as Record<string, unknown>;
  const time =
    typeof row.event_timestamp === "string"
      ? Date.parse(row.event_timestamp)
      : NaN;
  if (Number.isNaN(time))
    throw new Error("Export row has no valid event_timestamp");
  return hitEvent(new Date(time).toISOString(), {
    path: text(row.path),
    useragent: text(row.user_agent),
    ip: text(row.ip),
    cf_country: text(row.cf_country),
  });
}

function text(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function timestamp(value: string) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail(`Invalid timestamp: ${value}`);
  return new Date(time).toISOString();
}

function requireTarget() {
  const endpoint = process.env.LAKE_ENDPOINT;
  const token = process.env.LAKE_TOKEN;
  if (!endpoint || !token)
    fail("LAKE_ENDPOINT and LAKE_TOKEN are required unless --dry-run is set");
  return { endpoint, token };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
