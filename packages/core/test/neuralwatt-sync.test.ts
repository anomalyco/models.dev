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

const qwenRow = (overrides: Overrides = {}) => model({
  id: "qwen-new",
  max_model_len: 262_128,
  ...overrides,
  metadata: {
    display_name: "Qwen3.8 27B",
    huggingface_id: "Qwen/Qwen3.8-27B-FP8",
    reasoning: { mandatory: false, supported_efforts: ["none", "low"], default_effort: "low" },
    limits: { max_context_length: 262_128, max_output_tokens: null },
    ...overrides.metadata,
  },
  architecture: overrides.architecture ?? { input_modalities: ["text", "image"], output_modalities: ["text"] },
});

const mammothRow = (overrides: Overrides = {}) => model({
  id: "mammoth-1",
  max_model_len: 32_753,
  ...overrides,
  metadata: {
    display_name: "mammoth-1",
    huggingface_id: "baselabs/mammoth-1",
    pricing: { input_per_million: 0.18, output_per_million: 0, cached_input_per_million: 0.018, pricing_tbd: false },
    capabilities: { tools: false, json_mode: false, reasoning: false, task: "decision" },
    reasoning: null,
    limits: { max_context_length: 32_753, max_output_tokens: 0 },
    ...overrides.metadata,
  },
  architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
});

// Embedding rows the sync skips quietly, to bring a test list above the truncation floor.
const filler = Array.from({ length: 20 }, (_, index) => model({
  id: `embed-${index}`,
  metadata: { huggingface_id: null, capabilities: { tools: false, json_mode: false, reasoning: false, task: "embed" }, reasoning: null },
  architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
}));

async function syncFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-neuralwatt-sync-"));
  const modelsDir = path.join(root, "providers/neuralwatt/models");
  await mkdir(modelsDir, { recursive: true });
  const repo = path.join(import.meta.dirname, "../../..");
  for (const lab of ["zhipuai/glm-5.3", "alibaba/qwen3.8-27b", "baseten/mammoth-1"]) {
    await mkdir(path.join(root, "models", path.dirname(lab)), { recursive: true });
    await copyFile(path.join(repo, `models/${lab}.toml`), path.join(root, `models/${lab}.toml`));
  }
  await copyFile(path.join(repo, "providers/neuralwatt/provider.toml"), path.join(root, "providers/neuralwatt/provider.toml"));
  const state = { data: [model()], padded: true };
  const provider = {
    ...neuralwatt,
    modelsDir,
    fetchModels: async () => ({ object: "list", scope: "public", data: state.padded ? [...state.data, ...filler] : state.data }),
  };
  return {
    state,
    sync: () => syncProvider(provider, { openIssues: false }),
    file: (id: string) => Bun.file(path.join(modelsDir, `${id}.toml`)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

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

test("short, duplicate and non-public lists fail before any catalog writes", () => {
  expect(() => neuralwatt.parseModels({ object: "list", scope: "public", data: [] })).toThrow("below the 20");
  expect(() => neuralwatt.parseModels({ object: "list", scope: "public", data: filler.slice(0, 19) })).toThrow("below the 20");
  expect(neuralwatt.parseModels({ object: "list", scope: "public", data: filler })).toHaveLength(20);
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

test("unpriced rows keep an existing file, and unknown labs are reported as missing models", () => {
  const tbd = model({ metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } } });
  expect(neuralwatt.translateModel(tbd, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(tbd)).toBeUndefined();
  const file = { base_model: "zhipuai/glm-5.3", cost: { input: 1.45, output: 4.5 } } as never;
  expect(neuralwatt.translateModel(tbd, { existing: () => file, authored: () => file })).toEqual({ id: "glm-5.3", model: file });

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

  // An alias pointed at a checkpoint with no lab file keeps the old file and
  // is reported, instead of pairing the new price with the old lab.
  const authored = { base_model: "alibaba/qwen3.8-27b" } as never;
  const withFile = { existing: () => authored, authored: () => authored };
  const retargeted = model({ id: "nw-small", metadata: { huggingface_id: "example/unknown-model" } });
  expect(neuralwatt.translateModel(retargeted, withFile)).toBeUndefined();
  expect(neuralwatt.missingModelID(retargeted)).toBe("nw-small");
  // A row that names no checkpoint keeps the file's base_model.
  const unnamed = model({ id: "nw-small", metadata: { huggingface_id: null } });
  const translated = neuralwatt.translateModel(unnamed, withFile);
  expect(translated && "model" in translated ? translated.model.base_model : undefined).toBe("alibaba/qwen3.8-27b");
  expect(neuralwatt.translateModel(unnamed, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(unnamed)).toBe("nw-small");

  // A decision row whose lab file isn't a decision model is reported.
  const misfiled = mammothRow({ id: "decider", metadata: { huggingface_id: "zai-org/GLM-5.3" } });
  expect(neuralwatt.translateModel(misfiled, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(misfiled)).toBe("decider");
});

test("a decision model becomes a v2-only System One file", () => {
  const translated = neuralwatt.translateModel(mammothRow(), noFiles) as { v2: Record<string, unknown> };
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
  const fixture = await syncFixture();
  const file = fixture.file("glm-5.3");
  try {
    expect((await fixture.sync()).created).toBe(1);
    const created = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(created.base_model).toBe("zhipuai/glm-5.3");
    expect(created.name).toBe("GLM 5.3");
    // default_effort and implicit caching are left to the file's author.
    expect(created.capabilities.reasoning).toEqual({ supported: true, effort: ["low", "high", "max"] });
    expect(created.capabilities.cache).toBeUndefined();
    expect(created.cost.text).toEqual({ input: { price: 1.45, cache: { read: 0.145 } }, output: { price: 4.5 } });
    expect(await file.text()).toContain("# Generated by bun models:sync neuralwatt");
    expect((await fixture.sync()).unchanged).toBe(1);

    // A hand-set output cap survives while the API publishes none, and an
    // authored reasoning default and cache kind are left as written.
    const authored = (await file.text())
      .replace("context = 1_048_560", "context = 1_048_560\noutput = 65_536")
      .replace("reasoning = { supported = true,", 'reasoning = { supported = true, default = { type = "effort", value = "high" },')
      .replace("[capabilities]", "[capabilities]\ncache = { implicit = true }");
    await Bun.write(file, authored);
    fixture.state.data = [model({ metadata: { pricing: { ...model().metadata.pricing, input_per_million: 1.2 } } })];
    expect((await fixture.sync()).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.limit).toEqual({ context: 1_048_560, output: 65_536 });
    expect(updated.cost.text.input.price).toBe(1.2);
    expect(updated.capabilities.reasoning.default).toEqual({ type: "effort", value: "high" });
    expect(updated.capabilities.cache).toEqual({ implicit: true });

    fixture.state.data = [model({ metadata: { deprecated: true } })];
    await fixture.sync();
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).status).toBe("deprecated");

    fixture.state.data = [model({ id: "other", metadata: { huggingface_id: "example/unknown-model" } })];
    expect((await fixture.sync()).deleted).toBe(1);
    expect(await file.exists()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("a listed row the sync can't translate keeps its file, and a truncated list deletes nothing", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("glm-5.3");
  try {
    await fixture.sync();
    const original = await file.text();

    // Pricing goes back to TBD: the file and its old price stay.
    fixture.state.data = [model({ metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } } })];
    const tbd = await fixture.sync();
    expect([tbd.deleted, tbd.updated]).toEqual([0, 0]);
    expect(await file.text()).toBe(original);

    // The row names a checkpoint with no lab file, at a new price: the file is kept unchanged.
    fixture.state.data = [model({
      metadata: { huggingface_id: "example/unknown-model", pricing: { ...model().metadata.pricing, input_per_million: 9 } },
    })];
    const unknown = await fixture.sync();
    expect([unknown.deleted, unknown.updated]).toEqual([0, 0]);
    expect(await file.text()).toBe(original);

    // Fewer rows than the floor fails the run before anything is written.
    fixture.state.padded = false;
    fixture.state.data = [model({ id: "other" })];
    expect(fixture.sync()).rejects.toThrow("below the 20");
    expect(await file.text()).toBe(original);
  } finally {
    await fixture.cleanup();
  }
});

test("a decision file keeps authored fields through an unchanged run and a price update", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("mammoth-1");
  try {
    fixture.state.data = [mammothRow()];
    expect((await fixture.sync()).created).toBe(1);
    const authored = (await file.text())
      .replace('base_model = "baseten/mammoth-1"', 'base_model = "baseten/mammoth-1"\ndescription = "Hosted on Neuralwatt"')
      .replace("[limit]", "[capabilities]\ncache = { implicit = true }\n\n[limit]");
    await Bun.write(file, authored);
    expect((await fixture.sync()).unchanged).toBe(1);
    expect(await file.text()).toBe(authored);

    fixture.state.data = [mammothRow({
      metadata: { pricing: { input_per_million: 0.2, output_per_million: 0, cached_input_per_million: 0.02, pricing_tbd: false } },
    })];
    expect((await fixture.sync()).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.description).toBe("Hosted on Neuralwatt");
    expect(updated.capabilities.cache).toEqual({ implicit: true });
    expect(updated.cost.text.input).toEqual({ price: 0.2, cache: { read: 0.02 } });
    expect(updated.name).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test("a new multimodal file gets the lab's MIME types, and an authored MIME list with the same kinds is kept", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("qwen-new");
  try {
    fixture.state.data = [qwenRow()];
    expect((await fixture.sync()).created).toBe(1);
    const created = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(created.modalities.input).toEqual(["text", "image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp", "image/heic"]);

    // Same kinds, narrower MIME list: kept through a price update.
    await Bun.write(file, (await file.text()).replace(/^input = \[.*\]$/m, 'input = ["text", "image/png"]'));
    fixture.state.data = [qwenRow({ metadata: { pricing: { ...model().metadata.pricing, input_per_million: 2 } } })];
    expect((await fixture.sync()).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.modalities.input).toEqual(["text", "image/png"]);
    expect(updated.cost.text.input.price).toBe(2);

    // The API adds video, so the kinds match the lab's and the file inherits the lab's full MIME list.
    fixture.state.data = [qwenRow({ architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] } })];
    await fixture.sync();
    const widened = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(widened.modalities).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});
