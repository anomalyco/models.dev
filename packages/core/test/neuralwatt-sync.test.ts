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
  architecture: overrides.architecture ?? { input_modalities: ["text"], output_modalities: ["decisions"] },
});

// Unpriced chat rows the sync skips quietly, to bring a test list up to the truncation floor.
const filler = Array.from({ length: 12 }, (_, index) => model({
  id: `tbd-${index}`,
  metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } },
}));
const embeddings = Array.from({ length: 12 }, (_, index) => model({
  id: `embed-${index}`,
  metadata: { huggingface_id: null, capabilities: { tools: false, json_mode: false, reasoning: false, task: "embed" }, reasoning: null },
  architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
}));

async function syncFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-neuralwatt-sync-"));
  const modelsDir = path.join(root, "providers/neuralwatt/models");
  await mkdir(modelsDir, { recursive: true });
  const repo = path.join(import.meta.dirname, "../../..");
  for (const lab of ["zhipuai/glm-5.3", "alibaba/qwen3.8-27b", "baseten/mammoth-1", "xiaomi/mimo-v2.6-pro"]) {
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
  expect(() => neuralwatt.parseModels({ object: "list", scope: "public", data: [] })).toThrow("below the 12");
  expect(() => neuralwatt.parseModels({ object: "list", scope: "public", data: filler.slice(0, 11) })).toThrow("below the 12");
  expect(neuralwatt.parseModels({ object: "list", scope: "public", data: filler })).toHaveLength(12);
  // Rows without a catalog shape don't count toward the floor.
  expect(() => neuralwatt.parseModels({ object: "list", scope: "public", data: [...embeddings, model()] })).toThrow("below the 12");
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
  // Another org's quantization resolves only through the override table.
  expect(neuralwattBaseModel("other-org/Gemma-4-31B-IT-NVFP4")).toBeUndefined();
  expect(neuralwatt.missingModelID(model({ id: "gemma-copy", metadata: { huggingface_id: "other-org/Gemma-4-31B-IT-NVFP4" } }))).toBe("gemma-copy");
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
  expect(neuralwatt.translateModel(unnamed, withFile)).toMatchObject({ model: { base_model: "alibaba/qwen3.8-27b" } });
  expect(neuralwatt.translateModel(unnamed, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(unnamed)).toBe("nw-small");

  // A decision row whose lab file isn't a decision model is reported.
  const misfiled = mammothRow({ id: "decider", metadata: { huggingface_id: "zai-org/GLM-5.3" } });
  expect(neuralwatt.translateModel(misfiled, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(misfiled)).toBe("decider");

  // A decision row that takes media needs a hand-written file, so it is reported.
  const media = mammothRow({ architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["decisions"] } });
  expect(neuralwatt.translateModel(media, noFiles)).toBeUndefined();
  expect(neuralwatt.missingModelID(media)).toBe("mammoth-1");
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
    fixture.state.data = [model({ metadata: { deprecated: false } })];
    await fixture.sync();
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).status).toBeUndefined();

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

    // When pricing goes back to TBD, the file and its old price stay.
    fixture.state.data = [model({ metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } } })];
    const tbd = await fixture.sync();
    expect([tbd.deleted, tbd.updated]).toEqual([0, 0]);
    expect(await file.text()).toBe(original);

    // A row naming a checkpoint with no lab file, at a new price, leaves the file unchanged.
    fixture.state.data = [model({
      metadata: { huggingface_id: "example/unknown-model", pricing: { ...model().metadata.pricing, input_per_million: 9 } },
    })];
    const unknown = await fixture.sync();
    expect([unknown.deleted, unknown.updated]).toEqual([0, 0]);
    expect(await file.text()).toBe(original);

    // Fewer rows than the floor fails the run before anything is written.
    fixture.state.padded = false;
    fixture.state.data = [model({ id: "other" })];
    expect(fixture.sync()).rejects.toThrow("below the 12");
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

    // An unpriced decision row keeps its v2-only file as written.
    const priced = await file.text();
    fixture.state.data = [mammothRow({
      metadata: { pricing: { input_per_million: null, output_per_million: null, cached_input_per_million: null, pricing_tbd: true } },
    })];
    const tbd = await fixture.sync();
    expect([tbd.deleted, tbd.updated]).toEqual([0, 0]);
    expect(await file.text()).toBe(priced);
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

    // A TBD row leaves the narrower list and the old price alone.
    const narrowed = await file.text();
    fixture.state.data = [qwenRow({ metadata: { pricing: { ...model().metadata.pricing, pricing_tbd: true } } })];
    await fixture.sync();
    expect(await file.text()).toBe(narrowed);

    // The API lists video, which chat completions doesn't accept, so the route stays text and PNG.
    fixture.state.data = [qwenRow({
      architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
      metadata: { pricing: { ...model().metadata.pricing, input_per_million: 2 } },
    })];
    expect((await fixture.sync()).unchanged).toBe(1);
    expect(await file.text()).toBe(narrowed);
  } finally {
    await fixture.cleanup();
  }
});

const mimoRow = (overrides: Overrides = {}) => qwenRow({
  id: "mimo-new",
  max_model_len: 1_048_560,
  ...overrides,
  metadata: {
    huggingface_id: "XiaomiMiMo/MiMo-V2.6-Pro-MOPD",
    limits: { max_context_length: 1_048_560, max_output_tokens: null },
    reasoning: { mandatory: false, supported_efforts: ["none", "high"], default_effort: "high" },
    ...overrides.metadata,
  },
});

test("a narrower MIME list survives when the API's kinds equal the lab's, and a new kind doesn't widen it", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("mimo-new");
  const textImage = { input_modalities: ["text", "image"], output_modalities: ["text"] };
  const withAudio = { input_modalities: ["text", "image", "audio"], output_modalities: ["text"] };
  try {
    fixture.state.data = [mimoRow({ architecture: withAudio })];
    expect((await fixture.sync()).created).toBe(1);

    const authored = (await file.text()).replace(/^input = \[.*\]$/m, 'input = ["text", "image/png", "audio/wav"]');
    await Bun.write(file, authored);
    expect((await fixture.sync()).unchanged).toBe(1);
    expect(await file.text()).toBe(authored);
    fixture.state.data = [mimoRow({ architecture: withAudio, metadata: { pricing: { ...model().metadata.pricing, input_per_million: 2 } } })];
    expect((await fixture.sync()).updated).toBe(1);
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).modalities.input).toEqual(["text", "image/png", "audio/wav"]);

    // Audio leaves and comes back. The PNG-only image list is never widened to the lab's formats.
    fixture.state.data = [mimoRow({ architecture: textImage })];
    await fixture.sync();
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).modalities.input).toEqual(["text", "image/png"]);
    fixture.state.data = [mimoRow({ architecture: withAudio })];
    await fixture.sync();
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).modalities.input).toEqual(["text", "image/png", "audio/wav"]);
  } finally {
    await fixture.cleanup();
  }
});

test("an alias retarget drops the old lab's MIME types, output cap, reasoning controls and reasoning field", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("qwen-new");
  try {
    fixture.state.data = [qwenRow()];
    await fixture.sync();
    await Bun.write(file, (await file.text())
      .replace(/^context = (.*)$/m, "context = $1\noutput = 200_000")
      .replace(/^reasoning = \{ supported = true, effort = (\[[^\]]*\]) \}$/m, 'reasoning = { supported = true, default = { type = "effort", value = "low" }, effort = $1, budget = {} }')
      .replace("legacy_interleaved = true", 'compatibility = { reasoning_field = "reasoning_content" }'));
    expect((await fixture.sync()).unchanged).toBe(1);
    const onQwen = await file.text();
    expect(onQwen).toContain("budget = {}");
    expect(onQwen).toContain('reasoning_field = "reasoning_content"');

    // A retarget to a model that publishes no levels keeps the file unchanged and reports it.
    const unpublished = qwenRow({ metadata: { huggingface_id: "XiaomiMiMo/MiMo-V2.6-Pro-MOPD", reasoning: null } });
    fixture.state.data = [unpublished];
    const held = await fixture.sync();
    expect([held.updated, held.deleted]).toEqual([0, 0]);
    expect(await file.text()).toBe(onQwen);
    expect(neuralwatt.missingModelID(unpublished)).toBe("qwen-new");

    // The alias now serves MiMo, whose lab lists no TIFF, HEIC or BMP-only Qwen formats, and the API publishes no cap.
    fixture.state.data = [qwenRow({
      max_model_len: 1_048_560,
      metadata: {
        huggingface_id: "XiaomiMiMo/MiMo-V2.6-Pro-MOPD",
        limits: { max_context_length: 1_048_560, max_output_tokens: null },
        reasoning: { mandatory: false, supported_efforts: ["none", "high"], default_effort: "high" },
      },
    })];
    expect((await fixture.sync()).updated).toBe(1);
    const moved = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(moved.base_model).toBe("xiaomi/mimo-v2.6-pro");
    expect(moved.modalities.input).toEqual(["text", "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
    expect(moved.limit.output).toBeUndefined();
    // The new ladder, without Qwen's budget, default or reasoning field.
    expect(moved.capabilities.reasoning).toEqual({ supported: true, effort: ["none", "high"] });
    expect(moved.api?.["chat-completions"]?.compatibility).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test("a new audio route lists WAV as its only audio format", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("mimo-new");
  try {
    fixture.state.data = [mimoRow({ architecture: { input_modalities: ["text", "image", "audio"], output_modalities: ["text"] } })];
    expect((await fixture.sync()).created).toBe(1);
    const input = (Bun.TOML.parse(await file.text()) as Record<string, any>).modalities.input as string[];
    expect(input.filter((item) => item.startsWith("audio/"))).toEqual(["audio/wav"]);
    expect(input).toContain("image/png");
  } finally {
    await fixture.cleanup();
  }
});

test("an authored default effort survives a ladder change while it is still a level", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("glm-5.3");
  const ladder = (supported_efforts: string[]) =>
    [model({ metadata: { reasoning: { mandatory: true, supported_efforts, default_effort: "max" } } })];
  try {
    await fixture.sync();
    await Bun.write(file, (await file.text()).replace("reasoning = { supported = true,", 'reasoning = { supported = true, default = { type = "effort", value = "high" },'));

    fixture.state.data = ladder(["low", "high"]);
    expect((await fixture.sync()).updated).toBe(1);
    const reasoning = (Bun.TOML.parse(await file.text()) as Record<string, any>).capabilities.reasoning;
    expect(reasoning.effort).toEqual(["low", "high"]);
    expect(reasoning.default).toEqual({ type: "effort", value: "high" });
    expect((await fixture.sync()).unchanged).toBe(1);

    fixture.state.data = ladder(["low"]);
    await fixture.sync();
    expect((Bun.TOML.parse(await file.text()) as Record<string, any>).capabilities.reasoning.default).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});

test("an authored budget default survives a ladder change while the budget control stays", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("glm-5.3");
  try {
    await fixture.sync();
    await Bun.write(file, (await file.text()).replace(
      /^reasoning = \{ supported = true, effort = (\[[^\]]*\]) \}$/m,
      'reasoning = { supported = true, default = { type = "budget", value = 4096 }, effort = $1, budget = {} }',
    ));
    fixture.state.data = [model({ metadata: { reasoning: { mandatory: true, supported_efforts: ["low", "high"], default_effort: "high" } } })];
    expect((await fixture.sync()).updated).toBe(1);
    const reasoning = (Bun.TOML.parse(await file.text()) as Record<string, any>).capabilities.reasoning;
    expect(reasoning).toEqual({ supported: true, default: { type: "budget", value: 4096 }, effort: ["low", "high"], budget: {} });
  } finally {
    await fixture.cleanup();
  }
});

test("an authored reasoning field and base_model_omit survive a price update on the same lab", async () => {
  const fixture = await syncFixture();
  const file = fixture.file("glm-5.3");
  try {
    await fixture.sync();
    const authored = (await file.text())
      .replace("legacy_interleaved = true", 'compatibility = { reasoning_field = "reasoning_content" }')
      .replace('base_model = "zhipuai/glm-5.3"', 'base_model = "zhipuai/glm-5.3"\nbase_model_omit = ["temperature"]');
    await Bun.write(file, authored);
    expect((await fixture.sync()).unchanged).toBe(1);
    fixture.state.data = [model({ metadata: { pricing: { ...model().metadata.pricing, input_per_million: 1.2 } } })];
    expect((await fixture.sync()).updated).toBe(1);
    const updated = Bun.TOML.parse(await file.text()) as Record<string, any>;
    expect(updated.api["chat-completions"].compatibility).toEqual({ reasoning_field: "reasoning_content" });
    expect(updated.base_model_omit).toEqual(["temperature"]);
    expect(updated.cost.text.input.price).toBe(1.2);
  } finally {
    await fixture.cleanup();
  }
});
