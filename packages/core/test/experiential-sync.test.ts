import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generate } from "../src/generate.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  buildExperientialModel,
  experiential,
  fetchExperientialModels,
  resolveExperientialBaseModel,
  type ExperientialEntry,
} from "../src/sync/providers/experiential.js";

function entry(): ExperientialEntry {
  return {
    model: {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1 Sol",
      status: "active",
      context_window: 128_000,
      max_output_tokens: 8192,
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_params: { tools: true },
      icon: "openai",
    },
    providers: [{
      id: "primary",
      provider: "openai",
      billing_source: "host_managed",
      status: "active",
      routable: true,
      input_nano_usd_per_million: 2_000_000_000,
      cached_input_nano_usd_per_million: 0,
      output_nano_usd_per_million: 10_000_000_000,
      capabilities: {
        supports_tools: true,
        supports_reasoning: true,
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    }],
    default_provider_ids: ["primary"],
  };
}

function catalog(models: ExperientialEntry[], total = models.length, offset = 0) {
  return { models, total, offset, limit: 1000 };
}

const context = { existing: () => undefined, authored: () => undefined };

test("public discovery paginates without credentials and rejects a changing or incomplete inventory", async () => {
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    const model = entry();
    model.model.slug += `-${offset}`;
    return Response.json(catalog([model], 2, offset));
  }) as typeof fetch;
  expect(experiential.parseModels(await fetchExperientialModels(fetcher))).toHaveLength(2);
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.experientiallabs.ai/api/models?limit=1000&offset=0",
    "https://api.experientiallabs.ai/api/models?limit=1000&offset=1",
  ]);
  expect(requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  const empty = (async () => Response.json(catalog([]))) as typeof fetch;
  await expect(fetchExperientialModels(empty)).rejects.toThrow("incomplete page");
  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
  await expect(fetchExperientialModels(unavailable)).rejects.toThrow("503");
  const repeated = (async () => Response.json(catalog([entry()], 2))) as typeof fetch;
  await expect(fetchExperientialModels(repeated)).rejects.toThrow("incomplete page");
  expect(() => experiential.parseModels(catalog([entry(), entry()]))).toThrow("duplicate catalog");
  expect(() => experiential.parseModels(catalog([entry()], 2))).toThrow("incomplete");
});

test("only active default host-managed chat routes can become coding models", () => {
  for (const mutate of [
    (value: ExperientialEntry) => { value.default_provider_ids = []; },
    (value: ExperientialEntry) => { value.providers[0]!.billing_source = "customer_managed"; },
    (value: ExperientialEntry) => { value.providers[0]!.routable = null; },
    (value: ExperientialEntry) => { value.providers[0]!.status = "disabled"; },
    (value: ExperientialEntry) => { value.model.status = "deprecated"; },
    (value: ExperientialEntry) => { value.model.output_modalities = ["image"]; },
    (value: ExperientialEntry) => { value.providers[0]!.capabilities!.supports_tools = false; },
    (value: ExperientialEntry) => { value.providers[0]!.capabilities!.supports_embeddings = true; },
    (value: ExperientialEntry) => { value.providers[0]!.input_nano_usd_per_million = -1; },
  ]) {
    const value = entry();
    mutate(value);
    expect(experiential.translateModel(value, context)).toBeUndefined();
    expect(experiential.missingModelID(value)).toBeUndefined();
  }
});

test("v2 baselines constrain efforts across the default waterfall without borrowing unrelated routes", () => {
  const value = entry();
  value.providers.unshift({ ...value.providers[0]!, id: "unselected", input_nano_usd_per_million: 99_000_000_000 });
  value.providers.push({
    ...value.providers[1]!, id: "fallback",
    capabilities: { supports_tools: true, supported_reasoning_efforts: ["high", "future-effort"] },
  });
  value.default_provider_ids.push("fallback");
  const built = buildExperientialModel(value, undefined)!;
  expect(built.model.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
  expect(built.model.cost).toMatchObject({ input: 2, output: 10, cache_read: 0 });
  expect(built.header).toContain("providers/openai/models/gpt-6.1-sol.toml");
  value.providers[2]!.capabilities!.supported_reasoning_efforts = ["future-effort"];
  expect(buildExperientialModel(value, undefined)).toBeUndefined();
  value.providers[2]!.capabilities!.supported_reasoning_efforts = undefined;
  expect(buildExperientialModel(value, undefined)).toBeUndefined();
});

test("budget and toggle models are held for verified host mappings instead of claiming no controls", () => {
  const value = entry();
  value.model.slug = "qwen3.5-27b";
  value.model.icon = "qwen";
  expect(resolveExperientialBaseModel(value.model.slug, value.model.icon)).toBe("alibaba/qwen3.5-27b");
  expect(buildExperientialModel(value, undefined)).toBeUndefined();
  expect(experiential.missingModelID(value)).toBe("qwen3.5-27b");
  expect(resolveExperientialBaseModel("gpt-6.1-sol-uncensored", "openai")).toBeUndefined();
  expect(resolveExperientialBaseModel("gpt-6.1-sol-24k", "openai")).toBeUndefined();
});

test("verified DeepSeek and uncensored mappings tolerate omitted fallback metadata but honor explicit restrictions", () => {
  const cases = [
    ["deepseek-v4-flash", "deepseek/deepseek-v4-flash", ["none", "low", "high", "max"]],
    ["deepseek-v4-pro", "deepseek/deepseek-v4-pro", ["none", "low", "high", "max"]],
    ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", ["none", "low", "high", "max"]],
    ["deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash-1017", ["none", "low", "high", "max"]],
    ["deepseek-v4.1-flash-uncensored", "dealignai/deepseek-v4.1-flash-1017-uncensored", ["none", "low", "high", "max"]],
    ["glm-5.3-flash-uncensored", "dealignai/glm-5.3-flash-uncensored", ["low", "high", "max"]],
    ["glm-5.3-uncensored", "dealignai/glm-5.3-uncensored", ["low", "high"]],
    ["mimo-v2.6-flash-uncensored", "dealignai/mimo-v2.6-flash-uncensored", ["none", "high"]],
  ] as const;
  for (const [slug, baseModel, efforts] of cases) {
    const value = entry();
    value.model.slug = slug;
    value.model.icon = null;
    value.providers[0]!.capabilities!.supported_reasoning_efforts = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
    value.providers.push({ ...value.providers[0]!, id: "fallback", capabilities: {} });
    value.default_provider_ids.push("fallback");
    expect(resolveExperientialBaseModel(slug)).toBe(baseModel);
    const built = buildExperientialModel(value, undefined)!;
    expect(built.model.base_model).toBe(baseModel);
    expect(built.model.reasoning_options).toEqual([{ type: "effort", values: [...efforts] }]);
    value.providers[1]!.capabilities = { supported_reasoning_efforts: ["high"] };
    expect(buildExperientialModel(value, undefined)!.model.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
    value.providers[1]!.capabilities = { supported_reasoning_efforts: [] };
    expect(buildExperientialModel(value, undefined)).toBeUndefined();
    value.providers[1]!.capabilities = { supports_reasoning: false };
    expect(buildExperientialModel(value, undefined)).toBeUndefined();
    value.providers[1]!.capabilities = {};
    value.providers[0]!.capabilities!.supported_reasoning_efforts = undefined;
    expect(buildExperientialModel(value, undefined)).toBeUndefined();
  }
  // Only identified derivatives can use these mappings; suffix stripping
  // would silently assign a future fine-tune the original model's identity.
  expect(resolveExperientialBaseModel("deepseek-v4-pro-uncensored")).toBeUndefined();
});

test("both Luna models resolve and retain their native effort controls", () => {
  for (const slug of ["gpt-5.6-luna", "gpt-6-luna"]) {
    const value = entry();
    value.model.slug = slug;
    const built = buildExperientialModel(value, undefined)!;
    expect(built.model.base_model).toBe(`openai/${slug}`);
    expect(built.model.reasoning_options).toEqual([{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }]);
  }
});

test("host flags cannot enlarge known model limits or enable unsupported sampling and structured output", () => {
  const value = entry();
  value.model.context_window = 1_048_576;
  value.model.max_output_tokens = 1_048_576;
  value.providers[0]!.capabilities!.supports_temperature = true;
  value.providers[0]!.capabilities!.supports_structured_output = true;
  value.model.slug = "muse-spark-1.1";
  value.model.icon = "meta";
  expect(buildExperientialModel(value, undefined)!.model.limit?.output).not.toBe(1_048_576);
  value.model.slug = "claude-opus-4.7";
  value.model.icon = "anthropic";
  expect(buildExperientialModel(value, undefined)!.model.temperature).not.toBe(true);
  value.model.slug = "gpt-5.4-pro";
  value.model.icon = "openai";
  expect(buildExperientialModel(value, undefined)!.model.structured_output).toBe(false);
  // Lab models may leave an output cap unspecified.
  value.model.slug = "fugu-ultra";
  value.model.icon = "sakana";
  expect(buildExperientialModel(value, undefined)!.model.limit?.output).toBe(1_048_576);
});

test("long-context pricing preserves the inclusive source threshold and zero cache prices", () => {
  const value = entry();
  Object.assign(value.providers[0]!, {
    long_context_threshold_tokens: 272_001,
    long_context_input_nano_usd_per_million: 4_000_000_000,
    long_context_output_nano_usd_per_million: 15_000_000_000,
    long_context_cached_input_nano_usd_per_million: 0,
  });
  expect(buildExperientialModel(value, undefined)!.model.cost?.tiers).toEqual([{
    tier: { type: "context", size: 272_000 },
    input: 4,
    output: 15,
    cache_read: 0,
  }]);
  value.providers[0]!.long_context_threshold_tokens = -1;
  expect(buildExperientialModel(value, undefined)!.model.cost?.tiers).toBeUndefined();
});

test("sync emits v2 models, is idempotent, preserves unresolved live entries, and removes retired models", async () => {
  expect(syncProviderMatrix().include.some((item) => item.provider === experiential.id)).toBe(true);
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-experiential-"));
  const modelsDir = path.join(root, "providers/experiential/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/openai"), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "../../../models/openai/gpt-6.1-sol.toml"), path.join(root, "models/openai/gpt-6.1-sol.toml"));
  await copyFile(path.join(import.meta.dirname, "../../../providers/experiential/provider.toml"), path.join(root, "providers/experiential/provider.toml"));
  let value = entry();
  const provider = { ...experiential, modelsDir, fetchModels: async () => catalog([value]) };
  const file = Bun.file(path.join(modelsDir, "gpt-6.1-sol.toml"));
  try {
    expect((await syncProvider(provider, { openIssues: false })).created).toBe(1);
    expect(Bun.TOML.parse(await file.text()).schema).toBe(2);
    const generated = (await generate(path.join(root, "providers"))).experiential!.models["gpt-6.1-sol"]!;
    expect(generated.limit).toEqual({ context: 128_000, output: 8192 });
    expect(generated.cost).toEqual({ input: 2, output: 10, cache_read: 0 });
    expect((await syncProvider(provider, { openIssues: false }))).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
    const previous = await file.text();
    value.providers[0]!.capabilities!.supported_reasoning_efforts = [];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(0);
    expect(await file.text()).toBe(previous);
    value = entry();
    value.model.status = "deprecated";
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
