import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeDeep } from "remeda";
import { generate } from "../src/generate.js";
import { AuthoredModel } from "../src/schema.js";
import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { formatModelV2, providerModelToV2 } from "../src/model-file-v2.js";
import { modelV2ToV1 } from "../src/translate.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import { fetchVoidModels, voidApi } from "../src/sync/providers/void-api.js";
import snapshot from "./fixtures/void-api-resolved.json";

// canonical identities come from saved references, never invocation IDs.
// active models carry the latest public API metadata and selling prices.
const baseID = snapshot["gpt-6-astra"].base_model;
const { base_model: _base, cost: _cost, ...fixtureBase } = snapshot["gpt-6-astra"];
const { id: _fixtureID, structured_output: _structuredOutput, ...base } = AuthoredModel.parse({ id: "fixture", ...fixtureBase });
const prices = { input: 1.25, output: 2, cache_read: 0, cache_write: 0.5 };
const row = (id = "route") => ({ id, object: "model", created: 1700000000, owned_by: "not-an-identity",
  base_model: baseID, ...base,
  pricing: { unit: "USD_per_million_tokens", input: "1.25", output: "2", cache_read: "0", cache_write: "0.5" } });
const envelope = (...data: unknown[]) => ({ object: "list", data });
const parsed = (raw: unknown = row()) => voidApi.parseModels(envelope(raw))[0]!;
const formatToml = ({ id: _id, ...model }: Record<string, any>) => formatModelV2(providerModelToV2(model));
const authoredModel = (text: string) => {
  const { id: _id, ...model } = modelV2ToV1({ ...Bun.TOML.parse(text), id: "fixture" });
  return model as ExistingModel;
};
function canonical(id: string) {
  // inherited host metadata excludes enrichment.
  const { id: _id, benchmarks: _benchmarks, license: _license, links: _links, weights: _weights, ...fields } = modelMetadata(id);
  return fields;
}
const context = (authored?: ExistingModel) => ({
  authored: () => authored, existing: () => { throw new Error("must use authored deltas, not resolved fields"); },
});
function resolve(model: ExistingModel) {
  const { base_model, base_model_omit = [], ...overrides } = model;
  const resolved = structuredClone(mergeDeep(canonical(base_model!), overrides));
  for (const field of base_model_omit) {
    const parts = field.split(".");
    const key = parts.pop()!;
    const target = parts.reduce<Record<string, any> | undefined>((value, part) => value?.[part], resolved);
    if (target) delete target[key];
  }
  return resolved;
}

test("explicit canonical base creates override-only prices and API controls", () => {
  expect(providers["void-api"]).toBe(voidApi);
  expect(groups.aggregators).toContain("void-api");
  const translated = voidApi.translateModel(parsed(), context())!;
  expect(translated.model).toEqual({ base_model: baseID, base_model_omit: undefined,
    reasoning_options: base.reasoning_options, cost: prices });
  expect(resolve(translated.model as ExistingModel)).toEqual({ ...base, cost: prices });
  expect(translated.header).toContain("reasoning_effort (/v1/chat/completions)");
  expect(translated.header).not.toContain("Responses");
  expect(translated.header).not.toContain("reasoning.effort");
});

test("same-base references, omissions, curated description and host-only extras survive", () => {
  const authored: ExistingModel = { base_model: baseID, base_model_omit: ["limit.input", "knowledge"],
    description: "Curated host description", status: "beta", interleaved: { field: "reasoning_content" },
    provider: { body: { custom: true } }, cost: { input: 99, output: 99, input_audio: 7 } };
  const model = voidApi.translateModel(parsed(), context(authored))!.model as ExistingModel;
  expect(model).toMatchObject({ ...authored, cost: { ...prices, input_audio: 7 } });
  expect(model).not.toHaveProperty("name");
  expect(model).not.toHaveProperty("knowledge");
  expect(resolve(model).limit).not.toHaveProperty("input");
  expect(resolve(model)).not.toHaveProperty("knowledge");
  expect(voidApi.translateModel(parsed(), context({ base_model: baseID, base_model_omit: [] }))?.model)
    .toMatchObject({ base_model: baseID, base_model_omit: [] });
  // Even if the API provides a value, omissions apply after merge and a
  // required-field omission must fail safely instead of writing an invalid file.
  expect(voidApi.translateModel(parsed(), context({ base_model: baseID, base_model_omit: ["limit.output"] }))).toBeUndefined();
  for (const field of ["limit", "name", "limit..input", "__proto__.polluted", "limit.constructor.prototype", "limit.input."]) {
    expect(voidApi.translateModel(parsed(), context({ base_model: baseID, base_model_omit: [field] }))).toBeUndefined();
  }
});

test("dated regex evidence is scoped to the seven probed invocation/canonical pairs", () => {
  const ids = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"];
  for (const id of ids) {
    const remote = parsed({ ...row(id), base_model: `openai/${id}` });
    const translated = voidApi.translateModel(remote, context())!;
    expect(translated.header).toContain("Freeform probe 2026-11-09");
    expect(translated.header).toContain("custom regex ZZ[0-9]{3}");
    expect(translated.header).toContain(`reasoning_effort=${["gpt-6-astra", "gpt-6.1-sol"].includes(id) ? "low" : "none"}: HTTP 200`);
    expect(translated.header).toContain("tool_calls[].function.arguments (type=function), not custom.input");
    expect(translated.header).toContain("text/lark untested");
    expect(formatToml({ id, ...translated.model })).not.toContain("freeform");
  }
  for (const remote of [row("future-gpt"), { ...row("gpt-6-astra"), base_model: "openai/gpt-6-sol" }]) {
    expect(voidApi.translateModel(parsed(remote), context())!.header).not.toContain("Freeform probe");
  }
});

test("enriched metadata emits genuine deltas, not duplicated lab facts", () => {
  const remote = { ...row(), name: "Served alias", attachment: false,
    modalities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: base.limit.output } };
  const model = voidApi.translateModel(parsed(remote), context())!.model;
  expect(model).toEqual({ base_model: baseID, base_model_omit: ["limit.input"],
    name: "Served alias", attachment: false, modalities: { input: ["text"] },
    limit: { context: 200000 }, reasoning_options: base.reasoning_options, cost: prices });
  expect(resolve(model as ExistingModel).limit).toEqual({ context: 200000, output: base.limit.output });
  const reordered = { ...row(), modalities: { ...base.modalities, input: [...base.modalities.input].reverse() } };
  expect(voidApi.translateModel(parsed(reordered), context())?.model).not.toHaveProperty("modalities");
  // Migrating an inline entry must not re-inject an identical description.
  expect(voidApi.translateModel(parsed(), context({ ...base, cost: prices } as ExistingModel))?.model)
    .not.toHaveProperty("description");
});

test("canonical lab facts replace gateway overrides while preserving host display deltas", () => {
  const metadata = canonical(baseID);
  const remote = parsed({ ...row(), name: "Gateway name", description: "Gateway description",
    family: "gpt", knowledge: "2025-01", release_date: "2026-01-01", last_updated: "2026-01-02", open_weights: true });
  const model = voidApi.translateModel(remote, context({ name: "Local name", description: "Local description",
    family: "gpt", release_date: "2026-02-01", last_updated: "2026-02-02", open_weights: true }))!.model as ExistingModel;
  expect(model).toMatchObject({ name: "Gateway name", description: "Local description" });
  for (const field of ["family", "knowledge", "release_date", "last_updated", "open_weights"]) {
    expect(model).not.toHaveProperty(field);
    expect(resolve(model)[field]).toEqual(metadata[field]);
  }
});

test("controls come directly from the API, including [] and server-filtered sets", () => {
  const controls: NonNullable<ExistingModel["reasoning_options"]>[] = [[], [{ type: "effort", values: ["none", "high", "max"] }], [{ type: "toggle" }, { type: "budget_tokens", min: 1024 }]];
  const { base_model, cost: _cost, ...metadata } = snapshot["claude-sonnet-5"];
  for (const reasoning_options of controls) {
    const remote = parsed({ ...row(), ...metadata, base_model, reasoning_options });
    const translated = voidApi.translateModel(remote, context({ base_model, reasoning_options: [] }))!;
    expect(translated.model.reasoning_options).toEqual(reasoning_options);
    expect(translated.header).not.toContain("Responses");
    if (reasoning_options.some((option) => option.type === "toggle")) expect(translated.header).toContain("# Toggle: thinking.type = enabled|disabled (chat only");
    if (reasoning_options.some((option) => option.type === "budget_tokens")) expect(translated.header).toContain("thinking.budget_tokens (chat only)");
  }
  const model = voidApi.translateModel(parsed({ ...row(), reasoning: false, reasoning_options: undefined }), context({ reasoning_options: [] }))!.model;
  expect(model).toHaveProperty("reasoning", false);
  expect(model).not.toHaveProperty("reasoning_options");
});

test("reasoning headers are regenerated solely from API controls", () => {
  const remote = parsed({ ...row(), reasoning_options: [] });
  const translated = voidApi.translateModel(remote, context())!;
  expect(translated.header).toBe("");
  expect(voidApi.translateModel(remote, context())!.header)
    .toBe(translated.header);
});

test("non-Anthropic toggle and budget controls do not advertise Anthropic wire paths", () => {
  const remote = parsed({ ...row(), reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1024 }] });
  const translated = voidApi.translateModel(remote, context())!;
  expect(translated.model.reasoning_options).toEqual([{ type: "toggle" }, { type: "budget_tokens", min: 1024 }]);
  expect(translated.header).toBe("");
});

test("missing, invalid, unresolved or changed identity never guesses or replaces references", () => {
  for (const base_model of [undefined, null, "", 7, {}, "gpt-6-astra", "openai/unknown", "../escape", "openai/%2e%2e", "openai/gpt-6-astra/../other"]) {
    const remote = parsed({ ...row("gpt-6-astra"), owned_by: "openai", base_model });
    const ctx = context({ ...base, base_model: baseID, cost: prices } as ExistingModel);
    expect(voidApi.translateModel(remote, ctx)).toBeUndefined();
    expect(voidApi.missingModelID(remote)).toBe("gpt-6-astra");
  }
  expect(voidApi.translateModel(parsed(), context({ base_model: "openai/gpt-6-sol", description: "curated" }))).toBeUndefined();
});

test("incomplete or invalid API metadata skips even with complete local fields", () => {
  for (const field of ["name", "description", "attachment", "reasoning", "tool_call", "open_weights", "release_date", "last_updated", "modalities", "limit", "reasoning_options"]) {
    const raw: Record<string, unknown> = row(); delete raw[field];
    expect(voidApi.translateModel(parsed(raw), context(base as ExistingModel))).toBeUndefined();
  }
  for (const fields of [{ limit: { context: 10 } }, { attachment: "yes" }, { reasoning_options: [{ type: "effort", values: ["invented"] }] }]) {
    expect(voidApi.translateModel(parsed({ ...row(), ...fields }), context(base as ExistingModel))).toBeUndefined();
  }
});

test("schema fails closed on unsafe IDs, empty envelopes and malformed prices", () => {
  const invalid = [null, [], envelope(), envelope(row(), row()), envelope(row("Route"), row("route")),
    ...[".", "..", "a/.", "a/..", "./a", "../escape", "a/../escape", "/absolute", "a\\b", "a//b", "a/%2e%2e/b"].map((id) => envelope(row(id))),
    ...["-1", "NaN", "Infinity", "", " 1", "1e999", "9".repeat(400)].map((input) => envelope({ ...row(), pricing: { ...row().pricing, input } })),
    envelope({ ...row(), pricing: { ...row().pricing, unit: "USD_per_token" } })];
  for (const raw of invalid) expect(() => voidApi.parseModels(raw)).toThrow();
  expect(parsed(row("lab/nested:v1@region")).id).toBe("lab/nested:v1@region");
});

test("factored TOMLs preserve current metadata/prices and contain only genuine overrides", async () => {
  expect(Object.keys(snapshot)).toHaveLength(13);
  for (const [id, enriched] of Object.entries(snapshot)) {
    const { base_model, ...fixtureFields } = enriched;
    const { id: _id, ...apiFields } = AuthoredModel.parse({ id, ...fixtureFields });
    const inherited = canonical(base_model);
    const expected = { ...apiFields, ...Object.fromEntries(["family", "knowledge", "release_date", "last_updated", "open_weights"].map((key) => [key, inherited[key]])) };
    const text = await Bun.file(`providers/void-api/models/${id}.toml`).text();
    const authored = authoredModel(text);
    expect(authored).toMatchObject({ base_model, reasoning_options: expected.reasoning_options, cost: expected.cost });
    for (const [key, value] of Object.entries(authored)) {
      if (["base_model", "base_model_omit", "reasoning", "reasoning_options", "cost"].includes(key)) continue;
      expect(value).not.toEqual(inherited[key]);
    }
    expect(resolve(authored)).toEqual(expected);
    expect(AuthoredModel.safeParse({ id, ...resolve(authored) }).success).toBe(true);
    expect(text).not.toContain("Responses");
    expect(text).not.toContain("reasoning.effort");
    const { cost, ...metadata } = enriched;
    const remote = parsed({ id, object: "model", created: 1700000000, owned_by: "void", ...metadata, pricing: { unit: "USD_per_million_tokens",
      ...Object.fromEntries(Object.entries(cost).map(([key, price]) => [key, String(price)])) } });
    const translated = voidApi.translateModel(remote, context(authored))!;
    expect(translated).toBeDefined();
    const { reasoning: _reasoning, ...authoredDeltas } = authored;
    expect(Object.fromEntries(Object.entries(translated.model).filter(([, value]) => value !== undefined))).toEqual(authoredDeltas);
    expect(authoredModel(formatToml({ id, ...translated.model }))).toEqual(authored);
  }
});

async function fixture(run: (modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "void-sync-"));
  const modelsDir = path.join(root, "providers/void-api/models");
  await mkdir(modelsDir, { recursive: true });
  // The runner loads canonical metadata relative to this provider directory.
  await symlink(path.resolve("models"), path.join(root, "models"), "dir");
  try { await run(modelsDir); } finally { await rm(root, { recursive: true, force: true }); }
}

test("catalog snapshot is unchanged through the stock runner", async () => fixture(async (modelsDir) => {
  const data: unknown[] = [];
  for (const [id, { cost, ...metadata }] of Object.entries(snapshot)) {
    await Bun.write(path.join(modelsDir, `${id}.toml`), await Bun.file(`providers/void-api/models/${id}.toml`).text());
    data.push({ id, object: "model", created: 1700000000, owned_by: "void", ...metadata,
      pricing: { unit: "USD_per_million_tokens", ...Object.fromEntries(Object.entries(cost).map(([key, value]) => [key, String(value)])) } });
  }
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(...data) };
  for (let i = 0; i < 2; i++) {
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 13 });
  }
}));

test("runner auto-generates newly discovered opaque IDs with base references; repeated sync unchanged", async () => fixture(async (modelsDir) => {
  const id = "new-lane/nested:v1@region";
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row(id)) };
  expect((await syncProvider(provider, { dryRun: true })).created).toBe(1);
  const file = path.join(modelsDir, `${id}.toml`);
  expect(await Bun.file(file).exists()).toBe(false);
  expect((await syncProvider(provider)).created).toBe(1);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  provider.fetchModels = async () => envelope({ ...row(id), reasoning_options: [{ type: "effort", values: ["high"] }] });
  expect((await syncProvider(provider)).updated).toBe(1);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  const text = await Bun.file(file).text();
  expect(authoredModel(text)).toEqual({ base_model: baseID, reasoning: true,
    reasoning_options: [{ type: "effort", values: ["high"] }], cost: prices });
  expect(text).not.toContain("release_date");
  expect(text).not.toContain("description");
  await Bun.write(path.join(path.dirname(modelsDir), "provider.toml"), await Bun.file("providers/void-api/provider.toml").text());
  const catalog = await generate(path.dirname(path.dirname(modelsDir)));
  const published = catalog["void-api"]!.models[id]!;
  expect(published).toMatchObject({ id, canonical_model_id: baseID, name: base.name,
    limit: base.limit, cost: prices, reasoning_options: [{ type: "effort", values: ["high"] }] });
  expect(published).not.toHaveProperty("base_model");
  expect(published).not.toHaveProperty("benchmarks");
}));

test("runner preserves authored omissions/reference/extras and sanitizes unsupported headers", async () => fixture(async (modelsDir) => {
  const authored = { id: "route", base_model: baseID, base_model_omit: ["limit.input"],
    description: "Curated description", reasoning_options: base.reasoning_options, status: "beta" as const, cost: prices };
  const file = path.join(modelsDir, "route.toml");
  await Bun.write(file, "# Curated source\n# Effort: reasoning_effort (chat), reasoning.effort (Responses).\n" + formatToml(authored as any));
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row()) };
  expect((await syncProvider(provider)).updated).toBe(1);
  const text = await Bun.file(file).text();
  const { id: _id, ...expected } = authored;
  expect(authoredModel(text)).toEqual({ ...expected, reasoning: true });
  expect(text).toStartWith("# Effort: reasoning_effort (/v1/chat/completions).");
  expect(text).not.toContain("Curated source");
  expect(text).not.toContain("Responses");
  expect((await syncProvider(provider)).status).toBe("unchanged");
}));

test("outage and mapping skips preserve bytes; missing models retained; failures never write", async () => fixture(async (modelsDir) => {
  const original = "# curated\n" + formatToml({ id: "route", base_model: baseID,
    base_model_omit: ["limit.input"], reasoning_options: base.reasoning_options, cost: { input: 9, output: 9 } } as any);
  const file = path.join(modelsDir, "route.toml");
  await Bun.write(file, original);
  await Bun.write(path.join(modelsDir, "paused.toml"), original);
  const { name: _name, ...incomplete } = row();
  for (const remote of [incomplete, ...[undefined, null, "../escape", "openai/unknown", "openai/gpt-6-sol"].map((base_model) => ({ ...row(), base_model }))]) {
    const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(remote) };
    const result = await syncProvider(provider, { openIssues: true, dryRun: true });
    expect(result.updated).toBe(0); expect(result.deleted).toBe(0);
    expect(result.notices.join("\n")).toContain("manual review");
    expect(result.notices.join("\n")).toContain("[missing-model] void-api: route");
    await syncProvider(provider);
    expect(await Bun.file(file).text()).toBe(original);
    expect(await Bun.file(path.join(modelsDir, "paused.toml")).text()).toBe(original);
  }
  for (const fetchModels of [async () => envelope(), async () => envelope(row(), row()), async () => { throw new Error("network"); }]) {
    await expect(syncProvider({ ...voidApi, modelsDir, fetchModels })).rejects.toThrow();
    expect(await Bun.file(file).text()).toBe(original);
  }
}));

test("mixed feed creates valid models without creating unmapped IDs or deleting existing entries", async () => fixture(async (modelsDir) => {
  const original = "# keep inline until reviewed\n" + formatToml({ id: "route", ...base, cost: prices } as any);
  await Bun.write(path.join(modelsDir, "route.toml"), original);
  const result = await syncProvider({ ...voidApi, modelsDir, fetchModels: async () => envelope(
    { ...row(), base_model: undefined }, { ...row("gpt-6-astra"), base_model: null }, row("new-opaque-route")) });
  expect(result.created).toBe(1); expect(result.updated).toBe(0); expect(result.deleted).toBe(0);
  expect(await Bun.file(path.join(modelsDir, "route.toml")).text()).toBe(original);
  expect(await Bun.file(path.join(modelsDir, "gpt-6-astra.toml")).exists()).toBe(false);
  expect(Bun.TOML.parse(await Bun.file(path.join(modelsDir, "new-opaque-route.toml")).text())).toHaveProperty("base_model", baseID);
}));

test("fetch public endpoint and HTTP failures", async () => {
  const fetcher = (async (url: unknown, options: RequestInit) => {
    expect(url).toBe("https://void-api.tech/v1/models"); expect(options.signal).toBeInstanceOf(AbortSignal);
    return Response.json(envelope(row()));
  }) as unknown as typeof fetch;
  expect(await fetchVoidModels(fetcher)).toEqual(envelope(row()));
  await expect(fetchVoidModels((async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("503");
});
