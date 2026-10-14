import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExistingModel } from "../src/sync/index.js";
import { providers, groups, syncProvider } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildGradiatedModel,
  fetchGradiatedModels,
  gradiated,
  GradiatedResponse,
  type GradiatedModel,
} from "../src/sync/providers/gradiated.js";

function model(overrides: Partial<GradiatedModel> = {}): GradiatedModel {
  return {
    id: "deepseek/deepseek-v4.1-flash",
    status: "available",
    properties: {
      schema_version: 1,
      input_modalities: [{
        type: "text",
        supported_inputs: {
          max_context_length: { value: 1_048_576, unit: "token" },
          max_prompt_length: { value: 1_048_576, unit: "token" },
        },
        pricing: [
          { type: "prompt", unit: "token", cost: 300 },
          { type: "cached_prompt", unit: "token", cost: 6 },
        ],
      }],
      output_modalities: [{
        type: "text",
        max_length: { value: 131_072, unit: "token" },
        supported_parameters: { temperature: { type: "range", min: 0, max: 2 }, tools: { type: "unknown" } },
        pricing: [
          { type: "completion", unit: "token", cost: 1200 },
          { type: "internal_reasoning", unit: "token", cost: 1200 },
        ],
      }],
    },
    ...overrides,
  };
}

const authored: ExistingModel = {
  base_model: "deepseek/deepseek-v4.1-flash",
  reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh", "max"] }],
  interleaved: { field: "reasoning_content" },
};

function context(existing: ExistingModel | null = { ...authored, reasoning: true }) {
  return { existing: () => existing ?? undefined, authored: () => existing ?? undefined };
}

test("registers Gradiated with the direct sync group and scheduled provider registry", () => {
  expect(providers.gradiated).toBe(gradiated);
  expect(groups.direct).toContain("gradiated");
});

test("converts nano-USD pricing and publishes only serving overrides", () => {
  const result = buildGradiatedModel(model(), authored.base_model!, authored);
  expect(result.base_model).toBe(authored.base_model);
  expect(result.cost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.006, reasoning: 1.2 });
  expect(result.limit).toEqual({ context: 1_048_576, input: 1_048_576, output: 131_072 });
  expect(result.modalities).toEqual({ input: ["text"] });
  expect(result.attachment).toBe(false);
  expect(result.structured_output).toBe(false);
  expect(result.reasoning_options).toEqual(authored.reasoning_options);
  expect(result.interleaved).toEqual(authored.interleaved);
  expect(result).not.toHaveProperty("name");
  expect(result).not.toHaveProperty("release_date");
  expect(result).not.toHaveProperty("temperature");
  expect(result).not.toHaveProperty("tool_call");
});

test("resolves the Z.AI namespace without copying lab metadata", () => {
  const glm = model({ id: "z-ai/glm-5.3-flash" });
  const result = gradiated.translateModel(glm, context({ reasoning: true, reasoning_options: authored.reasoning_options }));
  expect(result?.model.base_model).toBe("zhipuai/glm-5.3-flash");
});

test("skips unavailable training models and the separate decision API", () => {
  for (const item of [model({ status: "unavailable" }), model({ id: "jaredpalmer/kev-9b" })]) {
    expect(gradiated.translateModel(item, context())).toBeUndefined();
    expect(gradiated.sourceID(item)).toBeUndefined();
    expect(gradiated.missingModelID(item)).toBeUndefined();
  }
});

test("reports unknown lab models instead of creating inline third-party metadata", () => {
  const item = model({ id: "unknown/new-checkpoint" });
  expect(gradiated.translateModel(item, context(null))).toBeUndefined();
  expect(gradiated.missingModelID(item)).toBe(item.id);
});

test("requires authored reasoning controls for new reasoning routes", () => {
  expect(() => gradiated.translateModel(model(), { existing: () => undefined, authored: () => undefined }))
    .toThrow(MissingReasoningOptionsError);
});

test("does not retain stale optional prices, tiers, or capabilities", () => {
  const item = model();
  item.properties.output_modalities[0]!.pricing = [{ type: "completion", unit: "token", cost: 0 }];
  item.properties.input_modalities[0]!.pricing = [{ type: "prompt", unit: "token", cost: 0 }];
  item.properties.output_modalities[0]!.supported_parameters = {};
  const result = buildGradiatedModel(item, authored.base_model!, {
    ...authored,
    cost: { input: 10, output: 10, cache_read: 5, cache_write: 5, reasoning: 10 },
  });
  expect(result.cost).toEqual({ input: 0, output: 0 });
  expect(result.temperature).toBe(false);
  expect(result.tool_call).toBe(false);
});

test("converts long-context tiers and inherits unspecified base prices", () => {
  const item = model();
  item.properties.pricing_overrides = [{
    min_prompt_tokens: 200_000,
    input_pricing: [{ type: "prompt", unit: "token", cost: 600 }],
    output_pricing: [],
  }];
  const result = buildGradiatedModel(item, authored.base_model!, authored);
  expect(result.cost?.tiers).toEqual([{
    tier: { type: "context", size: 200_000 },
    input: 0.6,
    output: 1.2,
    cache_read: 0.006,
    reasoning: 1.2,
  }]);
});

test("rejects malformed catalog data and missing required prices", () => {
  const item = model();
  item.properties.input_modalities[0]!.pricing[0]!.cost = -1;
  expect(() => GradiatedResponse.parse({ data: [item], next_cursor: null })).toThrow();
  item.properties.input_modalities[0]!.pricing = [];
  expect(() => buildGradiatedModel(item, authored.base_model!, authored)).toThrow("missing prompt pricing");
});

test("fetches every page from the public endpoint without authentication", async () => {
  const requests: URL[] = [];
  const fetcher = (async (url: URL, options: RequestInit) => {
    requests.push(url);
    expect(options.headers).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return Response.json({
      data: [model({ id: requests.length === 1 ? "z-ai/glm-5.3-flash" : model().id })],
      next_cursor: requests.length === 1 ? "next page" : null,
    });
  }) as typeof fetch;
  const result = await fetchGradiatedModels(fetcher);
  expect(result.data).toHaveLength(2);
  expect(requests[0]!.href).toBe("https://api.gradiated.com/api/v1/models");
  expect(requests[1]!.searchParams.get("cursor")).toBe("next page");
});

test("fails closed on HTTP errors, empty catalogs, and nonterminating pagination", async () => {
  await expect(fetchGradiatedModels((async () => new Response(null, { status: 503 })) as typeof fetch))
    .rejects.toThrow("503");
  await expect(fetchGradiatedModels((async () => Response.json({ data: [], next_cursor: null })) as typeof fetch))
    .rejects.toThrow("no available chat models");
  await expect(fetchGradiatedModels((async () => Response.json({
    data: [model()], next_cursor: "same",
  })) as typeof fetch)).rejects.toThrow("pagination did not terminate");
});

test("fails closed when a later page fails or the catalog repeats a model", async () => {
  let calls = 0;
  await expect(fetchGradiatedModels((async () => ++calls === 1
    ? Response.json({ data: [model()], next_cursor: "next" })
    : new Response(null, { status: 502 })) as typeof fetch)).rejects.toThrow("502");
  await expect(fetchGradiatedModels((async () => Response.json({
    data: [model(), model()], next_cursor: null,
  })) as typeof fetch)).rejects.toThrow("duplicate model IDs");
});

test("sync updates prices, preserves controls, removes retired routes, and is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-gradiated-"));
  const modelsDir = path.join(dir, "providers", "gradiated", "models");
  const file = path.join(modelsDir, "deepseek", "deepseek-v4.1-flash.toml");
  const metadata = path.join(dir, "models", "deepseek", "deepseek-v4.1-flash.toml");
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(metadata), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "../../../models/deepseek/deepseek-v4.1-flash.toml"), metadata);
  const source = path.join(import.meta.dirname, "../../../providers/gradiated/models/deepseek/deepseek-v4.1-flash.toml");
  await Bun.write(file, await Bun.file(source).text());
  const item = model();
  item.properties.input_modalities[0]!.pricing[0]!.cost = 400;
  const provider = {
    ...gradiated,
    modelsDir,
    async fetchModels() { return { data: [item], next_cursor: null }; },
  };

  try {
    expect(await syncProvider(provider)).toMatchObject({ updated: 1, deleted: 0 });
    const written = Bun.TOML.parse(await Bun.file(file).text()) as ExistingModel;
    expect(written.cost?.input).toBe(0.4);
    expect(written.base_model).toBe(authored.base_model);
    expect(written.reasoning_options).toEqual(authored.reasoning_options);
    expect(written.interleaved).toEqual(authored.interleaved);
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, deleted: 0, unchanged: 1 });
    const content = await Bun.file(file).text();
    await expect(syncProvider({
      ...provider,
      async fetchModels() { throw new Error("catalog unavailable"); },
    })).rejects.toThrow("catalog unavailable");
    expect(await Bun.file(file).text()).toBe(content);
    item.status = "unavailable";
    expect(await syncProvider(provider)).toMatchObject({ deleted: 1 });
    expect(await Bun.file(file).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
