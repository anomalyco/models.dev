import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generate } from "../src/generate.js";
import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  buildExperientiallabsModel,
  experientiallabs,
  fetchExperientiallabsModels,
  resolveExperientiallabsBaseModel,
  type ExperientialEntry,
} from "../src/sync/providers/experientiallabs.js";

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
  expect(experientiallabs.parseModels(await fetchExperientiallabsModels(fetcher))).toHaveLength(2);
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.experientiallabs.ai/api/models?limit=1000&offset=0",
    "https://api.experientiallabs.ai/api/models?limit=1000&offset=1",
  ]);
  expect(requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  const empty = (async () => Response.json(catalog([]))) as typeof fetch;
  await expect(fetchExperientiallabsModels(empty)).rejects.toThrow("incomplete page");
  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
  await expect(fetchExperientiallabsModels(unavailable)).rejects.toThrow("503");
  const repeated = (async () => Response.json(catalog([entry()], 2))) as typeof fetch;
  await expect(fetchExperientiallabsModels(repeated)).rejects.toThrow("incomplete page");
  expect(() => experientiallabs.parseModels(catalog([entry(), entry()]))).toThrow("duplicate catalog");
  expect(() => experientiallabs.parseModels(catalog([entry()], 2))).toThrow("incomplete");
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
    expect(experientiallabs.translateModel(value, context)).toBeUndefined();
    expect(experientiallabs.missingModelID(value)).toBeUndefined();
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
  const built = buildExperientiallabsModel(value, undefined)!;
  expect(built.model.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
  expect(built.model.cost).toMatchObject({ input: 2, output: 10, cache_read: 0 });
  expect(built.header).toContain("providers/openai/models/gpt-6.1-sol.toml");
  value.providers[2]!.capabilities!.supported_reasoning_efforts = ["future-effort"];
  expect(buildExperientiallabsModel(value, undefined)).toBeUndefined();
  value.providers[2]!.capabilities!.supported_reasoning_efforts = undefined;
  expect(buildExperientiallabsModel(value, undefined)).toBeUndefined();
});

test("budget and toggle models are held for verified host mappings instead of claiming no controls", () => {
  const value = entry();
  value.model.slug = "qwen3.5-27b";
  value.model.icon = "qwen";
  expect(resolveExperientiallabsBaseModel(value.model.slug, value.model.icon)).toBe("alibaba/qwen3.5-27b");
  expect(buildExperientiallabsModel(value, undefined)).toBeUndefined();
  expect(experientiallabs.missingModelID(value)).toBe("qwen3.5-27b");
  expect(resolveExperientiallabsBaseModel("gpt-6.1-sol-uncensored", "openai")).toBeUndefined();
  expect(resolveExperientiallabsBaseModel("gpt-6.1-sol-24k", "openai")).toBeUndefined();
});

test("long-context pricing preserves the inclusive source threshold and zero cache prices", () => {
  const value = entry();
  Object.assign(value.providers[0]!, {
    long_context_threshold_tokens: 272_001,
    long_context_input_nano_usd_per_million: 4_000_000_000,
    long_context_output_nano_usd_per_million: 15_000_000_000,
    long_context_cached_input_nano_usd_per_million: 0,
  });
  expect(buildExperientiallabsModel(value, undefined)!.model.cost?.tiers).toEqual([{
    tier: { type: "context", size: 272_000 },
    input: 4,
    output: 15,
    cache_read: 0,
  }]);
  value.providers[0]!.long_context_threshold_tokens = -1;
  expect(buildExperientiallabsModel(value, undefined)!.model.cost?.tiers).toBeUndefined();
});

test("sync emits v2 models, is idempotent, preserves unresolved live entries, and removes retired models", async () => {
  expect(syncProviderMatrix().include.some((item) => item.provider === experientiallabs.id)).toBe(true);
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-experiential-"));
  const modelsDir = path.join(root, "providers/experientiallabs/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/openai"), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "../../../models/openai/gpt-6.1-sol.toml"), path.join(root, "models/openai/gpt-6.1-sol.toml"));
  await copyFile(path.join(import.meta.dirname, "../../../providers/experientiallabs/provider.toml"), path.join(root, "providers/experientiallabs/provider.toml"));
  let value = entry();
  const provider = { ...experientiallabs, modelsDir, fetchModels: async () => catalog([value]) };
  const file = Bun.file(path.join(modelsDir, "gpt-6.1-sol.toml"));
  try {
    expect((await syncProvider(provider, { openIssues: false })).created).toBe(1);
    expect(Bun.TOML.parse(await file.text()).schema).toBe(2);
    const generated = (await generate(path.join(root, "providers"))).experientiallabs!.models["gpt-6.1-sol"]!;
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
