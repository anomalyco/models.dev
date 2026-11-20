import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, syncProviderMatrix } from "../src/sync/index.js";
import {
  fetchNeuralwattModels,
  neuralwatt,
  neuralwattBaseModel,
  NeuralwattResponse,
  reasoningOptions,
  type NeuralwattModel,
} from "../src/sync/providers/neuralwatt.js";

type Overrides = Omit<Partial<NeuralwattModel>, "metadata"> & { metadata?: Partial<NeuralwattModel["metadata"]> };

// Shaped like the public GET https://api.neuralwatt.com/v1/models rows.
function model(overrides: Overrides = {}): NeuralwattModel {
  const { metadata, ...rest } = overrides;
  return {
    id: "glm-5.3",
    object: "model",
    max_model_len: 1_048_560,
    metadata: {
      display_name: "GLM 5.3",
      huggingface_id: "zai-org/GLM-5.3",
      pricing: {
        input_per_million: 1.45,
        output_per_million: 4.5,
        cached_input_per_million: 0.145,
        pricing_tbd: false,
        service_tier: "standard",
      },
      capabilities: { tools: true, json_mode: true, reasoning: true },
      reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"], default_effort: "max" },
      limits: { max_context_length: 1_048_560, max_output_tokens: null },
      deprecated: false,
      ...metadata,
    },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    ...rest,
  } as NeuralwattModel;
}

const noFiles = { existing: () => undefined, authored: () => undefined };

test("Neuralwatt is registered and fetches the public list without credentials", async () => {
  expect(syncProviderMatrix().include.some((entry) => entry.provider === neuralwatt.id)).toBe(true);
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ object: "list", scope: "public", data: [model()] });
  }) as unknown as typeof fetch;
  await fetchNeuralwattModels(fetcher);
  expect(request!.url).toBe("https://api.neuralwatt.com/v1/models");
  expect(request!.headers.get("authorization")).toBeNull();

  const unavailable = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  expect(fetchNeuralwattModels(unavailable)).rejects.toThrow("503");
});

test("empty, duplicate and non-public lists fail before any catalog writes", () => {
  expect(() => NeuralwattResponse.parse({ object: "list", scope: "public", data: [] })).toThrow("empty catalog");
  expect(() => NeuralwattResponse.parse({ object: "list", scope: "public", data: [model(), model()] })).toThrow("duplicate model IDs");
  // An authenticated list can include an account's private grants.
  expect(() => NeuralwattResponse.parse({ object: "list", scope: "customer", data: [model()] })).toThrow();
  expect(() => NeuralwattResponse.parse({ object: "list", data: [model()] })).toThrow();
});

test("huggingface_id resolves to the lab model, through quantized and republished weights", () => {
  expect(neuralwattBaseModel("zai-org/GLM-5.3")).toBe("zhipuai/glm-5.3");
  expect(neuralwattBaseModel("Qwen/Qwen3.8-27B-FP8")).toBe("alibaba/qwen3.8-27b");
  expect(neuralwattBaseModel("nvidia/Gemma-4-31B-IT-NVFP4")).toBe("google/gemma-4-31b-it");
  expect(neuralwattBaseModel("XiaomiMiMo/MiMo-V2.6-Pro-MOPD")).toBe("xiaomi/mimo-v2.6-pro");
  expect(neuralwattBaseModel("baselabs/mammoth-1")).toBe("baseten/mammoth-1");
  expect(neuralwattBaseModel("example/unknown-model")).toBeUndefined();
  expect(neuralwattBaseModel(null)).toBeUndefined();
});

test("reasoning levels sort low to high and keep an authored budget, and are never invented", () => {
  const effort = { type: "effort" as const, values: ["low" as const, "high" as const, "max" as const] };
  expect(reasoningOptions(model().metadata.reasoning, undefined)).toEqual([effort]);
  expect(reasoningOptions(model().metadata.reasoning, { reasoning_options: [{ type: "budget_tokens" }] } as never))
    .toEqual([effort, { type: "budget_tokens" }]);
  expect(reasoningOptions({ mandatory: true, supported_efforts: [] }, undefined)).toEqual([]);
  expect(reasoningOptions({ mandatory: false, supported_efforts: [] }, undefined)).toBeUndefined();
  expect(reasoningOptions({ mandatory: false, supported_efforts: ["future"] }, undefined)).toBeUndefined();
  expect(reasoningOptions(null, undefined)).toBeUndefined();

  const unpublished = model({ metadata: { reasoning: null } });
  expect(neuralwatt.translateModel(unpublished, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(unpublished)).toBe("glm-5.3");
  // An existing file keeps its authored controls rather than being dropped.
  const authored = { reasoning_options: [effort] } as never;
  const kept = neuralwatt.translateModel(unpublished, { existing: () => authored, authored: () => authored });
  expect(kept && "model" in kept ? kept.model?.reasoning_options : null).toBeUndefined();
});

test("unpriced rows are skipped; unknown labs are reported as missing models", () => {
  const tbd = model({ metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } } });
  expect(neuralwatt.translateModel(tbd, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(tbd)).toBeUndefined();

  const unknown = model({ id: "new-model", metadata: { huggingface_id: "example/unknown-model" } });
  expect(neuralwatt.translateModel(unknown, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(unknown)).toBe("new-model");

  const embedding = model({
    id: "new-embedding",
    metadata: { huggingface_id: "example/unknown-embedder", capabilities: { tools: false, json_mode: false, reasoning: false, task: "embed" }, reasoning: null },
    architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
  });
  expect(neuralwatt.translateModel(embedding, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(embedding)).toBeUndefined();
});

test("a decision model becomes a v2-only System One file", () => {
  const mammoth = model({
    id: "mammoth-1",
    max_model_len: 32_753,
    metadata: {
      display_name: "mammoth-1",
      huggingface_id: "baselabs/mammoth-1",
      pricing: { input_per_million: 0.18, output_per_million: 0, cached_input_per_million: 0.018, pricing_tbd: false },
      capabilities: { tools: false, json_mode: false, reasoning: false, task: "decision" },
      reasoning: null,
      limits: { max_context_length: 32_753, max_output_tokens: 0 },
    },
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
  });
  const translated = neuralwatt.translateModel(mammoth, noFiles) as { v2: Record<string, unknown> };
  expect(translated.v2).toEqual({
    schema: 2,
    v2_only: true,
    base_model: "baseten/mammoth-1",
    modalities: { input: ["text"], output: ["decision"] },
    limit: { context: 32_753 },
    api: { systemone: { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/typesafe-ai/decisions" } } },
    cost: { text: { input: { price: 0.18, cache: { read: 0.018 } }, output: { price: 0 } } },
  });
});

test("sync creates, keeps an authored output cap, re-syncs cleanly and removes retired models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-neuralwatt-sync-"));
  const modelsDir = path.join(root, "providers/neuralwatt/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/zhipuai"), { recursive: true });
  const repo = path.join(import.meta.dirname, "../../..");
  await copyFile(path.join(repo, "models/zhipuai/glm-5.3.toml"), path.join(root, "models/zhipuai/glm-5.3.toml"));
  await copyFile(path.join(repo, "providers/neuralwatt/provider.toml"), path.join(root, "providers/neuralwatt/provider.toml"));
  let data = [model()];
  const provider = { ...neuralwatt, modelsDir, fetchModels: async () => ({ object: "list", scope: "public", data }) };
  const file = Bun.file(path.join(modelsDir, "glm-5.3.toml"));
  try {
    expect((await syncProvider(provider, { openIssues: false })).created).toBe(1);
    const created = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(created.base_model).toBe("zhipuai/glm-5.3");
    expect(created.name).toBe("GLM 5.3");
    // default_effort and implicit caching are left to the file's author.
    expect(created.capabilities.reasoning).toEqual({ supported: true, effort: ["low", "high", "max"] });
    expect(created.capabilities.cache).toBeUndefined();
    expect(created.cost.text).toEqual({ input: { price: 1.45, cache: { read: 0.145 } }, output: { price: 4.5 } });
    expect(await file.text()).toContain("# Generated by bun models:sync neuralwatt");
    expect((await syncProvider(provider, { openIssues: false })).unchanged).toBe(1);

    // A hand-set output cap survives while the API publishes none, and an
    // authored reasoning default and cache kind are left as written.
    const authored = (await file.text())
      .replace("context = 1_048_560", "context = 1_048_560\noutput = 65_536")
      .replace("reasoning = { supported = true,", 'reasoning = { supported = true, default = { type = "effort", value = "high" },')
      .replace("[capabilities]", "[capabilities]\ncache = { implicit = true }");
    await Bun.write(file, authored);
    data = [model({ metadata: { pricing: { ...model().metadata.pricing, input_per_million: 1.2 } } })];
    expect((await syncProvider(provider, { openIssues: false })).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.limit).toEqual({ context: 1_048_560, output: 65_536 });
    expect(updated.cost.text.input.price).toBe(1.2);
    expect(updated.capabilities.reasoning.default).toEqual({ type: "effort", value: "high" });
    expect(updated.capabilities.cache).toEqual({ implicit: true });

    data = [model({ metadata: { deprecated: true } })];
    await syncProvider(provider, { openIssues: false });
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).status).toBe("deprecated");

    data = [model({ id: "other", metadata: { huggingface_id: "example/unknown-model" } })];
    expect((await syncProvider(provider, { openIssues: false })).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
