import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatModelV2 } from "../src/model-file-v2.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import { modelMetadata } from "../src/sync/providers/openrouter.js";
import {
  anonrouter,
  AnonRouterModel,
  fetchAnonRouterModels,
  parseAnonRouterModels,
  updateAnonRouterModel,
} from "../src/sync/providers/anonrouter.js";

function row(overrides: Record<string, unknown> = {}) {
  return AnonRouterModel.parse({
    id: "deepseek/deepseek-v3",
    model_type: "text",
    context_window: 163_840,
    max_output_tokens: 16_384,
    pricing: { input_usd_per_million_tokens: 0.37, output_usd_per_million_tokens: 1.025, unit_usd: null },
    ...overrides,
  });
}

function authenticated(data = [row()]) {
  return { source: "authenticated", payload: { object: "list", data } };
}

function modelFile() {
  return {
    schema: 2,
    base_model: "deepseek/deepseek-v3",
    limit: { context: 163_840, output: 16_384 },
    api: { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } },
    capabilities: { tools: { supported: true }, reasoning: { supported: false } },
    cost: { text: { input: { price: 0.37 }, output: { price: 1.025 } } },
  };
}

test("registered sync uses an authenticated catalog only when a key is provided", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === "anonrouter")).toBe(true);
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input.toString(), init));
    return Response.json({});
  }) as typeof fetch;
  expect(await fetchAnonRouterModels(fetcher, "test-key")).toMatchObject({ source: "authenticated" });
  expect(requests[0]!.url).toBe("https://api.anonrouter.ai/v1/models");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-key");
  expect(await fetchAnonRouterModels(fetcher, "")).toMatchObject({ source: "public" });
  expect(requests[1]!.url).toBe("https://control.anonrouter.ai/v1/catalog/models");
  expect(requests[1]!.headers.has("authorization")).toBe(false);
  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  await expect(fetchAnonRouterModels(unavailable, "")).rejects.toThrow("503");
});

test("empty, duplicate, unsafe and malformed catalogs fail before writes", () => {
  expect(() => parseAnonRouterModels(authenticated([]))).toThrow("empty catalog");
  expect(() => parseAnonRouterModels(authenticated([row(), row()]))).toThrow("duplicate model IDs");
  expect(() => parseAnonRouterModels(authenticated([row(), row({ id: "DeepSeek/DeepSeek-V3" })]))).toThrow("duplicate model IDs");
  expect(() => row({ id: "../outside" })).toThrow("relative catalog path");
  expect(() => row({ id: "/absolute" })).toThrow("relative catalog path");
  expect(() => row({ context_window: -1 })).toThrow();
  expect(() => row({ pricing: { input_usd_per_million_tokens: -0.1, output_usd_per_million_tokens: 1, unit_usd: null } })).toThrow();
});

test("public discovery filters non-callable entries and includes the separate router inventory", () => {
  const source = {
    source: "public",
    payload: {
      stale: true,
      models: [{ id: "example/available", callable: true }, { id: "example/not-enabled", callable: false }],
      routers: [{ id: "anonrouter/cheap" }],
    },
  };
  const rows = parseAnonRouterModels(source);
  expect(rows.map((model) => model.id)).toEqual(["example/available", "anonrouter/cheap"]);
  expect(anonrouter.sourceNotices(rows).join(" ")).toContain("discovery-only");
  expect(anonrouter.sourceNotices(rows).join(" ")).toContain("stale");
  expect(() => parseAnonRouterModels({ ...source, payload: { models: [], routers: [] } })).toThrow("empty public catalog");
  expect(() => parseAnonRouterModels({ ...source, payload: { models: [{ id: "x", callable: false }], routers: [] } })).toThrow("no callable models");
  expect(() => parseAnonRouterModels({ ...source, payload: { models: [{ id: "x", callable: true }], routers: [{ id: "x" }] } })).toThrow("duplicate");
});

test("Hy4 Uncensored stays excluded from both inventories pending lifecycle confirmation", () => {
  const excluded = row({ id: "tencent/hy4-uncensored" });
  expect(parseAnonRouterModels(authenticated([row(), excluded])).map((model) => model.id)).toEqual([row().id]);
  expect(() => parseAnonRouterModels(authenticated([excluded]))).toThrow("no callable models");
  const publicCatalog = (ids: string[]) => ({ source: "public", payload: {
    models: ids.map((id) => ({ id, callable: true })), routers: [],
  } });
  expect(parseAnonRouterModels(publicCatalog([row().id, excluded.id])).map((model) => model.id)).toEqual([row().id]);
  expect(() => parseAnonRouterModels(publicCatalog([excluded.id]))).toThrow("no callable models");
});

test("public preferred-route prices and reasoning never replace the authored API definition", () => {
  const current = modelFile();
  const model = parseAnonRouterModels({
    source: "public",
    payload: { models: [{ id: row().id, callable: true, inputPriceUsdPerMillion: 999, reasoning: { supported: true } }], routers: [] },
  })[0]!;
  const translated = anonrouter.translateModel(model, { existing: () => undefined, authored: () => undefined, v2: () => current });
  expect(translated!.v2).toBe(current);
});

test("authenticated updates preserve lab identity, reviewed controls, APIs and cache details", () => {
  const current = {
    ...modelFile(),
    capabilities: { reasoning: { supported: true, effort: ["none", "high", "max"] }, tools: { supported: true, choice: ["auto"] } },
    metadata: { owner: "example" },
    cost: { text: { input: { price: 0.37, cache: { read: 0.01, write: { "1h": 0.5 } } }, output: { price: 1.025 } } },
  };
  const next = updateAnonRouterModel(row({ context_window: 200_000, max_output_tokens: 8193,
    pricing: { input_usd_per_million_tokens: 0.25, output_usd_per_million_tokens: 1.5, unit_usd: null } }), current);
  expect(next).toMatchObject({ base_model: current.base_model, api: current.api, capabilities: current.capabilities, metadata: current.metadata,
    limit: { context: 163_840, output: 8193 }, cost: { text: { input: { price: 0.25, cache: current.cost.text.input.cache }, output: { price: 1.5 } } } });
  expect(current.limit.context).toBe(163_840);
  expect(current.cost.text.input.price).toBe(0.37);
});

test("plaintext default pricing excludes E2EE routes before route selection", () => {
  const source = row({
    provider_routes: [
      { callable: true, privacy_class: "e2ee", context_window: 64_000, max_output_tokens: 4096,
        pricing: { input_usd_per_million_tokens: 10, output_usd_per_million_tokens: 20, unit_usd: null } },
      { callable: false, privacy_class: "private", context_window: 32_000, max_output_tokens: 4096,
        pricing: { input_usd_per_million_tokens: 0.01, output_usd_per_million_tokens: 0.02, unit_usd: null } },
      { callable: true, privacy_class: "tee", context_window: 128_000, max_output_tokens: 8193,
        pricing: { input_usd_per_million_tokens: 0.5, output_usd_per_million_tokens: 1, unit_usd: null } },
    ],
  });
  expect(updateAnonRouterModel(source, modelFile())).toMatchObject({
    limit: { context: 128_000, output: 8193 }, cost: { text: { input: { price: 0.5 }, output: { price: 1 } } },
  });
  expect(updateAnonRouterModel(row({ provider_routes: [source.provider_routes![0]] }), modelFile())).toEqual(modelFile());
});

test("limits identical to the shared model are inherited instead of duplicated", () => {
  const baseLimit = modelMetadata("deepseek/deepseek-v3").limit as { context: number; output: number };
  const next = updateAnonRouterModel(row({ context_window: baseLimit.context, max_output_tokens: baseLimit.output }), modelFile());
  expect(next.limit).toBeUndefined();
});

test("text limit updates retain reviewed native and lower host caps", () => {
  const current = {
    schema: 2,
    base_model: "deepseek/deepseek-v4.1-flash-1017",
    api: { "chat-completions": {} },
  };
  const source = row({ id: "deepseek/deepseek-v4.1-flash-1017", context_window: 1_048_576, max_output_tokens: 943_718 });
  // The positive native caps are inherited rather than replaced by larger catalog figures.
  expect(updateAnonRouterModel(source, current).limit).toBeUndefined();
  const curated = { ...current, limit: { context: 262_144, output: 32_768 } };
  expect(updateAnonRouterModel(source, curated).limit).toEqual(curated.limit);
  expect(updateAnonRouterModel(row({ ...source, context_window: 16_384 }), curated).limit)
    .toEqual({ context: 16_384, output: 16_384 });
  expect(updateAnonRouterModel(row({ ...source, context_window: 16_384, max_output_tokens: null }), curated).limit)
    .toEqual({ context: 16_384, output: 16_384 });
  // The original provider's explicitly reviewed caps take precedence over the lab's smaller defaults.
  expect(updateAnonRouterModel(row(), modelFile()).limit).toEqual(modelFile().limit);
});

test("null router prices stay unquoted and free prices remain actual zeroes", () => {
  const { cost: _cost, ...current } = modelFile();
  const unquoted = row({ id: "anonrouter/cheap", pricing: { input_usd_per_million_tokens: null, output_usd_per_million_tokens: null, unit_usd: null } });
  expect(updateAnonRouterModel(unquoted, current)).not.toHaveProperty("cost");
  expect(updateAnonRouterModel(unquoted, modelFile())).not.toHaveProperty("cost");
  const free = row({ id: "anonrouter/free", pricing: { input_usd_per_million_tokens: 0, output_usd_per_million_tokens: 0, unit_usd: null } });
  expect(updateAnonRouterModel(free, current)).toMatchObject({ cost: { text: { input: { price: 0 }, output: { price: 0 } } } });
  const router = row({ ...unquoted, provider_routes: [], context_window: 65_536, max_output_tokens: 4096 });
  expect(updateAnonRouterModel(router, modelFile())).toMatchObject({ limit: { context: 65_536, output: 4096 } });
  expect(updateAnonRouterModel(row({ context_window: 4096, max_output_tokens: 8192 }), modelFile()))
    .toMatchObject({ limit: { context: 4096, output: 4096 } });
});

test("image, speech and embedding prices keep their distinct units and API recipes", () => {
  const image = { ...modelFile(), v2_only: true, api: { images: { sdk: { aisdk: "none", opencodeai: "none" } } } };
  const speech = { ...image, api: { speech: { sdk: { aisdk: "none", opencodeai: "none" } } } };
  expect(updateAnonRouterModel(row({ model_type: "image", max_output_tokens: null,
    pricing: { input_usd_per_million_tokens: 0, output_usd_per_million_tokens: 0, unit_usd: 0.0115 } }), image))
    .toMatchObject({ api: image.api, cost: { image: { output: { unit: "image", price: 0.0115 } } } });
  expect(updateAnonRouterModel(row({ model_type: "tts", max_output_tokens: null,
    pricing: { input_usd_per_million_tokens: 0, output_usd_per_million_tokens: 0, unit_usd: 65.5 } }), speech))
    .toMatchObject({ api: speech.api, cost: { text: { input: { unit: "character", price: 65.5 } } } });
  const embedding = { schema: 2, v2_only: true, base_model: "openai/text-embedding-3-small", api: { embeddings: {} } };
  const embedded = updateAnonRouterModel(row({ model_type: "embedding", max_output_tokens: 0,
    pricing: { input_usd_per_million_tokens: 0.026, output_usd_per_million_tokens: 0.026, unit_usd: null } }), embedding);
  expect(embedded).toMatchObject({ cost: { text: { input: { price: 0.026 } } } });
  expect((embedded.cost as { text: object }).text).not.toHaveProperty("output");
  expect(embedded.limit).not.toHaveProperty("output");
});

test("only active whole-request context tiers sync, preserving other price conditions", () => {
  const current = {
    ...modelFile(),
    cost: { text: { input: { price: 1, overrides: [
      { when: { context: { gt: 100_000 } }, price: 2 },
      { when: { region: { equals: "eu" } }, price: 1.1 },
    ] }, output: { price: 2 } } },
  };
  const source = row({ pricing: { input_usd_per_million_tokens: 1, output_usd_per_million_tokens: 2, unit_usd: null,
    long_context_tiers: [
      { above_input_tokens: 100_000, input_usd_per_million_tokens: 2, output_usd_per_million_tokens: 4, applies_to: "whole_request", in_effect: false },
      { above_input_tokens: 200_000, input_usd_per_million_tokens: 3, output_usd_per_million_tokens: 6, cache_read_usd_per_million_tokens: 0.3,
        applies_to: "whole_request", in_effect: true },
    ] } });
  const next = updateAnonRouterModel(source, current) as { cost: { text: { input: { overrides: unknown[] } } } };
  expect(next.cost.text.input.overrides).toEqual([
    { when: { region: { equals: "eu" } }, price: 1.1 },
    { when: { context: { gt: 200_000 } }, price: 3, cache: { read: 0.3 } },
  ]);
});

test("a Latest promotion keeps the reviewed alias definition until its new target is authored", () => {
  const source = parseAnonRouterModels(authenticated([row({ id: "~deepseek/deepseek-flash-latest", canonical_slug: "deepseek/new-model" })]))[0]!;
  const current = modelFile();
  const translated = anonrouter.translateModel(source, { existing: () => undefined, authored: () => undefined,
    v2: (id) => id === source.id ? current : undefined });
  expect(translated!.v2).toBe(current);
  expect(translated!.notices!.join(" ")).toContain("retaining its reviewed definition");
  const tracked = { ...current, metadata: { anonrouter: { alias_target: "deepseek/old-target" } } };
  const sameLab = anonrouter.translateModel(source, { existing: () => undefined, authored: () => undefined,
    v2: () => tracked });
  expect(sameLab!.v2).toEqual(tracked);
  expect(sameLab!.notices!.length).toBe(1);
});

test("normal sync updates an existing card, remains idempotent, and retains missing or unrecognized models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-anonrouter-sync-"));
  const modelsDir = path.join(root, "providers/anonrouter/models");
  const repo = path.join(import.meta.dirname, "../../..");
  await mkdir(path.join(modelsDir, "deepseek"), { recursive: true });
  await mkdir(path.join(root, "models/deepseek"), { recursive: true });
  await copyFile(path.join(repo, "models/deepseek/deepseek-v3.toml"), path.join(root, "models/deepseek/deepseek-v3.toml"));
  await copyFile(path.join(repo, "providers/anonrouter/provider.toml"), path.join(root, "providers/anonrouter/provider.toml"));
  const file = path.join(modelsDir, "deepseek/deepseek-v3.toml");
  const header = "# Reviewed provider API configuration.\n";
  await writeFile(file, header + formatModelV2(modelFile()));
  let data = [row({ pricing: { input_usd_per_million_tokens: 0.25, output_usd_per_million_tokens: 1, unit_usd: null } })];
  const provider = { ...anonrouter, modelsDir, fetchModels: async () => authenticated(data) };
  try {
    const first = await syncProvider(provider, { openIssues: false });
    expect(first).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect((await readFile(file, "utf8")).startsWith(header)).toBe(true);
    expect(await syncProvider(provider, { openIssues: false })).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    const publicProvider = { ...provider, fetchModels: async () => ({ source: "public", payload: {
      models: [{ id: row().id, callable: true, inputPriceUsdPerMillion: 999 }], routers: [], stale: true,
    } }) };
    const reviewed = await readFile(file, "utf8");
    expect(await syncProvider(publicProvider, { openIssues: false })).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(await readFile(file, "utf8")).toBe(reviewed);
    const aliasID = "~deepseek/deepseek-flash-latest";
    await mkdir(path.join(modelsDir, "~deepseek"));
    const aliasFile = path.join(modelsDir, `${aliasID}.toml`);
    await writeFile(aliasFile, formatModelV2({ ...modelFile(), metadata: { anonrouter: { alias_target: "deepseek/old-target" } } }));
    const beforeAlias = await readFile(aliasFile, "utf8");
    data = [row({ id: aliasID, canonical_slug: "deepseek/new-target" })];
    const promoted = await syncProvider(provider, { openIssues: false });
    expect(promoted.notices.join(" ")).toContain("now targets deepseek/new-target");
    expect(await readFile(aliasFile, "utf8")).toBe(beforeAlias);
    const malformed = { ...provider, fetchModels: async () => authenticated([row(), row()]) };
    await expect(syncProvider(malformed, { openIssues: false })).rejects.toThrow("duplicate");
    expect(await readFile(file, "utf8")).toBe(reviewed);
    data = [row({ id: "example/unverified" })];
    const retained = await readFile(file, "utf8");
    const missing = await syncProvider(provider, { openIssues: false });
    expect(missing).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(missing.notices.join(" ")).toContain("example/unverified");
    expect(await readFile(file, "utf8")).toBe(retained);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedding inventory cannot raise a reviewed or shared context cap", () => {
  const current = {
    schema: 2,
    v2_only: true,
    base_model: "nvidia/llama-nemotron-embed-vl-1b-v2",
    api: { embeddings: {} },
  };
  const source = row({ model_type: "embedding", context_window: 32_768, max_output_tokens: 0 });
  expect(updateAnonRouterModel(source, current).limit).toBeUndefined();
  expect(updateAnonRouterModel(source, { ...current, limit: { context: 4096 } }))
    .toMatchObject({ limit: { context: 4096 } });
  expect(updateAnonRouterModel({ ...source, context_window: 8192 }, current))
    .toMatchObject({ limit: { context: 8192 } });
});
