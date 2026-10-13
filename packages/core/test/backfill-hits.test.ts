import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dir, "../script/backfill-hits.ts");

async function run(args: string[], endpoint?: string) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, LAKE_ENDPOINT: endpoint ?? "", LAKE_TOKEN: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    output:
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text()),
  };
}

test("exports the entire legacy history unless a time window is requested", async () => {
  const result = await run(["sql", "--to", "s3://bucket/hits/", "--no-path"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("WHERE event_type = 'models.hit'");
  expect(result.output).not.toContain("event_timestamp <");
});

test("resumes accepted batches and rejects changed exports or destinations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "models-backfill-"));
  const received: number[] = [];
  let rejected = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const rows = await request.json() as { payload: { path: string } }[];
      if (received.length === 10_000 && !rejected) {
        rejected = true;
        return new Response("stop", { status: 400 });
      }
      received.push(
        ...rows.map((row: { payload: { path: string } }) =>
          Number(row.payload.path),
        ),
      );
      return new Response(null, { status: 204 });
    },
  });
  try {
    await Bun.write(
      path.join(dir, "export.gz"),
      Bun.gzipSync(
        Array.from({ length: 25_004 }, (_, index) =>
          JSON.stringify({
            event_timestamp: "2026-01-01T00:00:00.000Z",
            path: String(index),
          }),
        ).join("\n"),
      ),
    );
    expect(
      (await run(["send", dir, "--concurrency", "1"], server.url.href)).code,
    ).toBe(1);
    expect(received).toHaveLength(10_000);
    expect(
      (await run(["send", dir, "--concurrency", "1"], server.url.href)).code,
    ).toBe(0);
    expect(received).toEqual(
      Array.from({ length: 25_004 }, (_, index) => index),
    );
    expect((await run(["send", dir], server.url.href)).output).toContain(
      "Sent 0 events",
    );
    expect((await run(["send", dir, "--dry-run"])).output).toContain(
      "Parsed 25004 events",
    );
    expect((await run(["send", dir], server.url.href + "other")).code).toBe(1);
    await Bun.write(path.join(dir, "export.gz"), Bun.gzipSync("{}"));
    expect((await run(["send", dir], server.url.href)).output).toContain(
      "Checkpoint does not match",
    );
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("batches by UTF-8 bytes and preserves the original timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "models-backfill-"));
  const sizes: number[] = [];
  let received = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      sizes.push(Buffer.byteLength(body));
      const rows = JSON.parse(body);
      expect(
        rows.every(
          (row: { timestamp: string }) =>
            row.timestamp === "2025-02-03T04:05:06.789Z",
        ),
      ).toBe(true);
      received += rows.length;
      return new Response(null, { status: 204 });
    },
  });
  try {
    await Bun.write(
      path.join(dir, "export"),
      Array.from({ length: 1_400 }, () =>
        JSON.stringify({
          event_timestamp: "2025-02-03T04:05:06.789Z",
          user_agent: "😀".repeat(1_000),
        }),
      ).join("\n"),
    );
    expect((await run(["send", dir], server.url.href)).code).toBe(0);
    expect(received).toBe(1_400);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size <= 4_500_000)).toBe(true);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails on invalid historical timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "models-backfill-"));
  try {
    await Bun.write(
      path.join(dir, "export"),
      JSON.stringify({ event_timestamp: "invalid" }),
    );
    const result = await run(["send", dir, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("no valid event_timestamp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
