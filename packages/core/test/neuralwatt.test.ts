import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel, type SyncProvider } from "../src/sync/index.js";
import {
  buildNeuralwattModel,
  fetchNeuralwattModels,
  labModelID,
  neuralwatt,
  neuralwattID,
  parseModels,
  resolveNeuralwattBaseModel,
  type NeuralwattModel,
} from "../src/sync/providers/neuralwatt.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";

function neuralwattMetadata(overrides: Record<string, unknown> = {}) {
  return {
    display_name: "Qwen 3.8 27B",
    description: "Qwen3.8-27B — dense 27B VL model with MTP speculative decoding, native 262K context.",
    provider: "Qwen",
    huggingface_id: "Qwen/Qwen3.8-27B-FP8",
    pricing: {
      input_per_million: 0.45, output_per_million: 3.2, cached_input_per_million: 0.25,
      cached_output_per_million: null, currency: "USD", pricing_tbd: false,
      cached_input_is_default: false, service_tier: "standard", flex_discount_multiplier: null,
    },
    capabilities: {
      tools: true, json_mode: true, vision: true, audio_input: false, reasoning: true,
      reasoning_effort: true, streaming: true, system_role: true, developer_role: false, hosted_tools: false,
    },
    reasoning: {
      mandatory: false, default_enabled: true,
      supported_efforts: ["xhigh", "medium", "low", "none"],
      default_effort: "xhigh",
      accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
      effort_aliases: { max: "xhigh", high: "xhigh", minimal: "low" },
    },
    limits: { max_context_length: 262128, max_output_tokens: 131072, max_images: 20 },
    deprecated: false, deprecated_message: null,
    ...overrides,
  };
}

function neuralwattModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "qwen-3.8-27b",
    object: "model",
    created: 0,
    owned_by: "neuralwatt",
    max_model_len: 262128,
    metadata: neuralwattMetadata(),
    ...overrides,
  };
}

function parsedModel(overrides: Record<string, unknown> = {}): NeuralwattModel {
  const [model] = parseModels({ data: [neuralwattModel(overrides)] });
  if (model === undefined) throw new Error("fixture failed to parse");
  return model;
}

// A full provider definition rather than a base_model overlay, so these assert
// the mapping itself instead of how factorBaseModel diffs against a lab file.
function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Qwen 3.8 27B",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 0.45, output: 3.2 },
    limit: { context: 262_128, output: 131_072 },
    modalities: { input: ["text", "image"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("parses the catalog response shape", () => {
  const models = parseModels({ data: [neuralwattModel()] });

  expect(models.map((model) => model.id)).toEqual(["qwen-3.8-27b"]);
});

test("refuses an empty catalog", () => {
  expect(() => parseModels({ data: [] })).toThrow(/empty/i);
});

test("fails the run rather than syncing from a degraded catalog response", async () => {
  const unavailable = () =>
    Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));

  await expect(fetchNeuralwattModels(unavailable as unknown as typeof fetch))
    .rejects.toThrow(/503 Service Unavailable/);
});

test("refuses a truncated catalog rather than deleting the models it omits", async () => {
  const truncated = () =>
    Promise.resolve(new Response(
      JSON.stringify({
        data: Array.from({ length: 5 }, (_, index) => neuralwattModel({ id: `model-${index}` })),
      }),
      { headers: { "content-type": "application/json" } },
    ));

  await expect(fetchNeuralwattModels(truncated as unknown as typeof fetch))
    .rejects.toThrow(/below the 20 needed/);
});

test("holds back a catalog that shrank below the safety floor", async () => {
  const shrunken = () =>
    Promise.resolve(new Response(
      JSON.stringify({
        data: Array.from({ length: 19 }, (_, index) => neuralwattModel({ id: `model-${index}` })),
      }),
      { headers: { "content-type": "application/json" } },
    ));

  await expect(fetchNeuralwattModels(shrunken as unknown as typeof fetch))
    .rejects.toThrow(/below the 20 needed/);
});

test("normalizes API ids to the catalog's hyphen convention", () => {
  expect(neuralwattID("deepseek-v4_flash-speed")).toBe("deepseek-v4-flash-speed");
});

test("maps huggingface orgs onto catalog labs and strips quantization suffixes", () => {
  expect(labModelID("Qwen/Qwen3.8-27B-FP8")).toBe("alibaba/qwen3.8-27b");
  expect(labModelID("zai-org/GLM-5.3-Flash")).toBe("zhipuai/glm-5.3-flash");
  expect(labModelID("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("deepseek/deepseek-v4.1-flash");
  expect(labModelID("Qwen/Qwen3.6-35B-A3B")).toBe("alibaba/qwen3.6-35b-a3b");
});

test("resolves the live entries whose huggingface ids do not follow the org map", () => {
  expect(labModelID("nvidia/Gemma-4-31B-IT-NVFP4")).toBe("google/gemma-4-31b-it");
  expect(labModelID("XiaomiMiMo/MiMo-V2.6-Pro-MOPD")).toBe("xiaomi/mimo-v2.6-pro");
});

test("returns undefined when no catalog lab file exists", () => {
  expect(labModelID("Qwen/Qwen3.9-99B")).toBeUndefined();
  expect(labModelID("nvidia/Llama-9-70B")).toBeUndefined();
});

test("falls back to the sibling variant's base when the huggingface id is absent", () => {
  const model = parsedModel({ metadata: neuralwattMetadata({ huggingface_id: null }) });

  expect(resolveNeuralwattBaseModel(model, "zhipuai/glm-5.3-flash")).toBe("zhipuai/glm-5.3-flash");
});

test("prefers the huggingface-resolved lab over the sibling fallback", () => {
  expect(resolveNeuralwattBaseModel(parsedModel(), "zhipuai/glm-5.3-flash"))
    .toBe("alibaba/qwen3.8-27b");
});

test("maps catalog metadata onto a factored qwen override", () => {
  const built = buildNeuralwattModel(parsedModel(), undefined, "alibaba/qwen3.8-27b");

  // Fields equal to the lab metadata are omitted by factoring; these differ,
  // so they survive as overrides.
  expect(built).toMatchObject({
    base_model: "alibaba/qwen3.8-27b",
    name: "Qwen 3.8 27B",
    cost: { input: 0.45, output: 3.2, cache_read: 0.25 },
    limit: { context: 262_128, output: 131_072 },
    modalities: { input: ["text", "image"] },
  });
});

test("maps capabilities and modalities from the catalog block", () => {
  const built = buildNeuralwattModel(parsedModel(), undefined, undefined);

  expect(built).toMatchObject({
    name: "Qwen 3.8 27B",
    tool_call: true,
    structured_output: true,
    reasoning: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0.45, output: 3.2, cache_read: 0.25 },
    limit: { context: 262_128, output: 131_072 },
  });
});

test("keeps an authored host name over the catalog display_name", () => {
  const built = buildNeuralwattModel(
    parsedModel(),
    authored({ name: "Hand Name" }),
    "alibaba/qwen3.8-27b",
  );

  expect(built).toMatchObject({ name: "Hand Name" });
});

test("filters the API effort ladder to the canonical order", () => {
  const built = buildNeuralwattModel(parsedModel(), undefined, undefined);

  expect(built.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "xhigh"] },
  ]);
});

test("preserves authored budget_tokens controls", () => {
  const existing = authored({
    reasoning_options: [
      { type: "effort", values: ["low", "high", "max"] },
      { type: "budget_tokens", min: 1024, max: 65536 },
    ],
  });

  const built = buildNeuralwattModel(parsedModel(), existing, "alibaba/qwen3.8-27b");

  expect(built.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "xhigh"] },
    { type: "budget_tokens", min: 1024, max: 65536 },
  ]);
});

test("does not preserve a toggle alongside the API effort ladder", () => {
  const existing = authored({ reasoning_options: [{ type: "toggle" }] });

  const built = buildNeuralwattModel(parsedModel(), existing, "alibaba/qwen3.8-27b");

  expect(built.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "xhigh"] },
  ]);
});

test("never un-deprecates a locally deprecated model", () => {
  const built = buildNeuralwattModel(
    parsedModel({ metadata: neuralwattMetadata({ deprecated: false }) }),
    authored({ status: "deprecated" }),
    "alibaba/qwen3.8-27b",
  );

  expect(built).toMatchObject({ status: "deprecated" });
});

test("deprecates a model the catalog marks deprecated", () => {
  const built = buildNeuralwattModel(
    parsedModel({ metadata: neuralwattMetadata({ deprecated: true }) }),
    authored(),
    "alibaba/qwen3.8-27b",
  );

  expect(built).toMatchObject({ status: "deprecated" });
});

test("omits release_date when the catalog created timestamp is zero", () => {
  const built = buildNeuralwattModel(parsedModel({ created: 0 }), undefined, undefined);

  expect(built.release_date).toBeUndefined();
});

test("derives release_date from a nonzero created timestamp", () => {
  const built = buildNeuralwattModel(
    parsedModel({ created: 1_759_104_000 }),
    undefined,
    undefined,
  );

  expect(built).toMatchObject({ release_date: "2025-09-29" });
});

test("keeps local pricing when the catalog marks pricing tbd", () => {
  const model = parsedModel({
    metadata: neuralwattMetadata({
      pricing: { input_per_million: 0.45, output_per_million: 3.2, pricing_tbd: true },
    }),
  });

  const built = buildNeuralwattModel(model, authored({ cost: { input: 9, output: 9 } }), undefined);

  expect(built).toMatchObject({ cost: { input: 9, output: 9 } });
});

test("throws when a reasoning model has neither an API ladder nor authored controls", () => {
  const model = parsedModel({
    metadata: neuralwattMetadata({
      reasoning: {
        mandatory: false, default_enabled: true,
        supported_efforts: [], default_effort: null,
        accepted_efforts: [], effort_aliases: {},
      },
    }),
  });

  expect(() => buildNeuralwattModel(model, undefined, "alibaba/qwen3.8-27b"))
    .toThrow(MissingReasoningOptionsError);
});

test("builds modalities from vision and audio_input capabilities", () => {
  const model = parsedModel({
    metadata: neuralwattMetadata({
      capabilities: {
        tools: true, json_mode: true, vision: false, audio_input: true, reasoning: true,
        reasoning_effort: true, streaming: true, system_role: true, developer_role: false, hosted_tools: false,
      },
    }),
  });

  const built = buildNeuralwattModel(model, undefined, undefined);

  expect(built.modalities).toEqual({ input: ["text", "audio"], output: ["text"] });
  expect(built).toMatchObject({ attachment: true });
});

test("passes through authored interleaved and knowledge", () => {
  const built = buildNeuralwattModel(
    parsedModel(),
    authored({ interleaved: true, knowledge: "2026-01" }),
    "alibaba/qwen3.8-27b",
  );

  expect(built).toMatchObject({ interleaved: true, knowledge: "2026-01" });
});

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

test("skips Neuralwatt-branded nw-* aliases rather than aliasing lab files", () => {
  const model = parsedModel({
    id: "nw-large",
    metadata: neuralwattMetadata({ huggingface_id: "moonshotai/Kimi-K3" }),
  });

  expect(neuralwatt.translateModel(model, context({}))).toBeUndefined();
  expect(neuralwatt.sourceID(model)).toBe("nw-large");
  expect(neuralwatt.missingModelID(model)).toBeUndefined();
});

test("returns undefined for an unresolvable base so the runner preserves the file", () => {
  const model = parsedModel({
    id: "mystery-model-9b",
    metadata: neuralwattMetadata({ huggingface_id: "UnknownLab/Mystery-9B" }),
  });

  expect(neuralwatt.translateModel(model, context({}))).toBeUndefined();
  expect(neuralwatt.translateModel(
    model,
    context({ "mystery-model-9b": authored({ base_model: "unknownlab/mystery-9b" }) }),
  )).toBeUndefined();
  expect(neuralwatt.missingModelID(model)).toBe("mystery-model-9b");
});

test("normalizes a new model's id and factors it onto the resolved lab base", () => {
  const model = parsedModel({
    id: "deepseek-v4_flash-speed",
    metadata: neuralwattMetadata({
      huggingface_id: "deepseek-ai/DeepSeek-V4-Flash-0731",
      reasoning: { supported_efforts: ["max", "high", "none"] },
    }),
  });

  const translated = neuralwatt.translateModel(model, context({}));

  expect(translated?.id).toBe("deepseek-v4-flash-speed");
  expect(translated?.model).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash-0731",
    reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
  });
});

test("falls back to the sibling variant's authored base when the huggingface id is absent", () => {
  const model = parsedModel({
    id: "qwen-3.8-27b-flex",
    metadata: neuralwattMetadata({ huggingface_id: null }),
  });

  const translated = neuralwatt.translateModel(
    model,
    context({ "qwen-3.8-27b": authored({ base_model: "alibaba/qwen3.8-27b" }) }),
  );

  expect(translated?.model).toMatchObject({ base_model: "alibaba/qwen3.8-27b" });
});

test("writes a leading wire-path header for every reasoning control on the file", () => {
  const model = parsedModel({
    id: "glm-5.3",
    metadata: neuralwattMetadata({
      huggingface_id: "zai-org/GLM-5.3",
      reasoning: { supported_efforts: ["max", "high", "low"] },
    }),
  });

  const translated = neuralwatt.translateModel(
    model,
    context({
      "glm-5.3": authored({
        base_model: "zhipuai/glm-5.3",
        reasoning_options: [{ type: "budget_tokens", min: 1024, max: 65536 }],
      }),
    }),
  );

  expect(translated?.header).toContain(`# Effort: reasoning_effort = "low" | "high" | "max"`);
  expect(translated?.header).toContain("# Budget: thinking_token_budget");
  expect(translated?.header).toContain("https://portal.neuralwatt.com/docs/");
});

test("renders the skipped notice with its ids", () => {
  expect(neuralwatt.skippedNotice(["nw-large", "nw-flash"])).toEqual([
    expect.stringContaining("nw-large, nw-flash"),
  ]);
  expect(neuralwatt.skippedNotice([])).toEqual([]);
});

function contextWithAuthored(
  entries: Record<string, { resolved: ExistingModel; authored: ExistingModel }>,
) {
  return {
    existing: (id: string) => entries[id]?.resolved,
    authored: (id: string) => entries[id]?.authored,
  };
}

test("does not re-pin the previous base's identity when the base switches", () => {
  const model = parsedModel({
    id: "deepseek-v4-flash",
    metadata: neuralwattMetadata({
      display_name: "DeepSeek V4 Flash",
      huggingface_id: "deepseek-ai/DeepSeek-V4-Flash-0731",
      reasoning: { supported_efforts: ["max", "high", "none"] },
    }),
  });
  const context2 = contextWithAuthored({
    "deepseek-v4-flash": {
      // What the runner hands over as `existing`: the previous base
      // (deepseek/deepseek-v4-flash, released 2026-04-24) merged with the
      // local file, while `authored` is the raw local file.
      resolved: authored({
        base_model: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        release_date: "2026-04-24",
        last_updated: "2026-04-24",
      }),
      authored: authored({ base_model: "deepseek/deepseek-v4-flash", name: undefined }),
    },
  });

  const translated = neuralwatt.translateModel(model, context2);

  expect(translated?.model).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash",
  });
  expect(translated?.model.release_date).toBeUndefined();
  expect(translated?.model.last_updated).toBeUndefined();
});

test("stamps last_updated only on files the sync creates", () => {
  const created = buildNeuralwattModel(parsedModel(), undefined, "alibaba/qwen3.8-27b", "2026-10-12");
  expect(created).toMatchObject({ last_updated: "2026-10-12" });

  const kept = buildNeuralwattModel(parsedModel(), authored(), "alibaba/qwen3.8-27b", "2026-10-12");
  expect(kept.last_updated).toBeUndefined();
});

test("accepts null catalog limits and falls back to the authored ones", () => {
  const model = parsedModel({
    max_model_len: undefined,
    metadata: neuralwattMetadata({
      limits: { max_context_length: null, max_output_tokens: null, max_images: 20 },
    }),
  });

  const built = buildNeuralwattModel(
    model,
    authored({ limit: { context: 111_111, output: 222_222 } }),
    "alibaba/qwen3.8-27b",
  );

  expect(built).toMatchObject({ limit: { context: 111_111, output: 222_222 } });
});

type StubRemoteModel = { id: string };

function deprecatingProvider(modelsDir: string) {
  return {
    id: "neuralwatt",
    name: "Neuralwatt",
    modelsDir,
    deprecateMissing: true,
    async fetchModels() {
      return { data: [{ id: "kept-model" }] };
    },
    parseModels(raw: unknown) {
      return (raw as { data: StubRemoteModel[] }).data;
    },
    translateModel(model: StubRemoteModel) {
      return {
        id: model.id,
        model: { base_model: "alibaba/qwen3.8-27b", name: "Kept Model" },
      };
    },
  } satisfies SyncProvider<StubRemoteModel>;
}

async function deprecationFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const modelsDir = path.join(root, "providers", "neuralwatt", "models");
  const oldPath = path.join(modelsDir, "old-model.toml");
  const basePath = path.join(root, "models", "alibaba", "qwen3.8-27b.toml");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.dirname(basePath), { recursive: true });
  await Bun.write(basePath, 'name = "Qwen3.8 27B"\n');
  return { root, modelsDir, oldPath };
}

test("deprecates a delisted local model instead of deleting it", async () => {
  const { root, modelsDir, oldPath } = await deprecationFixture("sync-neuralwatt-");
  await Bun.write(oldPath, [
    "# Old model note",
    'base_model = "alibaba/qwen3.8-27b"',
    'name = "Old Model"',
    "",
  ].join("\n"));

  const provider = deprecatingProvider(modelsDir);

  try {
    const first = await syncProvider(provider);
    expect(first).toMatchObject({ created: 1, updated: 1, deleted: 0 });
    expect(await Bun.file(oldPath).exists()).toBe(true);
    const deprecated = await Bun.file(oldPath).text();
    expect(deprecated).toMatch(/# Deprecated: absent from Neuralwatt catalog since \d{4}-\d{2}-\d{2}\n/);
    expect(deprecated).toContain("# Old model note");
    expect(deprecated).toContain('status = "deprecated"');
    expect(deprecated).toContain('name = "Old Model"');
    expect(deprecated).toContain('base_model = "alibaba/qwen3.8-27b"');

    const second = await syncProvider(provider);
    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(await Bun.file(oldPath).text()).toBe(deprecated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pins structured_output false when the host disables JSON mode", () => {
  const model = parsedModel({
    metadata: neuralwattMetadata({
      capabilities: { tools: true, json_mode: false, vision: true, audio_input: false, reasoning: true },
    }),
  });

  const built = buildNeuralwattModel(model, undefined, "alibaba/qwen3.8-27b");

  expect(built).toMatchObject({ structured_output: false });
});

test("gives a new reasoning model the interleaved side channel", () => {
  const model = parsedModel();

  const built = buildNeuralwattModel(model, undefined, undefined);

  expect(built).toMatchObject({ interleaved: true });
});

test("keeps an authored interleaved value over the host default", () => {
  const model = parsedModel();

  const built = buildNeuralwattModel(model, authored({ interleaved: false }), undefined);

  expect(built).toMatchObject({ interleaved: false });
});

test("leaves interleaved off for a model without reasoning", () => {
  const model = parsedModel({
    metadata: neuralwattMetadata({
      capabilities: { tools: true, json_mode: true, vision: true, audio_input: false, reasoning: false },
    }),
  });

  expect(buildNeuralwattModel(model, undefined, undefined).interleaved).toBeUndefined();
});

test("reports missing reasoning controls under the normalized file id", () => {
  const model = parsedModel({
    id: "deepseek-v4_flash-speed",
    metadata: neuralwattMetadata({ reasoning: { supported_efforts: [] } }),
  });

  let error: MissingReasoningOptionsError | undefined;
  try {
    buildNeuralwattModel(model, undefined, "deepseek/deepseek-v4-flash-0731");
  } catch (thrown) {
    error = thrown as MissingReasoningOptionsError;
  }

  expect(error).toBeInstanceOf(MissingReasoningOptionsError);
  expect(error?.modelId).toBe("deepseek-v4-flash-speed");
});

test("keeps a live model's file when its reasoning controls are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-neuralwatt-missing-"));
  const modelsDir = path.join(root, "providers", "neuralwatt", "models");
  const filePath = path.join(modelsDir, "deepseek-v4-flash-speed.toml");
  const basePath = path.join(root, "models", "deepseek", "deepseek-v4-flash-0731.toml");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.dirname(basePath), { recursive: true });
  await Bun.write(basePath, 'name = "DeepSeek V4 Flash 0731"\n');
  await Bun.write(filePath, [
    'base_model = "deepseek/deepseek-v4-flash-0731"',
    'name = "DeepSeek V4 Flash Speed"',
    "",
  ].join("\n"));
  const before = await Bun.file(filePath).text();

  try {
    const result = await syncProvider({
      ...neuralwatt,
      modelsDir,
      async fetchModels() {
        return {
          data: [neuralwattModel({
            id: "deepseek-v4_flash-speed",
            metadata: neuralwattMetadata({ reasoning: { supported_efforts: [] } }),
          })],
        };
      },
    });

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(result.notices.join(" ")).toContain("deepseek-v4-flash-speed");
    expect(await Bun.file(filePath).text()).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves delisted files untouched in new-only mode", async () => {
  const { root, modelsDir, oldPath } = await deprecationFixture("sync-neuralwatt-newonly-");
  await Bun.write(oldPath, [
    'base_model = "alibaba/qwen3.8-27b"',
    'name = "Old Model"',
    "",
  ].join("\n"));
  const before = await Bun.file(oldPath).text();

  try {
    const result = await syncProvider(deprecatingProvider(modelsDir), { newOnly: true });

    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(await Bun.file(oldPath).text()).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not write through a leaf symlink when deprecating", async () => {
  const { root, modelsDir, oldPath } = await deprecationFixture("sync-neuralwatt-symlink-");
  const targetPath = path.join(root, "outside.toml");
  await Bun.write(targetPath, [
    'base_model = "alibaba/qwen3.8-27b"',
    'name = "Outside Target"',
    "",
  ].join("\n"));
  await symlink(targetPath, oldPath);

  try {
    const preserved = await syncProvider(
      { ...deprecatingProvider(modelsDir), preserveSymlinks: true },
    );
    expect(preserved).toMatchObject({ updated: 0, deleted: 0 });
    expect((await lstat(oldPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(targetPath).text()).not.toContain('status = "deprecated"');

    const replaced = await syncProvider(deprecatingProvider(modelsDir));
    expect(replaced).toMatchObject({ updated: 1, deleted: 0 });
    expect((await lstat(oldPath)).isSymbolicLink()).toBe(false);
    expect(await Bun.file(oldPath).text()).toContain('status = "deprecated"');
    expect(await Bun.file(targetPath).text()).not.toContain('status = "deprecated"');
    expect(await Bun.file(targetPath).text()).toContain('name = "Outside Target"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
