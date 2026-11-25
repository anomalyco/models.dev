import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildTogetherModel,
  fetchTogether,
  parseScheduledDeprecations,
  parseServerlessChatTable,
  parseTogether,
  resolveTogetherBaseModel,
  togetherai,
  type TogetherModel,
  type TogetherSource,
} from "../src/sync/providers/togetherai.js";

const CHAT_IDS = [
  "Qwen/Qwen3.5-9B",
  "zai-org/GLM-5.3",
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "moonshotai/Kimi-K3",
  "openai/gpt-oss-120b",
  "tencent/Hy4",
  "reflection/Beam-1.0-501B-A23B",
  "meta-models/Muse-Glimmer-30B",
  "MiniMaxAI/MiniMax-M3.1-Flash",
  "thinkingmachines/Inkling-2-Small",
];

function serverlessDoc(ids = CHAT_IDS, extra = "") {
  return [
    "# Available models",
    "",
    "## Chat models",
    "",
    "| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Cached input pricing (per 1M tokens) | Output pricing (per 1M tokens) | Quantization | Function calling | Structured outputs |",
    "| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |",
    ...ids.map((id) => `| Org | Name | ${id} | 262144 | \\$0.17 | - | \\$0.25 | FP8 | Yes | Yes |`),
    extra,
    "",
    "### Chat model examples",
    "",
    "## Vision models",
    "",
    "| Organization | Model name | API model string | Context length |",
    "| :- | :- | :- | :- |",
    "| Org | Vision only | vision/only-in-vision-table | 1 |",
  ].join("\n");
}

function deprecationsDoc(rows: string[] = ["| 2026-11-06 | `thinkingmachines/Inkling` | `meta-models/Muse-Spark-Open-816B-A42B` | Yes |"]) {
  return [
    "## Scheduled deprecations",
    "",
    "| Removal date | Model | Recommended replacement | Supported by on-demand dedicated endpoints |",
    "| :- | :- | :- | :- |",
    ...rows,
    "",
    "## Deprecation history",
    "",
    "| Removal date | Model | Supported by on-demand dedicated endpoints |",
    "| :- | :- | :- |",
    "| 2026-07-10 | `zai-org/GLM-5.1` | Yes |",
  ].join("\n");
}

function apiModel(overrides: Partial<TogetherModel> = {}): TogetherModel {
  return {
    id: "Qwen/Qwen3.5-9B",
    type: "chat",
    context_length: 262_144,
    pricing: { input: 0.17, output: 0.25 },
    ...overrides,
  };
}

function source(overrides: Partial<TogetherSource> = {}): TogetherSource {
  return {
    id: "Qwen/Qwen3.5-9B",
    api: apiModel(),
    serverless: { toolCalling: true, structuredOutput: true },
    deprecated: false,
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Qwen3.5 9B",
    description: "Test model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    open_weights: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    structured_output: true,
    cost: { input: 0.1, output: 0.1 },
    limit: { context: 131_072, output: 32_768 },
    modalities: { input: ["text", "image"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

function context(entries: Record<string, ExistingModel>, v2: Record<string, Record<string, unknown>> = {}) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id], v2: (id: string) => v2[id] };
}

test("reads the serverless chat table, its tool and structured output columns, and nothing from other tables", () => {
  const rows = parseServerlessChatTable(serverlessDoc(CHAT_IDS, "| Together AI | Tev1 | together/Tev1-4B-experimental | 32768 | \\$0.042 | - | Free | - | - | - |"));
  expect(rows.size).toBe(CHAT_IDS.length + 1);
  expect(rows.get("Qwen/Qwen3.5-9B")).toEqual({ toolCalling: true, structuredOutput: true });
  expect(rows.get("together/Tev1-4B-experimental")).toEqual({ toolCalling: false, structuredOutput: false });
  expect(rows.has("vision/only-in-vision-table")).toBe(false);
});

test("refuses a serverless page without the chat table or with too few rows", () => {
  expect(() => parseServerlessChatTable("# Available models\n\nNothing here")).toThrow("no chat table");
  expect(() => parseServerlessChatTable(serverlessDoc(CHAT_IDS.slice(0, 3)))).toThrow("only 3 models");
  expect(() => parseServerlessChatTable(serverlessDoc([...CHAT_IDS, CHAT_IDS[0]!]))).toThrow("listed twice");
});

test("reads scheduled deprecations, not the deprecation history", () => {
  expect([...parseScheduledDeprecations(deprecationsDoc())]).toEqual(["thinkingmachines/Inkling"]);
  expect(parseScheduledDeprecations(deprecationsDoc([])).size).toBe(0);
  expect(() => parseScheduledDeprecations("## Deprecation history\n")).toThrow("no scheduled deprecations table");
});

test("keeps chat rows, marks serverless and deprecated ones, and adds serverless models the API omits", () => {
  const sources = parseTogether({
    models: [
      apiModel(),
      apiModel({ id: "zai-org/GLM-5.1", pricing: { input: 1.4, output: 4.4 } }),
      apiModel({ id: "thinkingmachines/Inkling" }),
      apiModel({ id: "black-forest-labs/FLUX.2-dev", type: "image" }),
    ],
    serverless: serverlessDoc(),
    deprecations: deprecationsDoc(),
  });
  const byID = new Map(sources.map((item) => [item.id, item]));
  expect(byID.get("Qwen/Qwen3.5-9B")).toMatchObject({ serverless: { toolCalling: true }, deprecated: false });
  expect(byID.get("zai-org/GLM-5.1")).toMatchObject({ serverless: undefined, deprecated: false });
  expect(byID.get("thinkingmachines/Inkling")).toMatchObject({ serverless: undefined, deprecated: true });
  expect(byID.has("black-forest-labs/FLUX.2-dev")).toBe(false);
  expect(byID.get("zai-org/GLM-5.3")).toMatchObject({ serverless: { structuredOutput: true } });
  expect(byID.get("zai-org/GLM-5.3")?.api).toBeUndefined();
});

test("refuses an empty or duplicated /v1/models list", () => {
  const docs = { serverless: serverlessDoc(), deprecations: deprecationsDoc() };
  expect(() => parseTogether({ models: [], ...docs })).toThrow("returned no models");
  expect(() => parseTogether({ models: [apiModel(), apiModel()], ...docs })).toThrow("twice");
});

test("takes prices, the cached-input price and the context window from the API and keeps the rest", () => {
  const built = buildTogetherModel(
    source({ api: apiModel({ context_length: 1_048_575, pricing: { input: 1.4, output: 4.4, cached_input: 0.25999999999999995 } }) }),
    authored({ cost: { input: 1, output: 3, cache_write: 0.5 } }),
  );
  expect(built).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
    structured_output: true,
    cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0.5 },
    limit: { context: 1_048_575, output: 32_768 },
  });
});

test("drops a cached-input price the API no longer lists and keeps the context when the API gives none", () => {
  const built = buildTogetherModel(
    source({ api: apiModel({ context_length: 0 }) }),
    authored({ cost: { input: 0.17, output: 0.25, cache_read: 0.1 } }),
  );
  expect(built.cost).toMatchObject({ input: 0.17, output: 0.25, cache_read: undefined });
  expect(built.limit).toMatchObject({ context: 131_072 });
});

test("sets deprecated from the scheduled deprecations table and clears it once the model leaves it", () => {
  expect(buildTogetherModel(source({ deprecated: true }), authored())).toMatchObject({ status: "deprecated" });
  expect(buildTogetherModel(source(), authored({ status: "deprecated" })).status).toBeUndefined();
  expect(buildTogetherModel(source(), authored({ status: "beta" })).status).toBe("beta");
});

test("drops models that left the serverless table unless Together has scheduled their removal", () => {
  const files = { "Qwen/Qwen3.5-9B": authored() };
  expect(togetherai.translateModel(source({ serverless: undefined }), context(files))).toBeUndefined();
  expect(togetherai.translateModel(source({ id: "x/y", serverless: undefined }), context({}))).toBeUndefined();
  expect(togetherai.sourceID(source({ serverless: undefined }))).toBeUndefined();

  const kept = togetherai.translateModel(source({ serverless: undefined, deprecated: true }), context(files));
  expect(kept && "model" in kept ? kept.model : undefined).toMatchObject({ status: "deprecated" });
});

test("keeps a file as is when the docs list it but /v1/models doesn't", () => {
  const v2 = { schema: 2, base_model: "alibaba/qwen3.5-9b" };
  expect(togetherai.translateModel(source({ api: undefined }), context({ "Qwen/Qwen3.5-9B": authored() }, { "Qwen/Qwen3.5-9B": v2 })))
    .toEqual({ id: "Qwen/Qwen3.5-9B", v2 });
});

test("adds implicit caching and prompt_cache_key for a cached-input price only when the file has no cache", () => {
  const cached = source({ api: apiModel({ pricing: { input: 1, output: 2, cached_input: 0.1 } }) });
  const files = { "Qwen/Qwen3.5-9B": authored() };
  const none = togetherai.translateModel(cached, context(files, { "Qwen/Qwen3.5-9B": { capabilities: {} } }));
  expect(none && "v2Set" in none ? none.v2Set : undefined).toEqual({ "capabilities.cache": { implicit: true }, "capabilities.prompt_cache_key": true });
  const kept = togetherai.translateModel(cached, context(files, { "Qwen/Qwen3.5-9B": { capabilities: { cache: { implicit: true } } } }));
  expect(kept && "v2Set" in kept ? kept.v2Set : "unset").toBeUndefined();
});

test("creates a non-reasoning model from its lab file with the docs' columns", () => {
  const created = togetherai.translateModel(
    source({
      id: "meta-llama/Llama-3.3-70B-Instruct",
      api: apiModel({ id: "meta-llama/Llama-3.3-70B-Instruct", context_length: 131_072, pricing: { input: 0.88, output: 0.88, cached_input: 0.1 } }),
      serverless: { toolCalling: false, structuredOutput: true },
    }),
    context({}),
  );
  expect(created && "model" in created ? created.model : undefined).toMatchObject({
    base_model: "meta/llama-3.3-70b-instruct",
    tool_call: false,
    structured_output: true,
    cost: { input: 0.88, output: 0.88, cache_read: 0.1 },
  });
});

test("doesn't create a reasoning model without host controls, or a model without a lab file", () => {
  expect(() => togetherai.translateModel(
    source({ id: "zai-org/GLM-5.3", api: apiModel({ id: "zai-org/GLM-5.3" }) }),
    context({}),
  )).toThrow(MissingReasoningOptionsError);

  const unknown = source({ id: "acme/Unknown-1B", api: apiModel({ id: "acme/Unknown-1B" }) });
  expect(togetherai.translateModel(unknown, context({}))).toBeUndefined();
  expect(togetherai.missingModelID?.(unknown)).toBe("acme/Unknown-1B");
});

test("maps Together IDs to lab files", () => {
  expect(resolveTogetherBaseModel("Qwen/Qwen3.5-9B")).toBe("alibaba/qwen3.5-9b");
  expect(resolveTogetherBaseModel("zai-org/GLM-5.3")).toBe("zhipuai/glm-5.3");
  expect(resolveTogetherBaseModel("deepseek-ai/DeepSeek-V4.1-Flash-1017-fast")).toBe("deepseek/deepseek-v4.1-flash-1017");
  expect(resolveTogetherBaseModel("MiniMaxAI/MiniMax-M3.1-Flash")).toBe("minimax/MiniMax-M3.1-Flash");
  expect(resolveTogetherBaseModel("acme/Unknown-1B")).toBeUndefined();
});

test("requires an API key and sends it only to /v1/models", async () => {
  const seen: Array<{ url: string; auth?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (url.includes("serverless-models")) return new Response(serverlessDoc());
    if (url.includes("deprecations")) return new Response(deprecationsDoc());
    return Response.json([apiModel()]);
  }) as typeof fetch;
  await expect(fetchTogether(undefined, fetcher)).rejects.toThrow("TOGETHER_API_KEY");
  const raw = await fetchTogether("test-key", fetcher);
  expect(parseTogether(raw).map((item) => item.id)).toContain("Qwen/Qwen3.5-9B");
  expect(seen.find((item) => item.url.endsWith("/v1/models"))?.auth).toBe("Bearer test-key");
  expect(seen.filter((item) => item.auth !== undefined)).toHaveLength(1);
});

test("patches a real file's prices and keeps its header, MIME types and controls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-togetherai-"));
  // The runner reads lab files from <root>/models, three levels above the provider's models directory.
  const dir = path.join(root, "providers", "togetherai", "models");
  try {
    await mkdir(dir, { recursive: true });
    await symlink(path.resolve("models"), path.join(root, "models"));
    await cp("providers/togetherai/models/Qwen/Qwen3.5-9B.toml", path.join(dir, "Qwen", "Qwen3.5-9B.toml"), { recursive: true });
    await writeFile(path.join(dir, "Qwen", "Stale.toml"), 'schema = 2\nbase_model = "alibaba/qwen3.5-9b"\n\n[capabilities]\nreasoning = { supported = true, toggle = true }\n\n[cost.text.input]\nprice = 1\n\n[cost.text.output]\nprice = 1\n');
    const before = await readFile(path.join(dir, "Qwen", "Qwen3.5-9B.toml"), "utf8");
    const raw = {
      models: [apiModel({ pricing: { input: 0.2, output: 0.3 } }), apiModel({ id: "Qwen/Stale" })],
      serverless: serverlessDoc(),
      deprecations: deprecationsDoc(),
    };
    const run = (dryRun = false) => syncProvider({ ...togetherai, modelsDir: dir, async fetchModels() { return raw; } }, { dryRun });

    const result = await run();
    expect(result.notices.filter((notice) => notice.includes("Could not write"))).toEqual([]);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
    const after = await readFile(path.join(dir, "Qwen", "Qwen3.5-9B.toml"), "utf8");
    expect(after.split("schema = 2")[0]).toBe(before.split("schema = 2")[0]);
    const written = Bun.TOML.parse(after) as any;
    expect(written.modalities.input).toEqual(["text", "image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"]);
    expect(written.capabilities.reasoning).toEqual({ supported: true, toggle: true });
    expect(written.cost.text.input.price).toBe(0.2);
    expect(written.cost.text.output.price).toBe(0.3);

    expect((await run(true)).updated).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
