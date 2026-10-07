import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatToml, groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { fetchVoidModels, voidApi } from "../src/sync/providers/void-api.js";
import snapshot from "./fixtures/void-api-resolved.json";

const base = { name: "Fixture", description: "Fixture model", attachment: false, reasoning: false,
  tool_call: true, open_weights: true, release_date: "2025-01-01", last_updated: "2025-01-01",
  modalities: { input: ["text" as const], output: ["text" as const] }, limit: { context: 10000, output: 1000 } };
const row = (id = "route") => ({ id, object: "model", created: 1700000000, owned_by: "lab", ...base,
  pricing: { unit: "USD_per_million_tokens", input: "1.25", output: "2", cache_read: "0", cache_write: "0.5" } });
const envelope = (...data: unknown[]) => ({ object: "list", data });
const parsed = (raw: unknown = row()) => voidApi.parseModels(envelope(raw))[0]!;
const context = (authored: any = undefined) => ({ authored: () => authored, existing: () => authored,
  metadata: () => { throw new Error("must not load metadata"); }, firstParty: () => { throw new Error("must not load peers"); } });

test("full API metadata and prices, no inheritance or metadata dependency", () => {
  expect(providers["void-api"]).toBe(voidApi);
  expect(groups.aggregators).toContain("void-api");
  expect(voidApi).not.toHaveProperty("needsMetadata");
  expect(voidApi.translateModel(parsed(), context())?.model).toEqual({ ...base, cost: { input: 1.25, output: 2, cache_read: 0, cache_write: 0.5 } });
  expect(voidApi.translateModel(parsed(), context({ base_model: "lab/old", base_model_omit: ["limit.output"], status: "beta", description: "curated", cost: { input_audio: 7 } }))?.model).toMatchObject({ description: "curated", status: "beta", cost: { input_audio: 7, input: 1.25 } });
  expect(voidApi.translateModel(parsed(), context({ base_model: "lab/old" }))?.model).not.toHaveProperty("base_model");
});

test("controls come directly from API, including [] and server-filtered sets", () => {
  const controls: NonNullable<ExistingModel["reasoning_options"]>[] = [[], [{ type: "effort", values: ["none", "high", "max"] }], [{ type: "toggle" }, { type: "budget_tokens", min: 1024 }]];
  for (const reasoning_options of controls) {
    expect(voidApi.translateModel(parsed({ ...row(), reasoning: true, reasoning_options }), context({ reasoning_options: [] }))?.model.reasoning_options).toEqual(reasoning_options);
  }
});

test("incomplete API metadata skips even with complete local fields", () => {
  for (const field of ["name", "description", "attachment", "reasoning", "tool_call", "open_weights", "release_date", "last_updated", "modalities", "limit"]) {
    const raw: any = row(); delete raw[field];
    expect(voidApi.translateModel(parsed(raw), context(base))).toBeUndefined();
  }
  for (const fields of [{ reasoning: true }, { limit: { context: 10 } }, { attachment: "yes" }]) {
    expect(voidApi.translateModel(parsed({ ...row(), ...fields }), context(base))).toBeUndefined();
  }
});

test("schema fails closed on unsafe IDs, empty envelopes and malformed prices", () => {
  const invalid = [null, [], envelope(), envelope(row(), row()), envelope(row("Route"), row("route")),
    ...["../escape", "a/../escape", "/absolute", "a\\b", "a//b", "a/%2e%2e/b"].map((id) => envelope(row(id))),
    ...["-1", "NaN", "Infinity", "", " 1", "1e999", "9".repeat(400)].map((input) => envelope({ ...row(), pricing: { ...row().pricing, input } })),
    envelope({ ...row(), pricing: { ...row().pricing, unit: "USD_per_token" } })];
  for (const raw of invalid) expect(() => voidApi.parseModels(raw)).toThrow();
  expect(parsed(row("lab/nested:v1@region")).id).toBe("lab/nested:v1@region");
});

test("migrated 13 authored files equal locally resolved pre-migration snapshot", async () => {
  expect(Object.keys(snapshot)).toHaveLength(13);
  for (const [id, expected] of Object.entries(snapshot)) {
    const text = await Bun.file(`providers/void-api/models/${id}.toml`).text();
    expect(Bun.TOML.parse(text)).toEqual(expected);
    expect(text).not.toContain("base_model");
  }
});

async function fixture(run: (modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "void-sync-"));
  const modelsDir = path.join(root, "providers/void-api/models");
  await mkdir(modelsDir, { recursive: true });
  try { await run(modelsDir); } finally { await rm(root, { recursive: true, force: true }); }
}

test("runner full entries, direct controls refresh, repeated sync unchanged", async () => fixture(async (modelsDir) => {
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row()) };
  expect((await syncProvider(provider, { dryRun: true })).created).toBe(1);
  expect(await Bun.file(path.join(modelsDir, "route.toml")).exists()).toBe(false);
  expect((await syncProvider(provider)).created).toBe(1);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  provider.fetchModels = async () => envelope({ ...row(), reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] });
  expect((await syncProvider(provider)).updated).toBe(1);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  const text = await Bun.file(path.join(modelsDir, "route.toml")).text();
  expect(text).toContain("release_date"); expect(text).not.toContain("base_model");
}));

test("outage skips preserve bytes, missing models retained, failures never write", async () => fixture(async (modelsDir) => {
  const original = "# curated\n" + formatToml({ id: "route", ...base, cost: { input: 9, output: 9 } } as any);
  const file = path.join(modelsDir, "route.toml");
  await Bun.write(file, original);
  await Bun.write(path.join(modelsDir, "paused.toml"), original);
  const { name, ...incomplete } = row();
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(incomplete) };
  const result = await syncProvider(provider, { openIssues: true, dryRun: true });
  expect(result.updated).toBe(0); expect(result.deleted).toBe(0);
  expect(result.notices.join("\n")).toContain("manual review");
  expect(result.notices.join("\n")).toContain("[missing-model] void-api: route");
  await syncProvider(provider);
  expect(await Bun.file(file).text()).toBe(original);
  expect(await Bun.file(path.join(modelsDir, "paused.toml")).text()).toBe(original);
  for (const fetchModels of [async () => envelope(), async () => envelope(row(), row()), async () => { throw new Error("network"); }]) {
    await expect(syncProvider({ ...provider, fetchModels })).rejects.toThrow();
    expect(await Bun.file(file).text()).toBe(original);
  }
}));

test("fetch public endpoint and HTTP failures", async () => {
  const fetcher = (async (url: unknown, options: RequestInit) => {
    expect(url).toBe("https://void-api.tech/v1/models"); expect(options.signal).toBeInstanceOf(AbortSignal);
    return Response.json(envelope(row()));
  }) as unknown as typeof fetch;
  expect(await fetchVoidModels(fetcher)).toEqual(envelope(row()));
  await expect(fetchVoidModels((async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("503");
});
