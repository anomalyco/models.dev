import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { preserveReasoningOptions, syncProvider, type ExistingModel, type SyncedModel, type SyncProvider } from "../src/sync/index.js";
import {
  anthropic,
  buildAnthropicModel,
  parseAnthropicPricing,
  type AnthropicModel,
} from "../src/sync/providers/anthropic.js";
import { buildCortecsModel, cortecs, type CortecsModel } from "../src/sync/providers/cortecs.js";
import {
  buildCrossModel,
  crossmodel,
  CrossModelResponse,
  type CrossModelModel,
} from "../src/sync/providers/crossmodel.js";
import {
  buildDeepInfraModel,
  deepinfra,
  deepInfraV2Set,
  resolveDeepInfraBaseModel,
  type DeepInfraModel,
} from "../src/sync/providers/deepinfra.js";
import {
  buildDigitalOceanModel,
  digitalocean,
  digitalOceanV2Set,
  fetchDigitalOceanModels,
  parseDigitalOceanModels,
  resolveDigitalOceanBaseModel,
  type DigitalOceanSourceModel,
} from "../src/sync/providers/digitalocean.js";
import {
  buildEdenAIModel,
  collectFirstPartyBaseModels,
  edenai,
  reasoningOptionsFor,
  resolveEdenAIBaseModel,
  type EdenAIModel,
} from "../src/sync/providers/edenai.js";
import { buildHyperModel, type HyperModel } from "../src/sync/providers/hyper.js";
import { buildHuggingFaceModel, huggingface, type HuggingFaceModel } from "../src/sync/providers/huggingface.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildInceptronModel,
  parseInceptronModels,
  perTokenToPerMillion,
  type InceptronModel,
  type ReadyInceptronModel,
} from "../src/sync/providers/inceptron.js";
import {
  buildEmpiriolabsModel,
  empiriolabs,
  resolveEmpiriolabsBaseModel,
  type EmpiriolabsModel,
} from "../src/sync/providers/empiriolabs.js";
import {
  buildOpenRouterMediaModel,
  buildOpenRouterModel,
  mediaCost,
  mediaType,
  openrouter,
  resolveCanonicalBaseModel,
  catalogCost,
  overrideWhen,
  withSystemOneMediaInput,
  withTextApis,
  type OpenRouterModel,
} from "../src/sync/providers/openrouter.js";
import {
  buildLLMGatewayMappedModel,
  buildLLMGatewayModel,
  llmgateway,
  llmgatewayProviders,
  type LLMGatewayModel,
} from "../src/sync/providers/llmgateway.js";
import {
  buildMergeGatewayModel,
  fetchMergeGatewayModels,
  mergeGateway,
  mergeGatewayReasoningOptions,
  MergeGatewayResponse,
  selectMergeGatewayVendor,
  type MergeGatewayModel,
} from "../src/sync/providers/merge-gateway.js";
import {
  buildNanoGptModel,
  nanoGpt,
  NanoGptResponse,
  resolveNanoGptBaseModel,
  type NanoGptModel,
} from "../src/sync/providers/nano-gpt.js";
import { openai, parseOpenAIModels } from "../src/sync/providers/openai.js";
import { buildOfoxModel, ofox } from "../src/sync/providers/ofox.js";
import { pioneer } from "../src/sync/providers/pioneer.js";
import { buildGoogleModel, google, shouldTrackGoogleModel } from "../src/sync/providers/google.js";
import { buildTinfoilModel, tinfoil, type TinfoilModel } from "../src/sync/providers/tinfoil.js";
import { buildVeniceModel, resolveVeniceBaseModel, veniceV2Set, withResponsesApi, type VeniceModel } from "../src/sync/providers/venice.js";
import { buildVercelMediaModel, buildVercelModel, chatApis, realtimePriceNote, vercel, vercelCache, vercelMediaCost } from "../src/sync/providers/vercel.js";
import { buildKiloModel, kilo } from "../src/sync/providers/kilo.js";
import { patchModelV2, sameV1Model } from "../src/model-file-v2.js";
import { modelV2ToV1 } from "../src/translate.js";
import { generate } from "../src/generate.js";
import { buildWandbModel, mergeReasoningOptions, type WandbModel } from "../src/sync/providers/wandb.js";
import { buildChutesModel } from "../src/sync/providers/chutes.js";
import { buildXAIModel, xai } from "../src/sync/providers/xai.js";

function anthropicModel(overrides: Partial<AnthropicModel> = {}): AnthropicModel {
  return {
    id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    created_at: "2026-06-30T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true } },
      },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
    },
    ...overrides,
  };
}

function nanoGptModel(overrides: Partial<NanoGptModel> = {}): NanoGptModel {
  return {
    id: "example/reasoning-model",
    name: "Example Reasoning Model",
    description: "Example model used to test NanoGPT catalog translation",
    created: Date.parse("2026-06-01T00:00:00Z") / 1_000,
    owned_by: "example",
    context_length: 500_000,
    max_output_tokens: 64_000,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    capabilities: {
      reasoning: true,
      tool_calling: true,
      structured_output: true,
    },
    reasoning_efforts: ["low", "high"],
    open_weights: true,
    pricing: {
      prompt: 0.42,
      completion: 1.32,
      cacheReadInputPer1kTokens: 0.000078,
    },
    ...overrides,
  };
}

function crossModelModel(overrides: Partial<CrossModelModel> = {}): CrossModelModel {
  return {
    id: "qwen/qwen3.8-max",
    vendor_code: "qwen",
    display_name: "Qwen3.8 Max",
    context_window_tokens: 1_000_000,
    max_output_tokens: 131_072,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    capabilities: {
      json: true,
      reasoning: { toggle: true },
    },
    currency: "USD",
    pricing: {
      tiers: [
        {
          threshold: 0,
          input_micro_per_1m: 1_880_000,
          output_micro_per_1m: 5_630_000,
        },
      ],
    },
    ...overrides,
  };
}

function inceptronModel(overrides: Partial<InceptronModel> = {}): InceptronModel {
  return {
    id: "zai-org/GLM-5.2",
    name: "GLM 5.2",
    context_length: 1_048_576,
    max_output_length: 1_048_576,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: ["chat", "tools", "reasoning", "structured_outputs"],
    supported_sampling_parameters: ["temperature", "reasoning_effort"],
    pricing: {
      prompt: "0.00000075",
      completion: "0.0000029",
      input_cache_reads: "0.00000017",
      input_cache_writes: "0",
    },
    models_dev: {
      base_model: "zhipuai/glm-5.2",
      reasoning_options: [{ type: "effort", values: ["high", "max"] }],
      interleaved: { field: "reasoning_content" },
      status: "alpha",
    },
    ...overrides,
  };
}

function readyInceptronModel(overrides: Partial<InceptronModel> = {}): ReadyInceptronModel {
  return parseInceptronModels({
    object: "list",
    data: [inceptronModel(overrides)],
  })[0]!;
}

test("builds current Inceptron models from explicit base metadata", () => {
  const models = parseInceptronModels({
    object: "list",
    data: [
      inceptronModel({
        id: "MiniMaxAI/MiniMax-M2.5",
        name: "MiniMax M2.5",
        context_length: 196_608,
        max_output_length: 196_608,
        pricing: { prompt: "0.00000022", completion: "0.0000009" },
        models_dev: {
          base_model: "minimax/MiniMax-M2.5",
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        },
      }),
      inceptronModel(),
      inceptronModel({
        id: "moonshotai/Kimi-K2.6",
        name: "Kimi K2.6",
        context_length: 262_144,
        max_output_length: 262_144,
        input_modalities: ["text", "image"],
        supported_sampling_parameters: ["temperature"],
        pricing: { prompt: "0.0000006", completion: "0.00000341" },
        models_dev: {
          base_model: "moonshotai/kimi-k2.6",
          reasoning_options: [],
          interleaved: { field: "reasoning_content" },
        },
      }),
      inceptronModel({
        id: "moonshotai/Kimi-K2.7-Code",
        name: "Kimi K2.7 Code",
        context_length: 262_144,
        max_output_length: 262_144,
        input_modalities: ["text", "image"],
        supported_sampling_parameters: ["temperature"],
        pricing: { prompt: "0.0000007", completion: "0.0000035" },
        models_dev: {
          base_model: "moonshotai/kimi-k2.7-code",
          reasoning_options: [],
          interleaved: { field: "reasoning_content" },
        },
      }),
      inceptronModel({
        id: "deepseek-ai/DeepSeek-V4-Flash-0731",
        name: "DeepSeek V4 Flash 0731",
        context_length: 1_048_576,
        max_output_length: 1_048_576,
        pricing: {
          prompt: "0.00000013",
          completion: "0.00000028",
          input_cache_reads: "0.00000003",
          input_cache_writes: "0",
        },
        models_dev: {
          base_model: "deepseek/deepseek-v4-flash-0731",
          reasoning_options: [{ type: "effort", values: ["high", "max"] }],
          interleaved: { field: "reasoning_content" },
        },
      }),
    ],
  });

  const built = models.map(buildInceptronModel);
  expect(built.map((model) => "base_model" in model ? model.base_model : undefined)).toEqual([
    "minimax/MiniMax-M2.5",
    "zhipuai/glm-5.2",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.7-code",
    "deepseek/deepseek-v4-flash-0731",
  ]);
  expect(built[0]).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    cost: { input: 0.22, output: 0.9 },
  });
  expect(built[1]).toMatchObject({
    name: "GLM 5.2",
    reasoning_options: [{ type: "effort", values: ["high", "max"] }],
    interleaved: { field: "reasoning_content" },
    status: "alpha",
    cost: { input: 0.75, output: 2.9, cache_read: 0.17, cache_write: 0 },
    limit: { context: 1_048_576, output: 1_048_576 },
  });
  expect(built[2]).toMatchObject({
    reasoning_options: [],
    interleaved: { field: "reasoning_content" },
    modalities: { input: ["text", "image"] },
  });
  expect(built[3]).toMatchObject({
    reasoning_options: [],
    interleaved: { field: "reasoning_content" },
  });
  expect(built[4]).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 0.13, output: 0.28, cache_read: 0.03, cache_write: 0 },
    limit: { context: 1_048_576, output: 1_048_576 },
  });
});

test("converts Inceptron per-token decimal prices exactly", () => {
  expect(perTokenToPerMillion("0")).toBe(0);
  expect(perTokenToPerMillion("0.00000005")).toBe(0.05);
  expect(perTokenToPerMillion("0.00000341")).toBe(3.41);
  expect(perTokenToPerMillion("1.25")).toBe(1_250_000);
});

test("rejects incomplete or contradictory ready Inceptron catalogs", () => {
  expect(() =>
    parseInceptronModels({ object: "list", data: [inceptronModel({ models_dev: undefined })] })
  ).toThrow("missing models_dev metadata");
  expect(() =>
    parseInceptronModels({
      object: "list",
      data: [inceptronModel(), inceptronModel()],
    })
  ).toThrow("Duplicate ready Inceptron model ID");
  expect(() =>
    readyInceptronModel({
      models_dev: { base_model: "zhipuai/not-a-real-model", reasoning_options: [] },
      supported_sampling_parameters: [],
    })
  ).toThrow("missing base model");
  expect(() =>
    readyInceptronModel({ pricing: { prompt: "1e-6", completion: "0.1" } })
  ).toThrow("Invalid Inceptron per-token price");
  expect(() => readyInceptronModel({ input_modalities: ["text", "binary"] }))
    .toThrow("unsupported input modality");
  expect(() =>
    readyInceptronModel({
      models_dev: { base_model: "zhipuai/glm-5.2", reasoning_options: [] },
    })
  ).toThrow("reasoning_effort exactly when effort options are exposed");
});

test("ignores not-ready Inceptron models while validating every ready model", () => {
  const ready = inceptronModel();
  const notReady = inceptronModel({
    id: "staged/model",
    is_ready: false,
    models_dev: undefined,
    input_modalities: ["unsupported-but-ignored"],
    pricing: { prompt: "malformed", completion: "malformed" },
  });
  expect(parseInceptronModels({ object: "list", data: [ready, notReady] })).toHaveLength(1);

  expect(() =>
    parseInceptronModels({
      object: "list",
      data: [ready, inceptronModel({ id: "ready/model", models_dev: undefined })],
    })
  ).toThrow("missing models_dev metadata");
});

test("syncs authoritative Inceptron additions, updates, and removals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-inceptron-"));
  const modelsDir = path.join(root, "providers", "inceptron", "models");
  await mkdir(modelsDir, { recursive: true });
  await copyFile(
    path.join(import.meta.dirname, "..", "..", "..", "providers", "inceptron", "provider.toml"),
    path.join(root, "providers", "inceptron", "provider.toml"),
  );
  for (const base of ["zhipuai/glm-5.2", "moonshotai/kimi-k2.6"]) {
    const destination = path.join(root, "models", `${base}.toml`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(import.meta.dirname, "..", "..", "..", "models", `${base}.toml`), destination);
  }

  let source: ReadyInceptronModel[] = [
    readyInceptronModel(),
    readyInceptronModel({
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      context_length: 262_144,
      max_output_length: 262_144,
      input_modalities: ["text", "image"],
      supported_sampling_parameters: ["temperature"],
      models_dev: {
        base_model: "moonshotai/kimi-k2.6",
        reasoning_options: [],
        interleaved: true,
      },
    }),
  ];
  const provider: SyncProvider<ReadyInceptronModel> = {
    id: "inceptron-test",
    name: "Inceptron test",
    modelsDir,
    async fetchModels() {
      return source;
    },
    parseModels(raw) {
      return raw as ReadyInceptronModel[];
    },
    translateModel(model) {
      return { id: model.id, model: buildInceptronModel(model) };
    },
  };

  try {
    const initial = await syncProvider(provider);
    expect(initial).toMatchObject({ created: 2, updated: 0, deleted: 0 });

    source = [readyInceptronModel({
      pricing: { prompt: "0.0000008", completion: "0.0000029" },
    })];
    const changed = await syncProvider(provider);
    expect(changed).toMatchObject({ created: 0, updated: 1, deleted: 1 });

    const unchanged = await syncProvider(provider);
    expect(unchanged).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs CrossModel's structured-output capability", () => {
  const supported = buildCrossModel(crossModelModel(), undefined);
  const unsupported = buildCrossModel(
    crossModelModel({
      id: "qwen/qwen3.7-flash",
      capabilities: { json: false, reasoning: { toggle: true } },
    }),
    undefined,
  );
  const preserved = buildCrossModel(
    crossModelModel({ capabilities: { reasoning: { toggle: true } } }),
    {
      base_model: "alibaba/qwen3.8-max",
      structured_output: true,
    },
  );

  expect(supported).toMatchObject({
    base_model: "alibaba/qwen3.8-max",
    structured_output: true,
  });
  expect(unsupported).toMatchObject({
    base_model: "alibaba/qwen3.7-flash",
    structured_output: false,
  });
  expect(preserved).toMatchObject({
    base_model: "alibaba/qwen3.8-max",
    structured_output: true,
  });
});

test("clears stale CrossModel context tiers only when source pricing is usable", () => {
  const existing: ExistingModel = {
    base_model: "alibaba/qwen3.8-max",
    cost: {
      input: 9,
      output: 27,
      tiers: [
        {
          tier: { type: "context", size: 200_000 },
          input: 18,
          output: 54,
        },
      ],
    },
  };

  const authoritative = buildCrossModel(crossModelModel(), existing);
  const absent = buildCrossModel(crossModelModel({ pricing: undefined }), existing);
  const unusable = buildCrossModel(
    crossModelModel({
      pricing: {
        tiers: [{ threshold: 0, input_micro_per_1m: 1_880_000 }],
      },
    }),
    existing,
  );

  expect(authoritative?.cost).toEqual({ input: 1.88, output: 5.63 });
  expect(absent?.cost).toEqual(existing.cost);
  expect(unusable?.cost).toEqual(existing.cost);
});

test("parses CrossModel's nullable reasoning controls", () => {
  const parsed = CrossModelResponse.parse({
    data: [
      {
        ...crossModelModel(),
        capabilities: {
          reasoning: {
            supported: true,
            toggle: null,
            effort: null,
            budget_tokens: null,
          },
        },
      },
    ],
  });

  expect(parsed.data[0]?.capabilities?.reasoning).toEqual({
    supported: true,
    toggle: undefined,
    effort: undefined,
    budget_tokens: undefined,
  });
});

test("preserves CrossModel's toggle-only reasoning control", () => {
  const model = buildCrossModel(crossModelModel(), undefined);
  expect(model?.reasoning_options).toEqual([{ type: "toggle" }]);
});

test.each([{ off: false }, { off: true }])("syncs CrossModel's reasoning controls (effort includes none: $off)", ({ off }) => {
  const effort = off ? ["none", "low", "high", "max"] as const : ["low", "high", "max"] as const;
  const model = buildCrossModel(
    crossModelModel({
      capabilities: {
        json: true,
        reasoning: {
          supported: true,
          toggle: true,
          effort: [...effort],
          budget_tokens: { min: 1_024, max: 32_000 },
        },
      },
    }),
    undefined,
  );

  expect(model).toMatchObject({
    reasoning_options: [
      ...off ? [] : [{ type: "toggle" }],
      { type: "effort", values: effort },
      { type: "budget_tokens", min: 1_024, max: 32_000 },
    ],
  });
});

test("syncs CrossModel's catalog structured output, lifecycle and effort order", () => {
  const model = buildCrossModel(
    crossModelModel({
      capabilities: {
        structured_output: { json_schema: false },
        reasoning: { supported: true, effort: ["xhigh", "low", "medium"] },
      },
      identity: { release_stage: "deprecated" },
    }),
    { base_model: "alibaba/qwen3.8-max", structured_output: true, knowledge: "2020-01" },
  );
  const unknown = buildCrossModel(
    crossModelModel({ capabilities: { structured_output: { json_schema: null } } }),
    { base_model: "alibaba/qwen3.8-max", structured_output: true, status: "beta" },
  );

  expect(model).toMatchObject({
    structured_output: false,
    status: "deprecated",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "xhigh"] }],
  });
  expect(model).not.toHaveProperty("knowledge");
  expect(unknown).toMatchObject({ structured_output: true, status: "beta" });
});

test("syncs CrossModel's prompt caching flag into v2 files only", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const caching = crossmodel.translateModel(
    crossModelModel({ capabilities: { context: { caching: true } } }),
    context,
  );
  const unknown = crossmodel.translateModel(
    crossModelModel({ capabilities: { context: { caching: null } } }),
    context,
  );

  expect(caching).toMatchObject({ v2Set: { "capabilities.cache": expect.any(Function) } });
  expect(unknown && "v2Set" in unknown ? unknown.v2Set : undefined).toBeUndefined();
});

test("rejects unknown CrossModel reasoning efforts", () => {
  expect(() =>
    CrossModelResponse.parse({
      data: [
        {
          ...crossModelModel(),
          capabilities: {
            reasoning: { supported: true, effort: ["unexpected"] },
          },
        },
      ],
    })
  ).toThrow();
});

test("syncs NanoGPT's verified reasoning, pricing, limits, and open-weight metadata", () => {
  const model = buildNanoGptModel(nanoGptModel({
    pricing: {
      prompt: 0.42,
      completion: 1.32,
      cacheReadInputPer1kTokens: null,
    },
  }), {
    cost: { input: 0.9, output: 2.7, cache_read: 0.2 },
    limit: { context: 1_000_000, input: 1_000_000, output: 128_000 },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    open_weights: true,
    cost: { input: 0.42, output: 1.32, cache_read: 0.2 },
    limit: { context: 500_000, input: 500_000, output: 64_000 },
  });
});

test("does not invent NanoGPT reasoning controls or absent prices", () => {
  const fixedReasoning = buildNanoGptModel(nanoGptModel({
    id: "example/fixed-reasoner",
    reasoning_efforts: null,
    open_weights: null,
    pricing: {
      prompt: null,
      completion: null,
      cacheReadInputPer1kTokens: null,
      cacheWriteInputPer1kTokens: null,
    },
  }), undefined);
  const variablePricing = buildNanoGptModel(nanoGptModel({
    id: "example/omni-model",
    pricing: { note: "varies_by_modality" },
  }), undefined);
  const free = buildNanoGptModel(nanoGptModel({
    id: "example/free-model",
    pricing: { prompt: 0, completion: 0 },
  }), undefined);
  const invalid = buildNanoGptModel(nanoGptModel({
    id: "example/invalid-pricing",
    pricing: { prompt: -1, completion: 1, cacheReadInputPer1kTokens: -1 },
  }), { cost: { input: 0.9, output: 2.7, cache_read: 0.2 } });

  expect(fixedReasoning).toMatchObject({ reasoning: true, reasoning_options: [] });
  expect(fixedReasoning?.cost).toBeUndefined();
  expect(variablePricing?.cost).toBeUndefined();
  expect(free?.cost).toEqual({ input: 0, output: 0 });
  expect(invalid?.cost).toEqual({ input: 0.9, output: 2.7, cache_read: 0.2 });
});

test("accepts only NanoGPT's supported reasoning effort values", () => {
  expect(NanoGptResponse.safeParse({
    data: [nanoGptModel({ reasoning_efforts: ["none", "max"] })],
  }).success).toBe(true);
  expect(NanoGptResponse.safeParse({
    data: [{ ...nanoGptModel(), reasoning_efforts: ["low", null] }],
  }).success).toBe(false);
  expect(NanoGptResponse.safeParse({
    data: [{ ...nanoGptModel(), reasoning_efforts: ["default"] }],
  }).success).toBe(false);
  expect(NanoGptResponse.safeParse({ data: [] }).success).toBe(false);
});

test("normalizes authoritative NanoGPT reasoning efforts and preserves incomplete controls", () => {
  const contradictory = buildNanoGptModel(nanoGptModel({
    capabilities: { reasoning: false },
    reasoning_efforts: ["high", "low", "high"],
  }), undefined);
  const incomplete = buildNanoGptModel(nanoGptModel({
    capabilities: { reasoning: true },
    reasoning_efforts: [],
  }), {
    reasoning: true,
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }],
  });

  expect(contradictory).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  });
  expect(incomplete).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }],
  });
});

test("factors NanoGPT variants against canonical models without retaining wrong intrinsic metadata", () => {
  expect(resolveNanoGptBaseModel("zai-org/glm-5.2:thinking")).toBe("zhipuai/glm-5.2");
  expect(resolveNanoGptBaseModel("TEE/qwen3.6-35b-a3b")).toBe("alibaba/qwen3.6-35b-a3b");
  expect(resolveNanoGptBaseModel("TEE/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  expect(resolveNanoGptBaseModel("TEE/kimi-k2.5")).toBe("moonshotai/kimi-k2.5");
  expect(resolveNanoGptBaseModel("TEE/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
  expect(resolveNanoGptBaseModel("TEE/gemma-4-31b-it")).toBe("google/gemma-4-31b-it");
  expect(resolveNanoGptBaseModel("cohere/north-mini-code")).toBe("cohere/north-mini-code-1-0");
  expect(resolveNanoGptBaseModel("doubao-seed-2-0-code-preview-260215"))
    .toBe("bytedance-seed/seed-2.0-code");
  expect(resolveNanoGptBaseModel("xiaomi/mimo-v2.5-pro-ultraspeed"))
    .toBe("xiaomi/mimo-v2.5-pro-ultraspeed");
  expect(resolveNanoGptBaseModel("claude-haiku-4-5-20251001-thinking"))
    .toBe("anthropic/claude-haiku-4-5-20251001");
  expect(resolveNanoGptBaseModel("claude-sonnet-4-thinking:8192"))
    .toBe("anthropic/claude-sonnet-4-0");
  expect(resolveNanoGptBaseModel("anthropic/claude-opus-4.6:thinking:low"))
    .toBe("anthropic/claude-opus-4-6");
  expect(resolveNanoGptBaseModel("anthropic/claude-opus-4.6:thinking:thinking:max"))
    .toBe("anthropic/claude-opus-4-6");
  expect(resolveNanoGptBaseModel("gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
  expect(resolveNanoGptBaseModel("qwen3.5-27b")).toBe("alibaba/qwen3.5-27b");
  expect(resolveNanoGptBaseModel("moonshotai/kimi-k2-thinking"))
    .toBe("moonshotai/kimi-k2-thinking");
  expect(resolveNanoGptBaseModel("qwen/qwen3-next-80b-a3b-thinking"))
    .toBe("alibaba/qwen3-next-80b-a3b-thinking");

  const additionalCanonicalIDs = new Map([
    ["poolside/laguna-s-2.1", "poolside/laguna-s-2.1"],
    ["poolside/laguna-s-2.1:thinking", "poolside/laguna-s-2.1"],
    ["longcat-2.0", "meituan/longcat-2.0"],
    ["longcat-2.0:thinking", "meituan/longcat-2.0"],
    ["stepfun-ai/step-3.5-flash-2603", "stepfun/step-3.5-flash-2603"],
    ["stepfun-ai/step-3.5-flash", "stepfun/step-3.5-flash"],
    ["Qwen/Qwen3-Next-80B-A3B-Instruct", "alibaba/qwen3-next-80b-a3b-instruct"],
    ["Qwen/Qwen3.6-35B-A3B", "alibaba/qwen3.6-35b-a3b"],
    ["Qwen/Qwen3.6-35B-A3B:thinking", "alibaba/qwen3.6-35b-a3b"],
    ["sonar-pro", "perplexity/sonar-pro"],
    ["sonar-reasoning-pro", "perplexity/sonar-reasoning-pro"],
    ["sonar", "perplexity/sonar"],
    ["zai-org/GLM-4.5:thinking", "zhipuai/glm-4.5"],
    ["zai-org/GLM-4.5-Air", "zhipuai/glm-4.5-air"],
    ["zai-org/GLM-4.5-Air:thinking", "zhipuai/glm-4.5-air"],
    ["poolside/laguna-m.1", "poolside/laguna-m.1"],
    ["nvidia/Llama-3.3-Nemotron-Super-49B-v1", "nvidia/llama-3.3-nemotron-super-49b-v1"],
    ["sarvam-30b", "sarvam/sarvam-30b"],
    ["sarvam-105b", "sarvam/sarvam-105b"],
  ]);
  for (const [id, canonical] of additionalCanonicalIDs) {
    expect(resolveNanoGptBaseModel(id)).toBe(canonical);
  }

  const north = buildNanoGptModel(nanoGptModel({
    id: "cohere/north-mini-code",
    name: "North Mini Code",
    open_weights: null,
  }), {
    open_weights: false,
    limit: { context: 256_000, input: 256_000, output: 64_000 },
  });

  expect(north).toMatchObject({ base_model: "cohere/north-mini-code-1-0" });
  expect(north).not.toHaveProperty("open_weights");
});

test("factored NanoGPT models inherit missing intrinsic metadata without zero overrides", () => {
  const sparse = buildNanoGptModel(nanoGptModel({
    id: "google/gemini-2.5-pro",
    name: null,
    description: null,
    created: null,
    context_length: null,
    max_output_tokens: null,
    architecture: undefined,
    capabilities: undefined,
    reasoning_efforts: null,
    open_weights: false,
    pricing: undefined,
  }), undefined);

  expect(sparse).toMatchObject({ base_model: "google/gemini-2.5-pro" });
  expect(sparse).not.toHaveProperty("name");
  expect(sparse).not.toHaveProperty("family");
  expect(sparse).not.toHaveProperty("release_date");
  expect(sparse).not.toHaveProperty("attachment");
  expect(sparse).not.toHaveProperty("reasoning");
  expect(sparse).not.toHaveProperty("tool_call");
  expect(sparse).not.toHaveProperty("open_weights");
  expect(sparse).not.toHaveProperty("limit");
  expect(sparse).not.toHaveProperty("modalities");
});

test("NanoGPT base_model routes use the context window when no source states an output limit", () => {
  const model = buildNanoGptModel(nanoGptModel({
    id: "aleph-alpha/kolibri-1",
    context_length: 1_048_576,
    max_output_tokens: null,
  }), undefined);

  expect(model).toMatchObject({
    base_model: "aleph-alpha/kolibri-1",
    limit: { output: 1_048_576 },
  });
});

test("new NanoGPT text models use the context window when no output limit is stated", () => {
  const text = buildNanoGptModel(nanoGptModel({
    id: "example/unlisted-model",
    context_length: 30_000,
    max_output_tokens: null,
  }), undefined);
  const decision = buildNanoGptModel(nanoGptModel({
    id: "example/decision-model",
    context_length: 32_768,
    max_output_tokens: 0,
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
  }), undefined);

  expect(text).toMatchObject({ limit: { context: 30_000, output: 30_000 } });
  expect(decision).toBeUndefined();
});

test("NanoGPT base_model files leave model facts to the lab", () => {
  const model = buildNanoGptModel(nanoGptModel({
    id: "google/gemini-2.5-pro",
    created: 1_790_208_000,
    open_weights: true,
  }), {
    base_model: "google/gemini-2.5-pro",
    family: "gemini",
    release_date: "2024-01-01",
    last_updated: "2024-01-01",
    knowledge: "2023-01",
    open_weights: true,
    limit: { context: 1_048_576, output: 65_536 },
  });

  expect(model).toMatchObject({ base_model: "google/gemini-2.5-pro" });
  for (const key of ["family", "release_date", "last_updated", "knowledge", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
});

test("preserves route-specific NanoGPT names when first factoring existing models", () => {
  const thinking = buildNanoGptModel(nanoGptModel({
    id: "claude-opus-4-thinking:8192",
    name: "Claude 4 Opus Thinking (8K)",
  }), {
    name: "Claude 4 Opus Thinking (8K)",
    limit: { context: 200_000, input: 200_000, output: 32_000 },
  });
  const tee = buildNanoGptModel(nanoGptModel({
    id: "TEE/glm-5",
    name: "GLM 5 TEE",
  }), undefined);

  expect(thinking).toMatchObject({
    base_model: "anthropic/claude-opus-4-0",
    name: "Claude 4 Opus Thinking (8K)",
  });
  expect(tee).toMatchObject({
    base_model: "zhipuai/glm-5",
    name: "GLM 5 TEE",
  });
});

test("preserves API-silent NanoGPT overrides when first factoring existing models", () => {
  const model = buildNanoGptModel(nanoGptModel({
    id: "anthropic/claude-sonnet-4.6",
    context_length: 1_000_000,
    max_output_tokens: null,
    architecture: undefined,
    capabilities: undefined,
    reasoning_efforts: null,
  }), {
    reasoning: false,
    structured_output: true,
    limit: { context: 1_000_000, input: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-6",
    reasoning: false,
    structured_output: true,
    limit: { output: 128_000 },
  });
});

test("preserves explicit NanoGPT route overrides while inheriting absent base fields", () => {
  const model = buildNanoGptModel(nanoGptModel({
    id: "google/gemini-2.5-pro",
    context_length: 500_000,
    max_output_tokens: null,
    architecture: { input_modalities: ["text", "image"] },
    capabilities: { tool_calling: false },
    open_weights: false,
  }), {
    provider: { body: { route: "secure" } },
    experimental: {
      modes: { fast: { provider: { body: { speed: "fast" } } } },
    },
  });

  expect(model).toMatchObject({
    base_model: "google/gemini-2.5-pro",
    tool_call: false,
    provider: { body: { route: "secure" } },
    experimental: {
      modes: { fast: { provider: { body: { speed: "fast" } } } },
    },
    limit: { context: 500_000, input: 500_000 },
    modalities: { input: ["text", "image"] },
  });
  expect(model).not.toHaveProperty("limit.output");
  expect(model).not.toHaveProperty("modalities.output");
  expect(model).not.toHaveProperty("open_weights");

  const textOnly = buildNanoGptModel(nanoGptModel({
    id: "google/gemini-2.5-pro",
    architecture: undefined,
    capabilities: { vision: false },
  }), undefined);
  expect(textOnly).toMatchObject({
    base_model: "google/gemini-2.5-pro",
    attachment: false,
    modalities: { input: ["text"] },
  });
});

test("preserves standalone modalities and skips incomplete new standalone models", () => {
  const existing = buildNanoGptModel(nanoGptModel({
    id: "example/sparse-existing",
    created: null,
    context_length: null,
    max_output_tokens: null,
    architecture: undefined,
    capabilities: undefined,
    pricing: undefined,
  }), {
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: true,
    provider: { body: { route: "secure" } },
    experimental: {
      modes: { fast: { provider: { body: { speed: "fast" } } } },
    },
    limit: { context: 100_000, input: 90_000, output: 10_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
  const missing = buildNanoGptModel(nanoGptModel({
    id: "example/sparse-new",
    created: null,
    context_length: null,
    max_output_tokens: null,
    architecture: undefined,
    capabilities: undefined,
    pricing: undefined,
  }), undefined);

  expect(existing).toMatchObject({
    attachment: true,
    provider: { body: { route: "secure" } },
    experimental: {
      modes: { fast: { provider: { body: { speed: "fast" } } } },
    },
    limit: { context: 100_000, input: 90_000, output: 10_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
  expect(missing).toBeUndefined();
});

test("NanoGPT sync deletes missing downstream entries and never emits internal providers", () => {
  const source = nanoGptModel({ providers: ["private-upstream"] });
  const model = buildNanoGptModel(source, undefined);

  expect((nanoGpt as SyncProvider<NanoGptModel>).deleteMissing).toBeUndefined();
  expect(model).not.toHaveProperty("providers");
});

test("NanoGPT sync drops stale descriptions while first factoring existing models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-nano-gpt-"));
  const modelsDir = path.join(dir, "providers", "nano-gpt", "models");
  const modelPath = path.join(modelsDir, "anthropic", "claude-sonnet-4.6.toml");
  const metadataPath = path.join(dir, "models", "anthropic", "claude-sonnet-4-6.toml");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await Bun.write(modelPath, [
    "schema = 2",
    'description = "Stale provider description"',
    "",
    "[capabilities]",
    "reasoning = { supported = false }",
    "structured_output = true",
    "",
    "[limit]",
    "context = 1_000_000",
    "input = 1_000_000",
    "output = 128_000",
    "",
  ].join("\n"));
  await Bun.write(metadataPath, [
    "schema = 2",
    'name = "Claude Sonnet 4.6"',
    'description = "Canonical description"',
    "open_weights = false",
    'release_date = "2026-02-17"',
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = true }",
    "temperature = true",
    "top_p = true",
    "top_k = true",
    "",
    "[limit]",
    "context = 1_000_000",
    "output = 64_000",
    "",
  ].join("\n"));

  try {
    await syncProvider({
      ...nanoGpt,
      modelsDir,
      async fetchModels() {
        return {
          data: [nanoGptModel({
            id: "anthropic/claude-sonnet-4.6",
            description: null,
            max_output_tokens: null,
            capabilities: undefined,
            reasoning_efforts: null,
          })],
        };
      },
    });

    const content = await readFile(modelPath, "utf8");
    expect(content).toContain('base_model = "anthropic/claude-sonnet-4-6"');
    expect(content).not.toContain("Stale provider description");
    expect(content).toContain("reasoning = { supported = false }");
    expect(content).toContain("structured_output = true");
    expect(content).toContain("output = 128_000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const anthropicPricingMarkdown = `
## Model pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([deprecated](/deprecated)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 [through August 31, 2026](/pricing) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |

## Cloud platform pricing
`;

test("parses current and future Anthropic pricing rows", () => {
  const introductory = parseAnthropicPricing(anthropicPricingMarkdown, new Date("2026-07-04T00:00:00Z"));
  expect(introductory.get("claude sonnet 5")).toMatchObject({
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  });
  expect(introductory.get("claude opus 4.1")?.deprecated).toBe(true);

  const standard = parseAnthropicPricing(anthropicPricingMarkdown, new Date("2026-09-01T00:00:00Z"));
  expect(standard.get("claude sonnet 5")).toMatchObject({ input: 3, output: 15 });
});

test.each([
  "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
  "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits & refreshes | Output tokens |",
  "| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits and Refreshes | Output Tokens |",
])("parses Anthropic pricing with header %s", (header) => {
  const markdown = anthropicPricingMarkdown.replace(/^\| Model \|.*$/m, header);
  const pricing = parseAnthropicPricing(markdown, new Date("2026-09-03T00:00:00Z"));

  expect(pricing.size).toBe(5);
  expect(pricing.get("claude opus 4.8")).toEqual({
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    deprecated: false,
  });
});

test.each([
  "Model",
  "Base Input Tokens",
  "5m Cache Writes",
  "Cache Hits & Refreshes",
  "Output Tokens",
])("rejects Anthropic pricing without the %s column", (column) => {
  const markdown = anthropicPricingMarkdown.replace(`| ${column} |`, "| Unknown |");

  expect(() => parseAnthropicPricing(markdown)).toThrow("Anthropic model pricing table has unexpected columns");
});

test("syncs Anthropic capabilities and exact effort levels", () => {
  const model = buildAnthropicModel(anthropicModel(), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ],
    structured_output: true,
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
});

test("adds manual budget control for new Anthropic models", () => {
  const model = buildAnthropicModel(anthropicModel({
    capabilities: {
      thinking: {
        supported: true,
        types: { enabled: { supported: true } },
      },
    },
  }), undefined, "anthropic/claude-sonnet-5");

  expect(model.reasoning_options).toEqual([{ type: "budget_tokens" }]);
});

test("labels Anthropic aliases as latest", () => {
  const model = buildAnthropicModel(anthropicModel({
    id: "claude-sonnet-5",
    canonical_id: "claude-sonnet-5-20260630",
  }), undefined, "anthropic/claude-sonnet-5");

  expect(model.name).toBe("Claude Sonnet 5 (latest)");
});

test("Anthropic sync preserves base model inheritance", () => {
  const resolved = {
    base_model: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5 (latest)",
    description: "Flagship Claude model",
    release_date: "2025-11-24",
    last_updated: "2025-11-24",
    attachment: true,
    reasoning: true,
    tool_call: true,
    knowledge: "2025-05",
    open_weights: false,
    cost: { input: 5, output: 25 },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text" as const, "image" as const], output: ["text" as const] },
  };
  const translated = anthropic.translateModel(anthropicModel({
    id: "claude-opus-4-5",
    canonical_id: "claude-opus-4-5-20251101",
    display_name: "Claude Opus 4.5",
    created_at: "2025-11-24T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
  }), {
    existing: () => resolved,
    authored: () => ({ base_model: "anthropic/claude-opus-4-5" }),
  });

  expect(translated?.model).toMatchObject({
    base_model: "anthropic/claude-opus-4-5",
  });
  // Name matches models/anthropic/claude-opus-4-5.toml, so factoring omits it.
  expect(translated?.model).not.toHaveProperty("name");
  expect(translated?.model).not.toHaveProperty("knowledge");
  expect(translated?.model).not.toHaveProperty("release_date");
});

test("Anthropic factored models omit inherited fields and keep authored fast mode", () => {
  const model = buildAnthropicModel(
    anthropicModel({
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      created_at: "2026-07-24T00:00:00Z",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: { supported: true },
      },
    }),
    {
      base_model: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      description: "Strongest Claude Opus model for coding, agents, and professional work",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      structured_output: true,
      tool_call: true,
      open_weights: false,
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      experimental: {
        modes: {
          fast: {
            cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
            provider: {
              body: { speed: "fast" },
              headers: { "anthropic-beta": "fast-mode-2026-02-01" },
            },
          },
        },
      },
    },
    "anthropic/claude-opus-5",
  );

  expect(model).toMatchObject({
    base_model: "anthropic/claude-opus-5",
    structured_output: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    experimental: {
      modes: {
        fast: {
          cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        },
      },
    },
  });
  expect(model).not.toHaveProperty("attachment");
  expect(model).not.toHaveProperty("reasoning");
  expect(model).not.toHaveProperty("limit");
  expect(model).not.toHaveProperty("modalities");
  expect(model).not.toHaveProperty("name");
});

test("filters customer-owned OpenAI models from availability tracking", () => {
  expect(parseOpenAIModels({
    object: "list",
    data: [
      { id: "gpt-5.5", object: "model", created: 1, owned_by: "system" },
      { id: "ft:gpt-5.5:org:custom", object: "model", created: 2, owned_by: "org-example" },
      { id: "custom-model", object: "model", created: 3, owned_by: "org-example" },
    ],
  }).map((model) => model.id)).toEqual(["gpt-5.5"]);
});

test("OpenAI availability sync preserves authored metadata", () => {
  const authored = {
    base_model: "openai/gpt-5.5",
    cost: { input: 5, output: 30 },
  };
  expect(openai.translateModel(
    { id: "gpt-5.5", object: "model", created: 1, owned_by: "system" },
    { existing: () => authored as never, authored: () => authored },
  )).toEqual({ id: "gpt-5.5", model: authored });
});

test("OpenAI availability sync retains models absent from a scoped response", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-openai-"));
  const modelsDir = path.join(dir, "providers", "openai", "models");
  await Bun.write(path.join(modelsDir, "gpt-existing.toml"), [
    "schema = 2",
    'name = "Existing GPT"',
    'release_date = "2026-01-01"',
    "open_weights = false",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = false }",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[cost.text.input]",
    "price = 1",
    "",
    "[cost.text.output]",
    "price = 2",
    "",
  ].join("\n"));

  try {
    const result = await syncProvider({
      ...openai,
      modelsDir,
      async fetchModels() {
        return {
          object: "list",
          data: [{ id: "gpt-scoped", object: "model", created: 1, owned_by: "system" }],
        };
      },
    });
    expect(result.deleted).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(await Bun.file(path.join(modelsDir, "gpt-existing.toml")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracks missing models except for unreliable first-party inventories", () => {
  expect(google.skipCreates).toBe(true);
  expect(google.trackMissingModels).toBe(false);
  expect(openai.skipCreates).toBe(true);
  expect(openai.trackMissingModels).toBe(false);
  expect(pioneer.skipCreates).toBe(true);
  expect(pioneer.trackMissingModels).toBe(true);
  expect(ofox.skipCreates).toBe(true);
  expect(ofox.trackMissingModels).toBe(true);
  expect(tinfoil.skipCreates).toBe(true);
  expect(tinfoil.trackMissingModels).not.toBe(false);
  expect(xai.skipCreates).toBe(true);
  expect(xai.trackMissingModels).not.toBe(false);
});

function pioneerCatalogModel(id: string, efforts: string[]) {
  const [model] = pioneer.parseModels({
    data: [{
      id,
      display_name: id,
      created: 1_704_067_200,
      max_input_tokens: 8_192,
      max_tokens: 4_096,
      input_price_per_million: 0.03,
      output_price_per_million: 0,
      capabilities: { thinking: { supported: false } },
    }],
    models: [{ slug: id, supported_reasoning_levels: efforts.map((effort) => ({ effort })) }],
  });
  return model!;
}

test("Pioneer sync sorts catalog reasoning levels low to high", () => {
  const model = pioneerCatalogModel("fastino/example-decoder", ["xhigh", "high", "low", "medium"]);
  const existing = { name: "Example", reasoning: true } as ExistingModel;
  const translated = pioneer.translateModel(model, { existing: () => existing, authored: () => existing });
  expect(translated?.model).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
  });
});

test("Pioneer sync keeps an authored non-reasoning file despite the catalog's boilerplate levels", () => {
  // Encoders (GLiNER) list the same reasoning levels as decoders in /v1/models.
  const model = pioneerCatalogModel("fastino/gliner2-base-v1", ["low", "medium", "high"]);
  const existing = { name: "GLiNER2 Base", reasoning: false, tool_call: false } as ExistingModel;
  const translated = pioneer.translateModel(model, { existing: () => existing, authored: () => existing });
  expect(translated?.model).toMatchObject({ reasoning: false, tool_call: false });
  expect((translated?.model as ExistingModel).reasoning_options).toBeUndefined();
  expect((translated?.model as ExistingModel).interleaved).toBeUndefined();
});

test("keeps xAI voice models that no models endpoint lists", () => {
  const models = xai.parseModels({ models: [] });
  const voice = models.find((model) => model.id === "grok-voice-3.0");
  expect(voice).toBeDefined();
  expect(xai.sourceID(voice!)).toBeUndefined();

  const authored = { base_model: "xai/grok-voice-3.0", reasoning: true };
  const context = {
    existing: () => undefined,
    authored: (id: string) => (id === "grok-voice-3.0" ? authored : undefined),
  } as any;
  expect(xai.translateModel(voice!, context)).toEqual({ id: "grok-voice-3.0", model: authored });
  expect(xai.translateModel(models.find((model) => model.id === "grok-tts")!, context)).toBeUndefined();
});

test("tracks public Google model families but not opaque internal IDs", () => {
  expect(shouldTrackGoogleModel("gemini-3.1-flash-live-preview")).toBe(true);
  expect(shouldTrackGoogleModel("imagen-4.0-generate-001")).toBe(true);
  expect(shouldTrackGoogleModel("veo-3.1-generate-preview")).toBe(true);
  expect(shouldTrackGoogleModel("ajax")).toBe(false);
  expect(shouldTrackGoogleModel("perseus-2")).toBe(false);
  expect(shouldTrackGoogleModel("thorin")).toBe(false);
});

test.each([
  ["gemini-2.5-computer-use-preview-10-2025", 128_000, 64_000],
  ["gemini-3-pro-image", 65_536, 32_768],
  ["gemini-3.1-flash-image", 131_072, 32_768],
  ["gemini-3.1-flash-lite-image", 65_536, 4_096],
])("preserves the %s model-card limits during Google sync", (id, context, output) => {
  const existing: ExistingModel = {
    base_model: `google/${id}`,
    name: id,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: true,
    reasoning: true,
    tool_call: false,
    open_weights: false,
    limit: { context, output },
    modalities: { input: ["text", "image"], output: ["text", "image"] },
  };
  const built = buildGoogleModel({
    name: `models/${id}`,
    inputTokenLimit: 65_536,
    outputTokenLimit: 65_536,
  }, existing);

  expect(built).toMatchObject({ base_model: `google/${id}` });
  expect(built).not.toHaveProperty("limit");
});

function tinfoilModel(overrides: Partial<TinfoilModel> = {}): TinfoilModel {
  return {
    id: "glm-5-2",
    object: "model",
    owned_by: "tinfoil",
    name: "GLM-5.2",
    created: 1_775_088_000,
    context_window: 384_000,
    pricing: {
      inputTokenPricePer1M: 1.5,
      outputTokenPricePer1M: 5.25,
      cachedInputTokenPricePer1M: 0.375,
      requestPrice: 0,
    },
    reasoning: true,
    tool_calling: true,
    multimodal: false,
    type: "chat",
    ...overrides,
  };
}

const existingTinfoilGLM: ExistingModel = {
  base_model: "zhipuai/glm-5.2",
  name: "GLM-5.2",
  description: "Flagship GLM model for agentic engineering and coding",
  family: "glm",
  release_date: "2026-04-02",
  last_updated: "2026-04-02",
  attachment: false,
  reasoning: true,
  reasoning_options: [{
    type: "effort",
    values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  }],
  temperature: true,
  tool_call: true,
  structured_output: true,
  open_weights: true,
  cost: { input: 1.5, output: 5.25 },
  limit: { context: 384_000, output: 131_072 },
  modalities: { input: ["text"], output: ["text"] },
};

test("syncs Tinfoil cached-input pricing from the public model catalog", () => {
  const model = buildTinfoilModel(tinfoilModel(), existingTinfoilGLM);

  expect(model).toMatchObject({
    base_model: "zhipuai/glm-5.2",
    cost: {
      input: 1.5,
      output: 5.25,
      cache_read: 0.375,
    },
    limit: { context: 384_000 },
  });
});

test.each([undefined, "zhipuai/glm-5.2"])("syncs Tinfoil reasoning with base model %s", (base_model) => {
  const existing = { ...existingTinfoilGLM, base_model };
  const enabled = buildTinfoilModel(tinfoilModel(), { ...existing, reasoning: false });
  expect(enabled.reasoning_options).toEqual(existing.reasoning_options);
  // Factored models inherit true from the lab; standalone models must author it.
  expect(enabled.reasoning).toBe(base_model === undefined ? true : undefined);

  const disabled = buildTinfoilModel(tinfoilModel({ reasoning: false }), existing);
  expect(disabled.reasoning).toBe(false);
  expect(disabled.reasoning_options).toBeUndefined();
});

test("requires authored Tinfoil controls instead of inventing an empty set", () => {
  expect(() => buildTinfoilModel(tinfoilModel(), {
    ...existingTinfoilGLM,
    reasoning_options: undefined,
  })).toThrow("requires hand-authored reasoning_options");

  const model = buildTinfoilModel(tinfoilModel(), {
    ...existingTinfoilGLM,
    reasoning_options: [],
  });
  expect(model.reasoning_options).toEqual([]);
});

test("removes stale Tinfoil cache pricing when the public catalog omits it", () => {
  const model = buildTinfoilModel(tinfoilModel({
    pricing: {
      inputTokenPricePer1M: 1.5,
      outputTokenPricePer1M: 5.25,
      requestPrice: 0,
    },
  }), {
    ...existingTinfoilGLM,
    cost: { input: 1.5, output: 5.25, cache_read: 0.375 },
  });

  expect(model).toMatchObject({
    cost: { input: 1.5, output: 5.25 },
  });
  expect(model.cost).not.toHaveProperty("cache_read");
});

test("tracks new token-priced Tinfoil models but ignores per-request services", () => {
  expect(tinfoil.sourceID(tinfoilModel({ id: "new-chat-model" }))).toBe("new-chat-model");
  expect(tinfoil.sourceID(tinfoilModel({
    id: "websearch",
    context_window: undefined,
    type: "tool",
    pricing: {
      inputTokenPricePer1M: 0,
      outputTokenPricePer1M: 0,
      requestPrice: 0.05,
    },
  }))).toBeUndefined();
});

function digitalOceanModel(overrides: Partial<DigitalOceanSourceModel> = {}): DigitalOceanSourceModel {
  return {
    id: "anthropic-claude-4.6-sonnet",
    name: "Claude Sonnet 4.6",
    lifecycle_status: "active",
    type: "chat",
    thinking: true,
    reasoning_efforts: ["low", "medium", "high"],
    context_window: 1_000_000,
    max_output_tokens: 8_192,
    availability: ["serverless"],
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    settings: [{ name: "max_tokens", max: 64_000 }],
    created_at: "2026-02-17T00:00:00Z",
    pricing: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
    },
    ...overrides,
  };
}

test("sorts DigitalOcean reasoning efforts low to high", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    reasoning_efforts: ["max", "LOW", "x-high", "medium", "low"],
  }), undefined, undefined);

  expect(model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "xhigh", "max"] }],
  });
});

test("DigitalOcean base_model files leave model facts to the lab and keep a differing display name", () => {
  const existing = {
    base_model: "anthropic/claude-sonnet-4-6",
    family: "claude-sonnet" as const,
    release_date: "2020-01-01",
    last_updated: "2020-01-01",
    knowledge: "2020-01",
    open_weights: true,
  };
  const model = buildDigitalOceanModel(digitalOceanModel({ name: "Anthropic Claude Sonnet 4.6" }), existing);
  for (const key of ["family", "knowledge", "release_date", "last_updated", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
  expect(model).toMatchObject({ base_model: "anthropic/claude-sonnet-4-6", name: "Anthropic Claude Sonnet 4.6" });

  const same = buildDigitalOceanModel(digitalOceanModel({ name: "Claude Sonnet 4.6" }), existing);
  expect(same).not.toHaveProperty("name");
});

test("syncs DigitalOcean catalog limits and extended pricing thresholds", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    pricing: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      extended: {
        context: 272_000,
        input: 6,
        output: 22.5,
        cacheRead: 0.6,
        cacheWrite: 7.5,
      },
    },
  }), {
    name: "Claude Sonnet 4.6",
    description: "Curated DigitalOcean description",
    family: "claude-sonnet",
    release_date: "2026-02-17",
    last_updated: "2026-03-13",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    temperature: true,
    tool_call: true,
    open_weights: false,
    cost: {
      input: 2,
      output: 10,
      cache_read: 0.3,
      cache_write: 3.75,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 4,
        output: 15,
        cache_read: 0.6,
        cache_write: 7.5,
      }],
    },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    description: "Curated DigitalOcean description",
    last_updated: "2026-03-13",
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
      tiers: [{
        tier: { type: "context", size: 272_000 },
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write: 7.5,
      }],
    },
    limit: { context: 1_000_000, output: 8_192 },
  });
});

test("skips existing dedicated-only DigitalOcean models without token pricing", () => {
  const existing = {
    name: "Mistral 7B Instruct v0.3",
    description: "Mistral model for multilingual chat and dedicated inference",
    family: "mistral" as const,
    release_date: "2024-05-22",
    last_updated: "2024-05-22",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    open_weights: true,
    limit: { context: 32_768, output: 32_768 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const translated = digitalocean.translateModel(digitalOceanModel({
    id: "mistral-7b-instruct-v0.3",
    name: "Mistral 7B Instruct v0.3",
    thinking: false,
    context_window: 32_768,
    modalities: { input: ["text"], output: ["text"] },
    settings: [{ name: "max_tokens", max: 8_192 }],
    pricing: undefined,
  }), {
    existing: () => existing,
    authored: () => existing,
  });

  expect(translated).toBeUndefined();
});

test("syncs existing DigitalOcean image models with catalog output limits", () => {
  const existing = {
    name: "GPT Image 1.5",
    description: "Image generation model",
    family: "gpt-image" as const,
    release_date: "2025-11-25",
    last_updated: "2025-11-25",
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: false,
    open_weights: false,
    cost: { input: 5, output: 10 },
    limit: { context: 0, output: 0 },
    modalities: { input: ["text" as const, "image" as const], output: ["image" as const] },
  };
  const translated = digitalocean.translateModel(digitalOceanModel({
    id: "openai-gpt-image-1.5",
    name: "GPT Image 1.5",
    context_window: undefined,
    max_output_tokens: 16_384,
    modalities: { input: ["text", "image"], output: ["text", "image"] },
    settings: [],
    pricing: { input: 6, output: 12 },
  }), {
    existing: () => existing,
    authored: () => existing,
  });

  expect(translated?.model).toMatchObject({
    cost: { input: 6, output: 12 },
    limit: { context: 0, output: 16_384 },
  });
});

test("filters unmanaged DigitalOcean models and joins catalog data by ID", () => {
  const models = parseDigitalOceanModels({
    models: [
      digitalOceanModel({ id: "kimi-k2.5", name: "Kimi K2", pricing: undefined }),
      digitalOceanModel({
        id: "bge-m3",
        name: "BGE M3",
        type: "embedding",
        modalities: { input: ["text"], output: ["text"] },
        pricing: undefined,
      }),
    ],
    catalog: [
      {
        model_id: "kimi-k2.5",
        name: "Kimi K2.5",
        context_window: "256000",
        max_output_tokens: "32768",
        availability: ["serverless", "dedicated"],
        pricing: {
          input_price_per_million: 0.000000375,
          output_price_per_million: 0.000002025,
          cache_read_input_price_per_million: 0.000000203,
        },
        pricing_detail: {
          variants: [{
            tier: "MODEL_PRICING_TIER_EXTENDED_272K",
            mode: "MODEL_BILLING_MODE_INTERACTIVE",
            prices: {
              input_price_per_million: 0.00000075,
              output_price_per_million: 0.000003,
            },
          }],
        },
      },
      {
        model_id: "bge-m3",
        name: "BGE M3",
        availability: ["serverless"],
      },
    ],
  });

  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    id: "kimi-k2.5",
    context_window: "256000",
    max_output_tokens: "32768",
    pricing: {
      input: 0.375,
      output: 2.025,
      cacheRead: 0.203,
      extended: {
        context: 272_000,
        input: 0.75,
        output: 3,
      },
    },
  });
});

test("omits retired DigitalOcean models absent from the catalog even without lifecycle metadata", () => {
  const retired = [
    "anthropic-claude-3.7-sonnet",
    "anthropic-claude-3.5-sonnet",
    "anthropic-claude-3.5-haiku",
    "anthropic-claude-3-opus",
  ];
  const models = parseDigitalOceanModels({
    models: [
      ...retired.map((id) => ({ id, name: id, type: "chat" })),
      { id: "openai-gpt-6-1-sol", name: "OpenAI GPT-6.1 Sol", lifecycle_status: "active" },
    ],
    catalog: [{
      model_id: "openai-gpt-6-1-sol",
      name: "OpenAI GPT-6.1 Sol",
      context_window: "256000",
      max_output_tokens: "32768",
      availability: ["serverless"],
      modalities: { input: ["text"], output: ["text"] },
      pricing: { input_price_per_million: 0.000001, output_price_per_million: 0.000002 },
    }],
  });

  expect(models).toHaveLength(1);
  expect(models[0]?.id).toBe("openai-gpt-6-1-sol");
});

test("deprecates DigitalOcean models selected for sync without lifecycle metadata", () => {
  const [model] = parseDigitalOceanModels({
    models: [{ id: "example", name: "Example" }],
    catalog: [{
      model_id: "example",
      name: "Example",
      context_window: "128000",
      max_output_tokens: "8192",
      availability: ["serverless"],
      modalities: { output: ["text"] },
      pricing: { input_price_per_million: 0.000001, output_price_per_million: 0.000002 },
    }],
  });

  expect(buildDigitalOceanModel(model!, { status: "beta" }).status).toBe("deprecated");
  expect(buildDigitalOceanModel(model!).status).toBe("deprecated");
});

test("maps DigitalOcean 1M catalog pricing to its 200K threshold", () => {
  const models = parseDigitalOceanModels({
    models: [digitalOceanModel({ pricing: undefined })],
    catalog: [{
      model_id: "anthropic-claude-4.6-sonnet",
      name: "Claude Sonnet 4.6",
      context_window: "1000000",
      max_output_tokens: "64000",
      availability: ["serverless"],
      modalities: { input: ["text", "image"], output: ["text"] },
      pricing: {
        input_price_per_million: 0.000003,
        output_price_per_million: 0.000015,
      },
      pricing_detail: {
        variants: [{
          tier: "MODEL_PRICING_TIER_EXTENDED_1M",
          mode: "MODEL_BILLING_MODE_INTERACTIVE",
          prices: {
            input_price_per_million: 0.000006,
            output_price_per_million: 0.0000225,
          },
        }],
      },
    }],
  });

  expect(models[0]?.pricing?.extended).toEqual({
    context: 200_000,
    input: 6,
    output: 22.5,
    cacheRead: undefined,
    cacheWrite: undefined,
  });
});

function applyV2Set(set: Record<string, unknown>, doc: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = structuredClone(doc);
  for (const [key, value] of Object.entries(set)) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    const current = node[parts.at(-1)!];
    const next = typeof value === "function" ? value(structuredClone(current)) : value;
    if (next === undefined) delete node[parts.at(-1)!];
    else node[parts.at(-1)!] = next;
  }
  return out;
}

test("lists DigitalOcean Responses and Messages APIs from catalog capabilities", () => {
  const responses = { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } };
  const messages = { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } };
  const flagged = applyV2Set(digitalOceanV2Set(digitalOceanModel({ capabilities: ["responses"] })), {
    api: { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } },
  });
  expect(flagged.api).toEqual({
    "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } },
    responses,
    messages,
  });
  const hosted = applyV2Set(digitalOceanV2Set(digitalOceanModel({
    endpoints: [{ capabilities: ["chat_completions", "responses"] }],
  })));
  expect(hosted.api).toEqual({ "chat-completions": {}, messages });
  // OpenAI models answer Responses without the catalog flag.
  expect(applyV2Set(digitalOceanV2Set(digitalOceanModel({ creator: "OpenAI" }))).api).toEqual({
    "chat-completions": {},
    responses,
    messages,
  });
  // Neither flagged nor hosted: Chat Completions only, so no table is written.
  expect(applyV2Set(digitalOceanV2Set(digitalOceanModel())).api).toBeUndefined();
  // Image models get no chat APIs.
  expect(applyV2Set(digitalOceanV2Set(digitalOceanModel({
    type: "image",
    capabilities: ["responses"],
    modalities: { input: ["text"], output: ["image", "text"] },
  }))).api).toBeUndefined();
});

test("prices DigitalOcean web search, cache TTLs and service tiers from the catalog", () => {
  const [openai] = parseDigitalOceanModels({
    models: [digitalOceanModel({ id: "openai-gpt-5.4", name: "GPT-5.4", pricing: undefined })],
    catalog: [{
      model_id: "openai-gpt-5.4",
      name: "GPT-5.4",
      creator: "OpenAI",
      availability: ["serverless"],
      modalities: { input: ["text"], output: ["text"] },
      pricing: { input_price_per_million: 0.0000025, output_price_per_million: 0.000015 },
      pricing_detail: {
        variants: [
          { tier: "MODEL_PRICING_TIER_STANDARD", label: "Standard", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.0000025, output_price_per_million: 0.000015 } },
          { tier: "MODEL_PRICING_TIER_STANDARD", label: "Batch", mode: "MODEL_BILLING_MODE_BATCH", prices: { input_price_per_million: 0.00000125, output_price_per_million: 0.0000075 } },
          { tier: "MODEL_PRICING_TIER_FAST_MODE", label: "Fast Mode", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.000005, output_price_per_million: 0.00003, cache_read_input_price_per_million: 5e-7 } },
          { label: "Flex Mode (Prompts > 272K tokens)", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.0000025, output_price_per_million: 0.00001125 } },
          { label: "Flex Mode", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.00000125, output_price_per_million: 0.0000075 } },
          { tier: "MODEL_PRICING_TIER_EXTENDED_272K", label: "Long form context (> 272k)", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.000005, output_price_per_million: 0.0000225 } },
        ],
      },
    }],
  });
  const context = { when: { context: { gt: 272_000 } }, price: 5 };
  const doc = applyV2Set(digitalOceanV2Set(openai!), {
    cost: { text: { input: { price: 2.5, overrides: [context] }, output: { price: 15, overrides: [{ when: context.when, price: 22.5 }] } } },
  });
  expect(doc.capabilities).toEqual({ service_tier: ["flex", "priority"] });
  expect((doc.cost as any).web_search).toEqual({ price: 10 });
  expect((doc.cost as any).text.input.overrides).toEqual([
    context,
    { when: { service_tier: { equals: "priority" } }, price: 5, cache: { read: 0.5 } },
    { when: { service_tier: { equals: "flex" } }, price: 1.25 },
    { when: { service_tier: { equals: "flex" }, context: { gt: 272_000 } }, price: 2.5 },
  ]);
  expect((doc.cost as any).text.output.overrides.at(-1)).toEqual({
    when: { service_tier: { equals: "flex" }, context: { gt: 272_000 } },
    price: 11.25,
  });
  // A second run replaces the tier prices instead of repeating them.
  expect(applyV2Set(digitalOceanV2Set(openai!), doc)).toEqual(doc);

  const [anthropic] = parseDigitalOceanModels({
    models: [digitalOceanModel({ id: "anthropic-claude-opus-5", name: "Claude Opus 5", pricing: undefined })],
    catalog: [{
      model_id: "anthropic-claude-opus-5",
      name: "Claude Opus 5",
      creator: "Anthropic",
      availability: ["serverless"],
      modalities: { input: ["text"], output: ["text"] },
      pricing: { input_price_per_million: 0.000005, output_price_per_million: 0.000025 },
      pricing_detail: {
        variants: [
          { tier: "MODEL_PRICING_TIER_STANDARD", label: "Standard", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.000005, output_price_per_million: 0.000025, cache_write_5m_input_price_per_million: 0.00000625, cache_write_1h_input_price_per_million: 0.00001 } },
          { tier: "MODEL_PRICING_TIER_FAST_MODE", label: "Fast Mode", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 0.00001, output_price_per_million: 0.00005, cache_write_5m_input_price_per_million: 0.0000125, cache_write_1h_input_price_per_million: 0.00002 } },
        ],
      },
    }],
  });
  const claude = applyV2Set(digitalOceanV2Set(anthropic!), { cost: { text: { input: { price: 5, cache: { write: 6.25 } }, output: { price: 25 } } } });
  expect(claude.capabilities).toEqual({ service_tier: ["fast"] });
  expect((claude.cost as any).web_search).toEqual({ price: 0 });
  expect((claude.cost as any).text.input.cache.write).toEqual({ "5m": 6.25, "1h": 10 });
  expect((claude.cost as any).text.input.overrides).toEqual([
    { when: { service_tier: { equals: "fast" } }, price: 10, cache: { write: { "5m": 12.5, "1h": 20 } } },
  ]);
});

test("reads DigitalOcean long-context thresholds from untiered variant labels", () => {
  const [model] = parseDigitalOceanModels({
    models: [digitalOceanModel({ pricing: undefined })],
    catalog: [{
      model_id: "anthropic-claude-4.6-sonnet",
      name: "Claude Sonnet 4.6",
      availability: ["serverless"],
      modalities: { input: ["text"], output: ["text"] },
      pricing: { input_price_per_million: 1e-7, output_price_per_million: 5e-7 },
      pricing_detail: {
        variants: [
          { label: "Long form context (> 100k) Batch", mode: "MODEL_BILLING_MODE_BATCH", prices: { input_price_per_million: 2.5e-7, output_price_per_million: 0.00000125 } },
          { label: "Long form context (> 100k)", mode: "MODEL_BILLING_MODE_INTERACTIVE", prices: { input_price_per_million: 5e-7, output_price_per_million: 0.0000025 } },
        ],
      },
    }],
  });
  expect(model?.pricing?.extended).toEqual({ context: 100_000, input: 0.5, output: 2.5 });
});

test("syncs DigitalOcean reasoning capability, efforts, and lifecycle status", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    lifecycle_status: "deprecated",
    thinking: true,
    reasoning_efforts: ["none", "low", "medium", "high", "max", "unsupported"],
  }), {
    name: "Claude Sonnet 4.6",
    description: "Curated DigitalOcean description",
    family: "claude-sonnet",
    release_date: "2026-02-17",
    last_updated: "2026-03-13",
    attachment: true,
    reasoning: false,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    temperature: true,
    tool_call: true,
    open_weights: false,
    status: "beta",
    cost: { input: 3, output: 15 },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });

  expect(model).toMatchObject({
    status: "deprecated",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "max"] }],
  });
});

test("uses DigitalOcean reasoning efforts over curated capability metadata", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    id: "openai-gpt-4o-mini",
    name: "OpenAI GPT-4o mini",
    thinking: false,
    reasoning_efforts: ["low", "medium", "high"],
    context_window: 128_000,
    max_output_tokens: 16_384,
    modalities: { input: ["text", "image"], output: ["text"] },
    pricing: { input: 0.15, output: 0.6, cacheRead: 0.075 },
  }), {
    name: "GPT-4o mini",
    description: "Compact GPT model",
    family: "gpt-mini",
    release_date: "2024-07-18",
    last_updated: "2024-07-18",
    attachment: true,
    reasoning: false,
    temperature: true,
    tool_call: true,
    open_weights: false,
    cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
    limit: { context: 128_000, output: 16_384 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    modalities: { input: ["text", "image"], output: ["text"] },
  });
  expect(model).not.toHaveProperty("base_model");
});

test("preserves DigitalOcean reasoning metadata when efforts are empty", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    thinking: undefined,
    reasoning_efforts: [],
  }), {
    name: "Reasoning model",
    description: "Curated model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 128_000, output: 32_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  });
});

test("uses explicit DigitalOcean thinking false when efforts are empty", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    thinking: false,
    reasoning_efforts: [],
  }), {
    name: "Reasoning model",
    description: "Curated model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 128_000, output: 32_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(model.reasoning).toBe(false);
  expect(model.reasoning_options).toBeUndefined();
});

test("uses DigitalOcean effort lists over curated values", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    id: "openai-gpt-5.2",
    name: "OpenAI GPT-5.2",
    thinking: true,
    reasoning_efforts: ["minimal", "low", "medium", "high"],
    context_window: 400_000,
    max_output_tokens: 128_000,
    modalities: { input: ["text", "image"], output: ["text"] },
    pricing: { input: 1.75, output: 14, cacheRead: 0.175 },
  }), {
    name: "GPT-5.2",
    description: "GPT model",
    family: "gpt",
    release_date: "2025-12-11",
    last_updated: "2025-12-11",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    temperature: false,
    tool_call: true,
    open_weights: false,
    cost: { input: 1.75, output: 14, cache_read: 0.175 },
    limit: { context: 400_000, output: 128_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning: true,
    reasoning_options: [{
      type: "effort",
      values: ["minimal", "low", "medium", "high"],
    }],
  });
  expect(model).not.toHaveProperty("base_model");
});

test("normalizes DigitalOcean x-high effort tokens and uses lifecycle status", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    name: "Nemotron Super (Public Preview)",
    lifecycle_status: "active",
    thinking: true,
    reasoning_efforts: ["low", "x-high", "max"],
  }), {
    name: "Nemotron Super",
    description: "Nemotron model",
    family: "nemotron",
    release_date: "2026-03-11",
    last_updated: "2026-04-16",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    open_weights: true,
    status: "beta",
    cost: { input: 0.3, output: 0.65 },
    limit: { context: 256_000, output: 32_768 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "xhigh", "max"] }],
  });
  expect(model.status).toBeUndefined();
});

test("preserves DigitalOcean status when lifecycle metadata is blank", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    lifecycle_status: "  ",
  }), {
    name: "Preview model",
    description: "Curated model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    tool_call: true,
    open_weights: false,
    status: "beta",
    cost: { input: 1, output: 2 },
    limit: { context: 128_000, output: 32_000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(model.status).toBe("beta");
});

test("explicit DigitalOcean text-only modalities clear standalone attachment support", () => {
  const model = buildDigitalOceanModel(digitalOceanModel({
    modalities: { input: ["text"], output: ["text"] },
  }), {
    name: "Multimodal model",
    description: "Curated model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 128_000, output: 32_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });

  expect(model).toMatchObject({
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  });
});

test("new DigitalOcean base models use explicit text-only catalog modalities", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "anthropic-claude-5-sonnet",
      name: "Anthropic Claude Sonnet 5",
      thinking: true,
      reasoning_efforts: ["low", "medium", "high", "max", "x-high"],
      modalities: { input: ["text"], output: ["text"] },
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    }),
    undefined,
  );

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-5",
    name: "Anthropic Claude Sonnet 5",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  });
  expect(model).toMatchObject({
    attachment: false,
    modalities: { input: ["text"] },
  });
  // reasoning=true matches base metadata, so factorBaseModel omits it
  expect(model).not.toHaveProperty("reasoning");
});

test("existing DigitalOcean base models use explicit text-only catalog modalities", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "nemotron-nano-12b-v2-vl",
      name: "Nemotron Nano 12B v2 VL",
      modalities: { input: ["text"], output: ["text"] },
      context_window: 128_000,
      max_output_tokens: 16_384,
      pricing: { input: 0.2, output: 0.6 },
    }),
    {
      base_model: "nvidia/nemotron-nano-12b-v2-vl",
      name: "Nemotron Nano 12B v2 VL",
      description: "Nemotron vision-language model",
      family: "nemotron",
      release_date: "2025-12-01",
      last_updated: "2026-04-30",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "max"] }],
      temperature: true,
      tool_call: true,
      open_weights: true,
      cost: { input: 0.2, output: 0.6 },
      limit: { context: 128_000, output: 16_384 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    base_model: "nvidia/nemotron-nano-12b-v2-vl",
    attachment: false,
    modalities: { input: ["text"] },
  });
});

test("drops DigitalOcean catalog modalities the serverless endpoint rejects", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "glm-5.3-flash",
      name: "GLM5.3 Flash",
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      context_window: 1_048_576,
      max_output_tokens: 131_072,
      pricing: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    }),
    {
      base_model: "zhipuai/glm-5.3-flash",
      name: "GLM5.3 Flash",
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    base_model: "zhipuai/glm-5.3-flash",
    attachment: false,
    modalities: { input: ["text"] },
  });
});

test("resolves DigitalOcean IDs to canonical model metadata", () => {
  expect(resolveDigitalOceanBaseModel("openai-gpt-5.5")).toBe("openai/gpt-5.5");
  expect(resolveDigitalOceanBaseModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  expect(resolveDigitalOceanBaseModel("mimo-v2.5-pro")).toBe("xiaomi/mimo-v2.5-pro");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-5-sonnet")).toBe("anthropic/claude-sonnet-5");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-opus-5")).toBe("anthropic/claude-opus-5");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-fable-5.1")).toBe("anthropic/claude-fable-5-1");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-5.1-fable")).toBe("anthropic/claude-fable-5-1");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-unknown-99.1")).toBeUndefined();
  expect(resolveDigitalOceanBaseModel("openai-gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
});

test("new DigitalOcean Fable models emit only base metadata overrides", () => {
  const translated = digitalocean.translateModel(
    digitalOceanModel({
      id: "anthropic-claude-fable-5.1",
      name: "Anthropic Claude Fable 5.1",
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
      modalities: { input: ["text", "image"], output: ["text"] },
      max_output_tokens: 128_000,
      created_at: "2026-09-01T00:00:00Z",
      pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    }),
    { existing: () => undefined, authored: () => undefined },
  );
  const { v2Set: _v2Set, ...rest } = translated as { v2Set?: unknown };

  expect(rest).toEqual({
    id: "anthropic-claude-fable-5.1",
    model: {
      base_model: "anthropic/claude-fable-5-1",
      name: "Anthropic Claude Fable 5.1",
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
      modalities: { input: ["text", "image"] },
    },
  });
});

test("new DigitalOcean base models inherit intrinsic capabilities", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "openai-gpt-5.5",
      name: "GPT-5.5",
      thinking: undefined,
      reasoning_efforts: undefined,
    }),
    undefined,
    "openai/gpt-5.5",
  );

  expect(model).toMatchObject({ base_model: "openai/gpt-5.5" });
  expect(model).not.toHaveProperty("open_weights");
  expect(model).not.toHaveProperty("family");
  expect(model).not.toHaveProperty("release_date");
  expect(model).not.toHaveProperty("knowledge");
  expect(model).not.toHaveProperty("reasoning");
  expect(model).not.toHaveProperty("temperature");
});

test("new DigitalOcean MiMo models factor xiaomi base metadata", () => {
  const model = buildDigitalOceanModel(
    digitalOceanModel({
      id: "mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      thinking: undefined,
      reasoning_efforts: undefined,
      modalities: { input: ["text"], output: ["text"] },
      pricing: { input: 0.6, output: 3, cacheRead: 0.16 },
      context_window: 262_144,
      max_output_tokens: 52_429,
    }),
    undefined,
  );

  expect(model).toMatchObject({
    base_model: "xiaomi/mimo-v2.5-pro",
    name: "MiMo V2.5 Pro",
    cost: { input: 0.6, output: 3, cache_read: 0.16 },
    limit: { context: 262_144, output: 52_429 },
  });
  expect(model).not.toHaveProperty("reasoning");
  expect(model).not.toHaveProperty("open_weights");
});

test("xAI sync factors inherited base model fields", () => {
  const model = buildXAIModel(
    {
      id: "grok-4.5",
      created: Date.parse("2026-06-29T00:00:00Z") / 1000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      prompt_text_token_price: 20_000,
      cached_prompt_text_token_price: 5_000,
      completion_text_token_price: 60_000,
      max_prompt_length: 500_000,
    },
    {
      base_model: "xai/grok-4.5",
      name: "Grok 4.5",
      description: "xAI's latest Grok for chat, coding, agentic tools, and lower hallucination risk",
      family: "grok",
      release_date: "2026-07-08",
      last_updated: "2026-07-08",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      temperature: true,
      tool_call: true,
      structured_output: true,
      open_weights: false,
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.5,
        tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
      },
      limit: { context: 500_000, output: 500_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    base_model: "xai/grok-4.5",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.5,
      tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
    },
  });
  expect(model).not.toHaveProperty("name");
  expect(model).not.toHaveProperty("family");
  expect(model).not.toHaveProperty("release_date");
  expect(model).not.toHaveProperty("last_updated");
  expect(model).not.toHaveProperty("limit");
});

test("xAI sync maps long-context API pricing into cost tiers", () => {
  const model = buildXAIModel(
    {
      id: "grok-4.5",
      created: Date.parse("2026-06-29T00:00:00Z") / 1000,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      prompt_text_token_price: 20_000,
      cached_prompt_text_token_price: 3_000,
      completion_text_token_price: 60_000,
      prompt_text_token_price_long_context: 40_000,
      cached_prompt_text_token_price_long_context: 6_000,
      completion_text_token_price_long_context: 120_000,
      long_context_threshold: 200_000,
      max_prompt_length: 500_000,
    },
    {
      base_model: "xai/grok-4.5",
      name: "Grok 4.5",
      family: "grok",
      release_date: "2026-07-08",
      last_updated: "2026-07-08",
      attachment: true,
      reasoning: true,
      tool_call: true,
      open_weights: false,
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.3,
        // Stale hand-authored tier must be overwritten by API long-context rates.
        tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
      },
      limit: { context: 500_000, output: 500_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.3,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 4,
        output: 12,
        cache_read: 0.6,
      }],
    },
  });
});

test("xAI sync keeps authored tiers when long-context rates are omitted", () => {
  const model = buildXAIModel(
    {
      id: "grok-4.5",
      created: Date.parse("2026-06-29T00:00:00Z") / 1000,
      input_modalities: ["text"],
      output_modalities: ["text"],
      prompt_text_token_price: 20_000,
      cached_prompt_text_token_price: 3_000,
      completion_text_token_price: 60_000,
      // Positive threshold without long-context rates must not invent a base-priced tier.
      long_context_threshold: 200_000,
      max_prompt_length: 500_000,
    },
    {
      name: "Grok 4.5",
      family: "grok",
      release_date: "2026-07-08",
      last_updated: "2026-07-08",
      attachment: false,
      reasoning: true,
      tool_call: true,
      open_weights: false,
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.3,
        tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 0.6 }],
      },
      limit: { context: 500_000, output: 500_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    cost: {
      tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 0.6 }],
    },
  });
});

test("xAI sync clears cost tiers when API reports no long-context band", () => {
  const model = buildXAIModel(
    {
      id: "grok-code-fast-1",
      created: Date.parse("2025-01-01T00:00:00Z") / 1000,
      input_modalities: ["text"],
      output_modalities: ["text"],
      prompt_text_token_price: 2_000,
      cached_prompt_text_token_price: 200,
      completion_text_token_price: 15_000,
      prompt_text_token_price_long_context: 0,
      cached_prompt_text_token_price_long_context: 0,
      completion_text_token_price_long_context: 0,
      long_context_threshold: 0,
      max_prompt_length: 256_000,
    },
    {
      name: "Grok Code Fast 1",
      family: "grok",
      release_date: "2025-01-01",
      last_updated: "2025-01-01",
      attachment: false,
      reasoning: true,
      tool_call: true,
      open_weights: false,
      cost: {
        input: 0.2,
        output: 1.5,
        cache_read: 0.02,
        tiers: [{ tier: { size: 200_000 }, input: 0.4, output: 3 }],
      },
      limit: { context: 256_000, output: 256_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    cost: {
      input: 0.2,
      output: 1.5,
      cache_read: 0.02,
    },
  });
  expect(model.cost?.tiers).toBeUndefined();
});

test("OpenRouter sync maps pricing.overrides into cost tiers", () => {
  const model = buildOpenRouterModel(openRouterModel({
    id: "x-ai/grok-4.5",
    name: "xAI: Grok 4.5",
    pricing: {
      prompt: "0.000002",
      completion: "0.000006",
      input_cache_read: "0.0000003",
      overrides: [{
        min_prompt_tokens: 200_000,
        prompt: "0.000004",
        completion: "0.000012",
        input_cache_read: "0.0000006",
      }],
    },
  }), {
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.3,
      tiers: [{ tier: { size: 200_000 }, input: 4, output: 12, cache_read: 1 }],
    },
  });

  expect(model).toMatchObject({
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.3,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 4,
        output: 12,
        cache_read: 0.6,
      }],
    },
  });
});

test("OpenRouter sync keeps time-window pricing overrides out of v1 cost tiers", () => {
  const source = openRouterModel({
    pricing: {
      prompt: "0.00000132",
      completion: "0.00000396",
      overrides: [{
        utc_start: 1_000,
        utc_end: 100,
        prompt: "0.00000066",
        completion: "0.00000198",
      }],
    },
  });
  const [parsed] = openrouter.parseModels({ data: [source] });
  const model = buildOpenRouterModel(parsed!, {
    cost: {
      input: 1.32,
      output: 3.96,
      tiers: [{ tier: { type: "context", size: 200_000 }, input: 2.64, output: 7.92 }],
    },
  });

  expect(model.cost?.tiers).toEqual([
    { tier: { type: "context", size: 200_000 }, input: 2.64, output: 7.92 },
  ]);
});

test("OpenRouter sync keeps authored tiers when API omits overrides", () => {
  const model = buildOpenRouterModel(openRouterModel({
    pricing: {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
    },
  }), {
    cost: {
      input: 3,
      output: 15,
      tiers: [{ tier: { size: 200_000 }, input: 6, output: 22.5 }],
    },
  });

  expect(model).toMatchObject({
    cost: {
      tiers: [{ tier: { size: 200_000 }, input: 6, output: 22.5 }],
    },
  });
});

// Catalog entries below are shaped like https://openrouter.ai/api/v1/models (2026-10-20).
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const MON_FRI = { utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] } };

// deepseek/deepseek-v4.1-flash-1017
function openRouterPeakPricedModel() {
  const offPeak = { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" };
  const peak = { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" };
  return openRouterModel({
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek: DeepSeek V4.1 Flash (1017)",
    pricing: {
      ...peak,
      overrides: [
        { utc_days: ["saturday", "sunday"], ...offPeak },
        { utc_days: WEEKDAYS, utc_start: 0, utc_end: 100, ...offPeak },
        { utc_days: WEEKDAYS, utc_start: 100, utc_end: 400, ...peak },
        { utc_days: WEEKDAYS, utc_start: 400, utc_end: 600, ...offPeak },
        { utc_days: WEEKDAYS, utc_start: 600, utc_end: 1000, ...peak },
        { utc_days: WEEKDAYS, utc_start: 1000, utc_end: 0, ...offPeak },
      ],
    },
  });
}

// anthropic/claude-haiku-5.5
function openRouterClaudeModel() {
  return openRouterModel({
    id: "anthropic/claude-haiku-5.5",
    name: "Anthropic: Claude Haiku 5.5",
    pricing: {
      prompt: "0.0000001",
      completion: "0.0000005",
      web_search: "0.01",
      input_cache_read: "0.00000001",
      input_cache_write: "0.000000125",
      input_cache_write_1h: "0.0000002",
      overrides: [{
        min_prompt_tokens: 100_000,
        prompt: "0.0000005",
        completion: "0.0000025",
        input_cache_read: "0.00000005",
        input_cache_write: "0.000000625",
        input_cache_write_1h: "0.000001",
      }],
    },
  });
}

// google/gemini-3.1-flash-image and google/gemini-2.5-flash
function openRouterGeminiModel() {
  return openRouterModel({
    id: "google/gemini-2.5-flash",
    name: "Google: Gemini 2.5 Flash",
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000025",
      image: "0.0000003",
      image_output: "0.00006",
      audio: "0.000001",
      input_audio_cache: "0.0000001",
      web_search: "0.014",
      internal_reasoning: "0.0000025",
      input_cache_read: "0.00000003",
      input_cache_write: "0.0000000833333333333333",
    },
  });
}

const CLAUDE_CACHE = { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } };
const translateContext = { existing: () => undefined, authored: () => undefined };
type OverridesSet = (current: unknown) => unknown;

test("OpenRouter time-window prices become v2 overrides in catalog order, with the base unchanged", () => {
  const [source] = openrouter.parseModels({ data: [openRouterPeakPricedModel()] });
  const translated = openrouter.translateModel(source!, translateContext) as {
    model: SyncedModel;
    v2Set: Record<string, unknown>;
    notices: string[];
  };

  // v1 keeps the catalog's top-level prices, with no context tiers.
  expect(translated.model.cost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.006 });
  expect(translated.notices).toEqual([]);
  const windows = [
    { utc_days: { in: ["sat", "sun"] } },
    { ...MON_FRI, utc_hours: { lt: "01:00" } },
    { ...MON_FRI, all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
    { ...MON_FRI, all: [{ utc_hours: { gte: "04:00" } }, { utc_hours: { lt: "06:00" } }] },
    { ...MON_FRI, all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
    // utc_end 0 is the end of the day.
    { ...MON_FRI, utc_hours: { gte: "10:00" } },
  ];
  const peak = [false, false, true, false, true, false];
  expect((translated.v2Set["cost.text.input.overrides"] as OverridesSet)(undefined)).toEqual(
    windows.map((when, i) => peak[i]
      ? { when, price: 0.3, cache: { read: 0.006 } }
      : { when, price: 0.15, cache: { read: 0.003 } }),
  );
  expect((translated.v2Set["cost.text.output.overrides"] as OverridesSet)(undefined)).toEqual(
    windows.map((when, i) => ({ when, price: peak[i] ? 1.2 : 0.6 })),
  );
  expect(translated.v2Set["cost.image"]).toBeUndefined();
});

test("OpenRouter override conditions map to v2 when, wrapping past midnight", () => {
  const cheap = { prompt: "0.000001", completion: "0.000004" };
  const when = (override: Record<string, unknown>) => overrideWhen({ ...override, ...cheap });

  // tencent/hy3: 00:00-16:00 and 16:00-24:00 every day.
  expect(when({ utc_start: 0, utc_end: 1600 })).toEqual({ utc_hours: { lt: "16:00" } });
  expect(when({ utc_start: 1600, utc_end: 0 })).toEqual({ utc_hours: { gte: "16:00" } });
  // "A window whose end is not after its start wraps past midnight ... t >= start || t < end",
  // on the days given, evaluated at the request instant.
  expect(when({ utc_days: ["friday"], utc_start: 1630, utc_end: 30 })).toEqual({
    utc_days: { in: ["fri"] },
    any: [{ utc_hours: { gte: "16:30" } }, { utc_hours: { lt: "00:30" } }],
  });
  expect(when({ utc_days: ["monday"], utc_start: 900, utc_end: 900 })).toEqual({ utc_days: { in: ["mon"] } });
  expect(when({ utc_days: ["sunday", "saturday"] })).toEqual({ utc_days: { in: ["sat", "sun"] } });
  // "strictly greater than this threshold", and every condition must match.
  expect(when({ min_prompt_tokens: 200_000, utc_days: ["monday"] })).toEqual({
    context: { gt: 200_000 },
    utc_days: { in: ["mon"] },
  });

  expect(when({ utc_start: 100 })).toBe("only one of utc_start and utc_end");
  expect(when({ utc_start: 2400, utc_end: 0 })).toBe("utc_start or utc_end is not an HHMM time");
  expect(when({ utc_start: 160, utc_end: 0 })).toBe("utc_start or utc_end is not an HHMM time");
  expect(when({ utc_days: ["someday"] })).toBe("utc_days is not a list of weekdays");
  expect(when({ utc_days: [] })).toBe("utc_days is not a list of weekdays");
  expect(when({ min_prompt_tokens: -1 })).toBe("min_prompt_tokens is not a token count");
});

test("OpenRouter overrides keep catalog order and skip entries with unknown conditions", () => {
  const cost = catalogCost(openRouterModel({
    id: "lab/model",
    pricing: {
      prompt: "0.000002",
      completion: "0.000008",
      overrides: [
        { min_prompt_tokens: 200_000, prompt: "0.000004", completion: "0.000016" },
        // Later entries win per key, as v2 overrides merge in order.
        { utc_days: ["saturday", "sunday"], min_prompt_tokens: 200_000, prompt: "0.000002" },
        { region: "eu", prompt: "0.000003" },
        { utc_start: 100, prompt: "0.000001" },
        // A web search price is a price key, not an unknown condition.
        { utc_days: ["monday"], prompt: "0.000003", web_search: "0.02" },
      ],
    },
  }));

  expect(cost.ownsContext).toBe(true);
  expect(cost.overrides.input).toEqual([
    { when: { context: { gt: 200_000 } }, price: 4 },
    { when: { context: { gt: 200_000 }, utc_days: { in: ["sat", "sun"] } }, price: 2 },
    { when: { utc_days: { in: ["mon"] } }, price: 3 },
  ]);
  expect(cost.overrides.output).toEqual([{ when: { context: { gt: 200_000 } }, price: 16 }]);
  expect(cost.notices).toEqual([
    'lab/model: overrides not synced: skipped override {"region":"eu","prompt":"0.000003"}: unknown fields region',
    'lab/model: overrides not synced: skipped override {"utc_start":100,"prompt":"0.000001"}: only one of utc_start and utc_end',
    "lab/model: overrides not synced: an override prices web_search with no base price",
  ]);
  expect(cost.webSearch).toBeUndefined();
});

test("OpenRouter 1h cache writes take the file's cache TTLs", () => {
  const [source] = openrouter.parseModels({ data: [openRouterClaudeModel()] });
  const translated = openrouter.translateModel(source!, { ...translateContext, v2: () => CLAUDE_CACHE }) as {
    model: SyncedModel;
    v2Set: Record<string, unknown>;
    notices: string[];
  };

  // v1 keeps the default (5m) write price.
  expect(translated.model.cost).toMatchObject({
    cache_write: 0.125,
    tiers: [{ tier: { type: "context", size: 100_000 }, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 }],
  });
  expect(translated.v2Set["cost.text.input.cache.write"]).toEqual({ "5m": 0.125, "1h": 0.2 });
  expect((translated.v2Set["cost.text.input.overrides"] as OverridesSet)(undefined)).toEqual([
    { when: { context: { gt: 100_000 } }, price: 0.5, cache: { read: 0.05, write: { "5m": 0.625, "1h": 1 } } },
  ]);
  expect(translated.v2Set).not.toHaveProperty("cost.fees");
  // $0.01 per search is $10 per 1,000.
  expect(translated.v2Set["cost.web_search"]).toEqual({ price: 10 });
  expect(translated.notices).toEqual([]);

  // Without the TTLs in the file, the 1h prices have no label.
  const unlabeled = catalogCost(openRouterClaudeModel(), {});
  expect(unlabeled.write).toBeUndefined();
  expect(unlabeled.overrides.input[0]).toMatchObject({ cache: { write: 0.625 } });
  expect(unlabeled.notices).toEqual([
    "anthropic/claude-haiku-5.5: input_cache_write_1h not synced: the file's cache capability doesn't list a default and a 1h TTL",
  ]);
});

test("OpenRouter image, audio, reasoning and web search prices map to v2; per-call prices are reported", () => {
  const cost = catalogCost(openRouterGeminiModel());

  // Per token, like the text prices.
  expect(cost.image).toEqual({ input: { price: 0.3 }, output: { price: 60 } });
  expect(cost.audio).toEqual({ input: { price: 1, cache: { read: 0.1 } } });
  expect(cost).not.toHaveProperty("fees");
  // $0.014 per search, without float noise.
  expect(cost.webSearch).toEqual({ price: 14 });
  expect(cost.notices).toEqual([]);
  expect(buildOpenRouterModel(openRouterGeminiModel(), undefined).cost).toMatchObject({ reasoning: 2.5, input_audio: 1 });

  const perRequest = catalogCost(openRouterModel({
    id: "lab/model",
    pricing: { prompt: "0.000001", completion: "0.000002", request: "0.005", audio_output: "0.000064", video_seconds: "0.1" },
  }));
  expect(perRequest.audio).toEqual({ output: { price: 64 } });
  expect(perRequest.notices).toEqual([
    "lab/model: request not synced: v2 has no per-call price",
    "lab/model: video_seconds not synced: no known v2 field",
  ]);

  // google/gemini-2.5-flash-image lists a reasoning price but no reasoning parameter:
  // the price still goes to v2, as reasoning tokens are billed whenever the model
  // reasons. v1 has no reasoning price without reasoning.
  const noReasoningModel = openRouterModel({
    id: "lab/model",
    supported_parameters: ["tools"],
    pricing: { prompt: "0.0000003", completion: "0.0000025", internal_reasoning: "0.0000025" },
  });
  const noReasoning = catalogCost(noReasoningModel);
  expect(noReasoning.reasoning).toBe(2.5);
  expect(noReasoning.notices).toEqual([]);
  const translated = openrouter.translateModel(noReasoningModel, translateContext) as {
    model: SyncedModel;
    v2Set: Record<string, unknown>;
  };
  expect(translated.model.cost?.reasoning).toBeUndefined();
  expect(translated.v2Set["cost.text.output.reasoning"]).toBe(2.5);
});

test("OpenRouter audio prices keep their overrides; time-billed audio is per minute and v2-only", () => {
  const gemini = openRouterModel({
    id: "google/gemini-2.5-pro",
    pricing: {
      prompt: "0.00000125",
      completion: "0.00001",
      audio: "0.00000125",
      input_audio_cache: "0.000000125",
      overrides: [{
        min_prompt_tokens: 200000,
        prompt: "0.0000025",
        completion: "0.000015",
        audio: "0.0000025",
        input_audio_cache: "0.00000025",
      }],
    },
  });
  const cost = catalogCost(gemini);
  expect(cost.audio).toEqual({
    input: {
      price: 1.25,
      cache: { read: 0.125 },
      overrides: [{ when: { context: { gt: 200_000 } }, price: 2.5, cache: { read: 0.25 } }],
    },
  });
  expect(cost.notices).toEqual([]);
  // v1 tiers carry no audio price.
  const v1 = buildOpenRouterModel(gemini, undefined).cost;
  expect(v1).toMatchObject({ input_audio: 1.25 });
  expect(v1?.tiers?.[0]).not.toHaveProperty("input_audio");

  // $0.0001 per second is $0.006 per minute.
  const voxtral = openRouterModel({
    id: "mistralai/voxtral-small-24b-2507",
    pricing: { prompt: "0.0000001", completion: "0.0000003", audio: "0.0001" },
  });
  expect(catalogCost(voxtral).audio).toEqual({ input: { unit: "minute", price: 0.006 } });
  expect(buildOpenRouterModel(voxtral, undefined).cost).not.toHaveProperty("input_audio");
  expect(modelV2ToV1({
    id: "mistralai/voxtral-small-24b-2507",
    ...VOXTRAL_V2,
  }).cost).toEqual({ input: 0.1, output: 0.3 });

  expect(openrouter.sourceNotices([voxtral])).toEqual([]);
  expect(openrouter.sourceNotices([gemini])).toEqual([
    "mistralai/voxtral-small-24b-2507: listed in TIME_BILLED_AUDIO but no longer in the OpenRouter catalog",
  ]);
});

const VOXTRAL_V2 = {
  schema: 2,
  name: "Voxtral Small",
  description: "Voxtral Small",
  open_weights: true,
  release_date: "2025-07-15",
  modalities: { input: ["text", "audio/wav"], output: ["text"] },
  capabilities: { tools: { supported: true }, reasoning: { supported: false } },
  limit: { context: 32_000, output: 32_000 },
  cost: {
    text: { input: { price: 0.1 }, output: { price: 0.3 } },
    audio: { input: { unit: "minute", price: 0.006 } },
  },
};

test("OpenRouter overrides replace only the file's overrides the catalog owns", () => {
  const region = { when: { region: { equals: "eu" } }, price: 3 };
  const tier = { when: { context: { gt: 200_000 } }, price: 6 };
  const stale = { when: { all: [{ utc_hours: { gte: "01:00" } }] }, price: 9 };

  // The catalog has a time window but no context tiers: the file's tiers stay, as in v1.
  const timed = openrouter.translateModel(openRouterModel({
    pricing: {
      prompt: "0.000002",
      completion: "0.000008",
      overrides: [{ utc_days: ["sunday"], prompt: "0.000001", completion: "0.000004" }],
    },
  }), translateContext) as unknown as { v2Set: Record<string, OverridesSet> };
  expect(timed.v2Set["cost.text.output.overrides"]!([region, tier, stale])).toEqual([
    region,
    tier,
    { when: { utc_days: { in: ["sun"] } }, price: 4 },
  ]);

  // With context tiers in the catalog, the file's tiers are replaced.
  const tiered = openrouter.translateModel(openRouterModel({
    pricing: {
      prompt: "0.000002",
      completion: "0.000008",
      overrides: [{ min_prompt_tokens: 200_000, prompt: "0.000004", completion: "0.000016" }],
    },
  }), translateContext) as unknown as { v2Set: Record<string, OverridesSet> };
  expect(tiered.v2Set["cost.text.input.overrides"]!([region, tier, stale])).toEqual([
    region,
    { when: { context: { gt: 200_000 } }, price: 4 },
  ]);

  const flat = openrouter.translateModel(openRouterModel(), translateContext) as unknown as { v2Set: Record<string, OverridesSet> };
  expect(flat.v2Set["cost.text.output.overrides"]!([stale])).toBeUndefined();
});

test("OpenRouter tool_choice sets every documented tool choice and keeps other tool fields", () => {
  const toolsSet = (supported_parameters: string[]) =>
    (openrouter.translateModel(openRouterModel({ supported_parameters }), translateContext) as unknown as {
      v2Set: Record<string, OverridesSet>;
    }).v2Set["capabilities.tools"]!;
  const choice = ["auto", "none", "required", "tool"];

  expect(toolsSet(["tools", "tool_choice"])(undefined)).toEqual({ supported: true, choice });
  expect(toolsSet(["tools", "tool_choice"])({ supported: true, updates: true })).toEqual({ supported: true, updates: true, choice });
  expect(toolsSet(["tools"])({ supported: true, choice })).toEqual({ supported: true });
  expect(toolsSet(["tools"])(undefined)).toBeUndefined();
  expect(toolsSet(["tool_choice"])({ supported: false })).toEqual({ supported: false });

  const opus = openrouter.translateModel(
    openRouterModel({ id: "anthropic/claude-opus-5.5", supported_parameters: ["tools", "tool_choice"] }),
    translateContext,
  ) as unknown as { v2Set: Record<string, OverridesSet> };
  // Its lab limits choice to auto and none, so the file inherits it instead of restating it.
  expect(opus.v2Set["capabilities.tools"]!(undefined)).toBeUndefined();
  expect(opus.v2Set["capabilities.tools"]!({ supported: true, choice })).toEqual({ supported: true });
});

test("syncs every OpenRouter price into v2 files without changing v1", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-openrouter-prices-"));
  const modelsDir = path.join(root, "providers", "example", "models");
  await mkdir(path.join(root, "models", "lab"), { recursive: true });
  await mkdir(path.join(modelsDir, "lab"), { recursive: true });
  await writeFile(path.join(root, "models", "lab", "chat.toml"), [
    "schema = 2",
    'name = "Chat"',
    'description = "Example chat model"',
    "open_weights = false",
    'release_date = "2026-01-01"',
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = false }",
    "temperature = true",
    "top_p = true",
    "top_k = false",
    "",
    "[limit]",
    "context = 100_000",
    "output = 10_000",
    "",
  ].join("\n"));
  const file = path.join(modelsDir, "lab", "chat.toml");
  const write = (cost: string[]) => writeFile(file, [
    "schema = 2",
    'base_model = "lab/chat"',
    "",
    "[capabilities]",
    'cache = { explicit = { ttl = ["5m", "1h"] } }',
    "",
    ...cost,
  ].join("\n"));
  let source = openRouterPeakPricedModel();
  const provider: SyncProvider<string> = {
    id: "openrouter-prices-test",
    name: "OpenRouter prices test",
    modelsDir,
    async fetchModels() {
      return ["lab/chat"];
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id, context) {
      const translated = openrouter.translateModel(source, { ...context, v2: () => context.v2?.(id) }) as {
        model: SyncedModel;
        v2Set: Record<string, unknown>;
      };
      return { id, model: { base_model: "lab/chat", cost: translated.model.cost }, v2Set: translated.v2Set };
    },
  };
  const read = async () => {
    const doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    return { doc, v1: modelV2ToV1({ ...doc, id: "lab/chat" }, { modelPath: file }) };
  };

  try {
    await write(["[cost.text.input]", "price = 0.3", "cache = { read = 0.006 }", "", "[cost.text.output]", "price = 1.2", ""]);
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    let { doc, v1 } = await read();
    expect(doc.cost.text.input.overrides).toHaveLength(6);
    expect(doc.cost.text.output.overrides).toHaveLength(6);
    // v1 ignores the time-window overrides: base prices, no tiers.
    expect(v1.cost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.006 });
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 1 });

    // The catalog drops the windows: their overrides go too.
    source = openRouterModel({ pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" } });
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    ({ doc } = await read());
    expect(doc.cost.text).toEqual({ input: { price: 0.3, cache: { read: 0.006 } }, output: { price: 1.2 } });

    // 1h cache writes and image prices; v1 keeps only what it had.
    source = { ...openRouterClaudeModel(), pricing: { ...openRouterClaudeModel().pricing, image: "0.0000001" } };
    await write([
      "[cost.text.input]",
      "price = 0.1",
      "cache = { read = 0.01, write = 0.125 }",
      "",
      "[[cost.text.input.overrides]]",
      "when = { context = { gt = 100_000 } }",
      "price = 0.5",
      "cache = { read = 0.05, write = 0.625 }",
      "",
      "[cost.text.output]",
      "price = 0.5",
      "",
      "[[cost.text.output.overrides]]",
      "when = { context = { gt = 100_000 } }",
      "price = 2.5",
      "",
    ]);
    const before = (await read()).v1;
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    ({ doc, v1 } = await read());
    expect(doc.cost.text.input.cache.write).toEqual({ "5m": 0.125, "1h": 0.2 });
    expect(doc.cost.text.input.overrides[0].cache.write).toEqual({ "5m": 0.625, "1h": 1 });
    expect(doc.cost.image).toEqual({ input: { price: 0.1 } });
    expect(doc.cost).not.toHaveProperty("fees");
    expect(v1.cost).toEqual(before.cost);
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 1 });

    // A reasoning price on a model without reasoning (lab/chat has none): v2 gets
    // it, v1 leaves it out.
    source = openRouterModel({
      supported_parameters: ["tools"],
      pricing: { prompt: "0.0000003", completion: "0.0000012", internal_reasoning: "0.0000025" },
    });
    await write(["[cost.text.input]", "price = 0.3", "", "[cost.text.output]", "price = 1.2", ""]);
    expect(await syncProvider(provider)).toMatchObject({ updated: 1, notices: [] });
    ({ doc } = await read());
    expect(doc.cost.text.output).toEqual({ price: 1.2, reasoning: 2.5 });
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 1 });
    await writeFile(path.join(root, "providers", "example", "provider.toml"), [
      'name = "Example"',
      'npm = "@ai-sdk/openai-compatible"',
      'env = ["EXAMPLE_API_KEY"]',
      'api = "https://example.com/v1"',
      'doc = "https://example.com"',
      "",
    ].join("\n"));
    const providers = await generate(path.join(root, "providers"));
    expect(providers.example!.models["lab/chat"]!.cost).toEqual({ input: 0.3, output: 1.2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips new DigitalOcean models with incomplete pricing or limits", () => {
  const translated = digitalocean.translateModel(
    digitalOceanModel({ pricing: undefined }),
    { existing: () => undefined, authored: () => undefined },
  );
  expect(translated).toBeUndefined();
});

test("fetches every page of the DigitalOcean catalog", async () => {
  const requests: string[] = [];
  const first = digitalOceanModel({ id: "first", pricing: undefined });
  const second = digitalOceanModel({ id: "second", pricing: undefined });
  const fetcher = ((input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/catalog/first-catalog-id")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          id: "first-catalog-id",
          model_id: "first",
          name: "Stale First Detail",
          context_window: "50",
          max_output_tokens: "10",
          availability: ["dedicated"],
          modalities: { input: ["text", "image"], output: ["text"] },
          pricing: { input_price_per_million: 0.000009, output_price_per_million: 0.000009 },
          pricing_detail: { variants: [] },
        },
      })));
    }
    if (url.includes("/catalog/second-catalog-id")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { id: "second-catalog-id", model_id: "second", name: "Second", availability: ["serverless"] },
      })));
    }
    if (url.includes("/catalog") && url.includes("page=2")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ id: "second-catalog-id", model_id: "second", name: "Second", availability: ["serverless"] }],
        meta: { total: 2, page: 2, pages: 2 },
      })));
    }
    if (url.includes("/catalog")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: "first-catalog-id",
          model_id: "first",
          name: "First",
          context_window: "100",
          max_output_tokens: "90",
          availability: ["serverless"],
          pricing: { input_price_per_million: 0.000001, output_price_per_million: 0.000002 },
        }],
        meta: { total: 2, page: 1, pages: 2 },
      })));
    }
    if (url.includes("?page=2")) {
      return Promise.resolve(new Response(JSON.stringify({ models: [second] })));
    }
    return Promise.resolve(new Response(JSON.stringify({
      models: [first],
      links: { pages: { next: "https://api.digitalocean.com/v2/gen-ai/models?page=2" } },
    })));
  }) as typeof fetch;

  const result = await fetchDigitalOceanModels("test-key", fetcher);
  expect(result.models.map((model) => model.id)).toEqual(["first", "second"]);
  expect(result.catalog.map((model) => model.model_id)).toEqual(["first", "second"]);
  expect(result.catalog[0]).toMatchObject({
    name: "First",
    context_window: "100",
    max_output_tokens: "90",
    availability: ["serverless"],
    pricing: { input_price_per_million: 0.000001, output_price_per_million: 0.000002 },
    modalities: { input: ["text", "image"], output: ["text"] },
    pricing_detail: { variants: [] },
  });
  expect(requests).toHaveLength(6);
});

function deepInfraModel(model_name: string, tags: string[]): DeepInfraModel {
  return {
    model_name,
    type: "text-generation",
    tags,
    pricing: {
      cents_per_input_token: 0.00001,
      cents_per_output_token: 0.00002,
    },
    max_tokens: 262_144,
  };
}

test("syncs Hyper pricing from catalog input/output fields", () => {
  const model = hyperModel({
    id: "minimax-m2.7",
    reasoning: undefined,
    pricing: {
      input: 0.3,
      output: 1.2,
      cache_hit: 0.06,
      cache_create: 0.03,
    },
  });

  expect(buildHyperModel(model, undefined, "minimax/MiniMax-M2.7")).toMatchObject({
    cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.03 },
    reasoning_options: [],
  });
  expect(buildHyperModel(model, undefined, "minimax/MiniMax-M2.7")).not.toHaveProperty("reasoning");
});

test("rounds Hyper pricing to six decimal places", () => {
  const model = hyperModel({
    id: "deepseek-v4-flash",
    pricing: {
      input: 0.20000010875000002,
      output: 0.40000021750000003,
      cache_hit: 0.039999586250000004,
    },
  });

  expect(buildHyperModel(model, undefined, "deepseek/deepseek-v4-flash")).toMatchObject({
    cost: { input: 0.2, output: 0.4, cache_read: 0.04 },
  });
});

test("inherits Hyper reasoning when API omits reasoning metadata", () => {
  const model = hyperModel({ id: "llama-3.3-70b-instruct", reasoning: undefined });

  expect(buildHyperModel(model, undefined, "meta/llama-3.3-70b-instruct")).toMatchObject({
    attachment: false,
  });
  expect(buildHyperModel(model, undefined, "meta/llama-3.3-70b-instruct")).not.toHaveProperty("reasoning");
  expect(buildHyperModel(model, undefined, "meta/llama-3.3-70b-instruct")).not.toHaveProperty("reasoning_options");

  expect(buildHyperModel(hyperModel({ id: "minimax-m2.7", reasoning: undefined }), undefined, "minimax/MiniMax-M2.7")).toMatchObject({
    reasoning_options: [],
  });
  expect(buildHyperModel(hyperModel({ id: "minimax-m2.7", reasoning: undefined }), undefined, "minimax/MiniMax-M2.7")).not.toHaveProperty("reasoning");
});

test("preserves existing Hyper cost when API pricing is missing", () => {
  const existing = {
    cost: { input: 1, output: 2 },
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
  };

  expect(buildHyperModel(hyperModel({ id: "minimax-m2.7" }), existing, "minimax/MiniMax-M2.7")).toMatchObject({
    cost: { input: 1, output: 2 },
  });
});

test("creates a full Hyper model when no base_model metadata exists", () => {
  const model = hyperModel({
    id: "custom-coder",
    display_name: "Custom Coder",
    reasoning: undefined,
    capabilities: { vision: true },
    pricing: {
      input: 0.2,
      output: 0.8,
      cache_hit: 0.04,
      cache_create: 0,
    },
  });

  expect(buildHyperModel(model, undefined)).toMatchObject({
    name: "Custom Coder",
    attachment: true,
    reasoning: false,
    tool_call: true,
    open_weights: false,
    cost: { input: 0.2, output: 0.8, cache_read: 0.04 },
    limit: { context: 1_000_000, output: 384_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });
  expect(buildHyperModel(model, undefined)).not.toHaveProperty("base_model");
  expect(buildHyperModel(model, undefined)).not.toHaveProperty("reasoning_options");
});

test("factors new Hyper models against unique models/ metadata", () => {
  expect(buildHyperModel(hyperModel({ id: "kimi-k3", reasoning: undefined }), undefined)).toMatchObject({
    base_model: "moonshotai/kimi-k3",
    reasoning_options: [],
  });
});

test("deduplicates Eden AI case-only IDs without losing context metadata", () => {
  const lowercase = edenAIModel({
    id: "flexai/deepseek-v4-flash-0731",
    model_name: "deepseek-v4-flash-0731",
    owned_by: "flexai",
    context_length: null,
  });
  const uppercase = edenAIModel({
    ...lowercase,
    id: "flexai/DeepSeek-V4-Flash-0731",
    model_name: "DeepSeek-V4-Flash-0731",
    context_length: 786_432,
  });

  for (const data of [[lowercase, uppercase], [uppercase, lowercase]]) {
    const models = edenai.parseModels({ object: "list", data });
    expect(models).toEqual([{ ...lowercase, context_length: 786_432 }]);
    expect(edenai.translateModel(models[0]!, { existing: () => undefined, authored: () => undefined })).toMatchObject({
      id: lowercase.id,
      model: { base_model: "deepseek/deepseek-v4-flash-0731", limit: { context: 786_432 } },
    });
  }

  expect(edenai.parseModels({ object: "list", data: [uppercase] })).toEqual([uppercase]);
});

test("factors Eden AI models onto lab metadata and prices from list_pricing", () => {
  const model = edenAIModel({
    id: "openai/gpt-5.6-terra",
    model_name: "gpt-5.6-terra",
    owned_by: "openai",
    pricing: { input_cost_per_token: 0.0000013, output_cost_per_token: 0.0000078 },
    list_pricing: {
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000012,
      cache_read_input_token_cost: 0.0000002,
    },
  });

  expect(buildEdenAIModel(model)).toMatchObject({
    base_model: "openai/gpt-5.6-terra",
    cost: { input: 2, output: 12, cache_read: 0.2 },
    reasoning_options: [
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
    ],
  });
  expect(buildEdenAIModel(model)).not.toHaveProperty("reasoning");
});

test("takes Eden AI reasoning options from the model's own lab entry", () => {
  expect(reasoningOptionsFor("deepseek/deepseek-v4-pro")).toEqual([
    { type: "effort", values: ["none", "high", "max"] },
  ]);
  expect(reasoningOptionsFor("openai/o1")).toEqual([
    { type: "effort", values: ["low", "medium", "high"] },
  ]);
});

test("skips new Eden AI models whose reasoning control has no effort equivalent", () => {
  // The sync does not yet map this route's budget control to Eden AI's API.
  expect(reasoningOptionsFor("google/gemini-2.5-pro")).toBeUndefined();
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "google/gemini-2.5-pro",
        model_name: "gemini-2.5-pro",
        owned_by: "google",
      }),
    ),
  ).toBeUndefined();
});

test("Eden AI preserves authored controls when reasoning mapping is unresolved", () => {
  const authored: NonNullable<ExistingModel["reasoning_options"]>[] = [
    [],
    [{ type: "toggle" }],
    [{ type: "effort", values: ["high"] }],
    [{ type: "toggle" }, { type: "budget_tokens" }],
  ];
  for (const [id, base] of [
    ["zai/glm-5", "zhipuai/glm-5"],
    ["moonshot/kimi-k2.6", "moonshotai/kimi-k2.6"],
    ["minimax/MiniMax-M3", "minimax/MiniMax-M3"],
    ["deepinfra/nvidia/Nemotron-3-Nano-30B-A3B", "nvidia/nemotron-3-nano-30b-a3b"],
    ["google/gemini-2.5-pro", "google/gemini-2.5-pro"],
  ] as const) {
    const model = edenAIModel({
      id,
      owned_by: id.slice(0, id.indexOf("/")),
      model_name: id.slice(id.indexOf("/") + 1),
    });
    expect(buildEdenAIModel(model)).toBeUndefined();
    for (const reasoning_options of authored) {
      expect(buildEdenAIModel(model, { base_model: base, reasoning_options })).toMatchObject({
        base_model: base,
        reasoning_options,
      });
    }
  }
});

test("Eden AI sync keeps listed models with unresolved reasoning controls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-edenai-"));
  const modelsDir = path.join(root, "providers", "edenai", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const files = [
    ["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
    ["zai/glm-5", "zhipuai/glm-5"],
    ["retired/model", "openai/gpt-4o-mini"],
  ] as const;

  try {
    for (const [id, base] of files) {
      const destination = path.join(modelsDir, `${id}.toml`);
      const metadata = path.join(root, "models", `${base}.toml`);
      await mkdir(path.dirname(destination), { recursive: true });
      await mkdir(path.dirname(metadata), { recursive: true });
      await copyFile(path.join(repo, "models", `${base}.toml`), metadata);
      await copyFile(
        path.join(repo, "providers", "edenai", "models", `${id === "retired/model" ? "openai/gpt-4o-mini" : id}.toml`),
        destination,
      );
    }
    const glmPath = path.join(modelsDir, "zai/glm-5.toml");
    const authored = (await readFile(glmPath, "utf8")).replace(
      "reasoning = { supported = true }",
      "reasoning = { supported = true, toggle = true }",
    );
    const header = "# Toggle: extra_body.thinking.type = enabled|disabled\n";
    await Bun.write(glmPath, header + authored);
    const supported = edenAIModel({
      id: "openai/gpt-4o-mini",
      model_name: "gpt-4o-mini",
      owned_by: "openai",
      list_pricing: { input_cost_per_token: 0.000123, output_cost_per_token: 0.000456 },
    });
    const unresolved = edenAIModel({ id: "zai/glm-5", model_name: "glm-5", owned_by: "zai" });
    const provider = {
      ...edenai,
      modelsDir,
      async fetchModels() {
        return { object: "list", data: [
          supported,
          { ...supported, id: "openai/gpt-4o-mini@us" },
          unresolved,
          { ...unresolved, id: "zai/glm-5@us" },
        ] };
      },
    };

    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 1, deleted: 1 });
    expect(result.files.filter((file) => file.status === "deleted").map((file) => file.path)).toEqual([
      path.join(modelsDir, "retired/model.toml"),
    ]);
    const content = await readFile(glmPath, "utf8");
    expect(content).toStartWith(header);
    expect(Bun.TOML.parse(content)).toMatchObject({
      base_model: "zhipuai/glm-5",
      capabilities: { reasoning: { supported: true, toggle: true } },
    });
    expect(await Bun.file(path.join(modelsDir, "zai/glm-5@us.toml")).exists()).toBe(false);
    expect(await Bun.file(path.join(modelsDir, "openai/gpt-4o-mini@us.toml")).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Eden AI price updates keep v2-only data in migrated files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-edenai-v2-"));
  const modelsDir = path.join(root, "providers", "edenai", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const files = [
    ["openai/gpt-5-search-api", "openai/gpt-5-search-api"],
    ["anthropic/claude-opus-4-6", "anthropic/claude-opus-4-6"],
  ] as const;

  try {
    for (const [id, base] of files) {
      await mkdir(path.dirname(path.join(modelsDir, `${id}.toml`)), { recursive: true });
      await mkdir(path.dirname(path.join(root, "models", `${base}.toml`)), { recursive: true });
      await copyFile(path.join(repo, "models", `${base}.toml`), path.join(root, "models", `${base}.toml`));
      await copyFile(path.join(repo, "providers", "edenai", "models", `${id}.toml`), path.join(modelsDir, `${id}.toml`));
    }
    const before = await Promise.all(files.map(([id]) => readFile(path.join(modelsDir, `${id}.toml`), "utf8")));
    const search = edenAIModel({
      id: "openai/gpt-5-search-api",
      model_name: "gpt-5-search-api",
      context_length: 272_000,
      capabilities: {
        input_modalities: ["text", "image", "file"],
        output_modalities: ["text"],
        supports_function_calling: true,
        supports_response_schema: true,
      },
      list_pricing: { input_cost_per_token: 0.0000015, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.000000125 },
    });
    const opus = edenAIModel({
      id: "anthropic/claude-opus-4-6",
      owned_by: "anthropic",
      model_name: "claude-opus-4-6",
      context_length: null,
      capabilities: {
        input_modalities: ["text", "image", "file"],
        output_modalities: ["text"],
        supports_function_calling: true,
        supports_response_schema: true,
      },
      list_pricing: {
        input_cost_per_token: 0.000006,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
      },
    });
    const provider = { ...edenai, modelsDir, fetchModels: async () => ({ object: "list", data: [search, opus] }) };

    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 0, updated: 2, deleted: 0 });
    for (const [index, [id]] of files.entries()) {
      const after = await readFile(path.join(modelsDir, `${id}.toml`), "utf8");
      expect(after).not.toBe(before[index]);
      const unpriced = (text: string) => text.replace(/\[cost\.text\.input\]\nprice = [\d.]+/, "");
      expect(unpriced(after)).toBe(unpriced(before[index]!));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits Eden AI reasoning options for non-reasoning models", () => {
  const model = edenAIModel({
    id: "openai/gpt-4o-mini",
    model_name: "gpt-4o-mini",
    owned_by: "openai",
    context_length: 128_000,
  });

  const built = buildEdenAIModel(model);
  expect(built).toMatchObject({ base_model: "openai/gpt-4o-mini" });
  expect(built).not.toHaveProperty("reasoning_options");
});

test("skips Eden AI models without lab metadata", () => {
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "deepinfra/acme/Not-A-Real-Model",
        model_name: "acme/Not-A-Real-Model",
        owned_by: "deepinfra",
      }),
    ),
  ).toBeUndefined();
});

test("names Eden AI regional deployments after the canonical model", () => {
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "amazon/anthropic.claude-opus-5@eu",
        model_name: "anthropic.claude-opus-5",
        owned_by: "amazon",
      }),
    ),
  ).toMatchObject({
    base_model: "anthropic/claude-opus-5",
    name: "Claude Opus 5 (Amazon Bedrock, EU)",
  });
});

test("names Eden AI latest aliases as Latest plus the current target", () => {
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "anthropic/claude-fable-latest",
        model_name: "claude-fable-5-1",
        owned_by: "anthropic",
        alias_of: "anthropic/claude-fable-5-1",
      }),
    ),
  ).toMatchObject({
    base_model: "anthropic/claude-fable-5-1",
    name: "Claude Fable Latest (Claude Fable 5.1)",
  });
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "openai/gpt-latest",
        model_name: "gpt-6-astra",
        owned_by: "openai",
        alias_of: "openai/gpt-6-astra",
      }),
    ),
  ).toMatchObject({
    base_model: "openai/gpt-6-astra",
    name: "GPT Latest (GPT-6 Astra)",
  });
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "vertex/gemini-flash-latest@us",
        model_name: "gemini-3.8-flash",
        owned_by: "vertex",
        alias_of: "vertex/gemini-3.8-flash",
      }),
    ),
  ).toMatchObject({
    base_model: "google/gemini-3.8-flash",
    name: "Gemini Flash Latest (Gemini 3.8 Flash, Vertex AI, US)",
  });
});

test("names Eden AI non-primary hosts distinctly from the lab route", () => {
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "google/gemini-3.8-flash",
        model_name: "gemini-3.8-flash",
        owned_by: "google",
      }),
    ),
  ).not.toHaveProperty("name");
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "vertex/gemini-3.8-flash",
        model_name: "gemini-3.8-flash",
        owned_by: "vertex",
      }),
    ),
  ).toMatchObject({
    base_model: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Vertex AI)",
  });
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "vertex/gemini-3.8-flash@us",
        model_name: "gemini-3.8-flash",
        owned_by: "vertex",
      }),
    ),
  ).toMatchObject({
    base_model: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Vertex AI, US)",
  });
  expect(
    buildEdenAIModel(
      edenAIModel({
        id: "deepinfra/openai/gpt-oss-120b",
        model_name: "openai/gpt-oss-120b",
        owned_by: "deepinfra",
      }),
    ),
  ).toMatchObject({
    base_model: "openai/gpt-oss-120b",
    name: "GPT OSS 120B (Deep Infra)",
  });
});

test("does not treat Eden AI case-only aliases as latest pointers", () => {
  const built = buildEdenAIModel(
    edenAIModel({
      id: "flexai/deepseek-v4-flash-0731",
      model_name: "DeepSeek-V4-Flash-0731",
      owned_by: "flexai",
      alias_of: "flexai/DeepSeek-V4-Flash-0731",
    }),
  );
  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731 (FlexAI)",
  });
});

test("builds Eden AI context tiers without reading time-based cache keys", () => {
  const model = edenAIModel({
    id: "openai/gpt-5.6-terra",
    model_name: "gpt-5.6-terra",
    owned_by: "openai",
    list_pricing: {
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000012,
      input_cost_per_token_above_272k_tokens: 0.000004,
      output_cost_per_token_above_272k_tokens: 0.000018,
      cache_creation_input_token_cost_above_1hr: 0.000009,
      cache_creation_input_token_cost_above_1hr_above_272k_tokens: 0.00001,
    },
  });

  expect(buildEdenAIModel(model)).toMatchObject({
    cost: {
      input: 2,
      output: 12,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 4, output: 18 }],
    },
  });
  expect(
    (buildEdenAIModel(model) as { cost: { tiers: Array<Record<string, unknown>> } }).cost.tiers[0],
  ).not.toHaveProperty("cache_write");
});

test("keeps only the first-party Eden AI route when the lab's own API is relayed", () => {
  const bedrock = edenAIModel({
    id: "amazon/anthropic.claude-opus-5",
    model_name: "anthropic.claude-opus-5",
    owned_by: "amazon",
  });
  const direct = edenAIModel({
    id: "anthropic/claude-opus-5",
    model_name: "claude-opus-5",
    owned_by: "anthropic",
  });

  const firstParty = collectFirstPartyBaseModels([bedrock, direct]);
  expect(firstParty).toEqual(new Set(["anthropic/claude-opus-5"]));
  expect(buildEdenAIModel(bedrock, undefined, firstParty)).toBeUndefined();
  expect(buildEdenAIModel(direct, undefined, firstParty)).toMatchObject({
    base_model: "anthropic/claude-opus-5",
  });
});

test("keeps every Eden AI route for models with no first-party relay", () => {
  const models = ["deepinfra", "groq", "cerebras"].map((owner) =>
    edenAIModel({
      id: `${owner}/openai/gpt-oss-120b`,
      model_name: "openai/gpt-oss-120b",
      owned_by: owner,
    }),
  );

  const firstParty = collectFirstPartyBaseModels(models);
  expect(firstParty.size).toBe(0);
  const names = {
    deepinfra: "GPT OSS 120B (Deep Infra)",
    groq: "GPT OSS 120B (Groq)",
    cerebras: "GPT OSS 120B (Cerebras)",
  };
  for (const model of models) {
    expect(buildEdenAIModel(model, undefined, firstParty)).toMatchObject({
      base_model: "openai/gpt-oss-120b",
      name: names[model.owned_by as keyof typeof names],
    });
  }
});

test("resolves Eden AI aliases to the model they point at", () => {
  expect(
    resolveEdenAIBaseModel(
      edenAIModel({
        id: "anthropic/claude-opus-latest",
        model_name: "claude-opus-latest",
        owned_by: "anthropic",
        alias_of: "anthropic/claude-opus-5",
      }),
    ),
  ).toBe("anthropic/claude-opus-5");
});

test("resolves DeepInfra ByteDance IDs to canonical metadata", () => {
  expect(resolveDeepInfraBaseModel("ByteDance/Seed-2.0-code"))
    .toBe("bytedance-seed/seed-2.0-code");
});

test("DeepInfra preserves live modalities for new base models", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("Qwen/Qwen3.5-9B", ["multimodal", "input-video"]),
    undefined,
    "alibaba/qwen3.5-9b",
  );

  expect(model).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "image", "video"] },
  });
});

test("DeepInfra excludes incorrectly tagged Gemma 4 audio input", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("google/gemma-4-31B-it", ["multimodal", "input-audio", "input-video"]),
    { modalities: { input: ["text", "image", "audio", "video"] } },
    "google/gemma-4-31b-it",
  );

  expect(model).toMatchObject({
    modalities: { input: ["text", "image", "video"] },
  });
});

test("DeepInfra base_model entries carry no model facts", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("zai-org/GLM-5.2", ["reasoning"]),
    {
      base_model: "zhipuai/glm-5.2",
      family: "glm",
      release_date: "2020-01-01",
      last_updated: "2020-01-02",
      knowledge: "2019-01",
      open_weights: false,
    },
    "zhipuai/glm-5.2",
  );

  for (const key of ["family", "release_date", "last_updated", "knowledge", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
});

test("DeepInfra keeps an authored knowledge override on base_model entries", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("zai-org/GLM-5", ["reasoning"]),
    { base_model: "zhipuai/glm-5", knowledge: "2025-12" },
    "zhipuai/glm-5",
    { base_model: "zhipuai/glm-5", knowledge: "2025-12" },
  );
  expect(model).toMatchObject({ knowledge: "2025-12" });
});

test("DeepInfra writes service tiers, prompt caching and retention prices as v2 data", () => {
  const model: DeepInfraModel = {
    ...deepInfraModel("zai-org/GLM-5.2", []),
    pricing: {
      cents_per_input_token: 0.000075,
      cents_per_output_token: 0.00024,
      rate_per_input_token_cached: 0.2,
      rate_per_explicit_cache_write_token: { "5m": 1.25, "1h": 2 },
      explicit_cache_granularity_tokens: 1024,
      rate_per_service_tier_priority: 1.5,
      rate_per_service_tier_flex: 0.8,
    },
  };

  expect(deepInfraV2Set(model, { input: 0.75, cache_read: 0.15 }, undefined)).toEqual({
    "capabilities.cache": {
      implicit: true,
      explicit: { ttl: ["5m", "1h"], min_tokens: 1024 },
    },
    "capabilities.prompt_cache_key": true,
    "capabilities.service_tier": ["flex", "priority"],
    "cost.multipliers": [
      { when: { service_tier: { equals: "priority" } }, factor: 1.5 },
      { when: { service_tier: { equals: "flex" } }, factor: 0.8 },
    ],
    "cost.text.input.cache.explicit": { write: { "5m": 0.9375, "1h": 1.5 } },
  });

  // Without catalog values only paths the file already has are cleared.
  const plain = deepInfraModel("zai-org/GLM-5.2", []);
  expect(deepInfraV2Set(plain, { input: 0.75 }, undefined)).toBeUndefined();
  expect(deepInfraV2Set(plain, { input: 0.75 }, { capabilities: { service_tier: ["flex"] } })).toEqual({
    "capabilities.service_tier": undefined,
  });
});

test("DeepInfra price updates keep v2 data and restore the synced v2 values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-deepinfra-v2-"));
  const modelsDir = path.join(root, "providers", "deepinfra", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const id = "zai-org/GLM-5.2";
  const base = "zhipuai/glm-5.2";

  try {
    await mkdir(path.dirname(path.join(modelsDir, `${id}.toml`)), { recursive: true });
    await mkdir(path.dirname(path.join(root, "models", `${base}.toml`)), { recursive: true });
    await copyFile(path.join(repo, "models", `${base}.toml`), path.join(root, "models", `${base}.toml`));
    const shipped = await readFile(path.join(repo, "providers", "deepinfra", "models", `${id}.toml`), "utf8");
    // A stale price and a lost multiplier are both restored from the catalog.
    const stale = shipped
      .replace(/\[cost\.text\.input\]\nprice = [\d.]+/, "[cost.text.input]\nprice = 9")
      .replace(/\n\[\[cost\.multipliers\]\]\nwhen = \{ service_tier = \{ equals = "flex" \} \}\nfactor = [\d.]+\n/, "\n");
    expect(stale).not.toBe(shipped);
    await writeFile(path.join(modelsDir, `${id}.toml`), stale);

    const source: DeepInfraModel = {
      model_name: id,
      type: "text-generation",
      tags: ["openai", "tools", "json", "structured-output", "reasoning", "can-disable-reasoning", "priority", "flex"],
      pricing: {
        type: "tokens",
        cents_per_input_token: 0.000075,
        cents_per_output_token: 0.00024,
        rate_per_input_token_cached: 0.18666667,
        rate_per_input_token_cache_write: null,
        rate_per_service_tier_priority: 1.5,
        rate_per_service_tier_flex: 0.8,
        rate_per_explicit_cache_write_token: { "5m": 1.25, "1h": 2 },
        explicit_cache_granularity_tokens: 1024,
      },
      max_tokens: 1_048_576,
      deprecated: null,
      private: 0,
    };
    const provider = { ...deepinfra, modelsDir, fetchModels: async () => [source] };

    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(await readFile(path.join(modelsDir, `${id}.toml`), "utf8")).toBe(shipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DeepInfra clears stale caching and retention data when the catalog drops it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sync-deepinfra-v2-clear-"));
  const modelsDir = path.join(root, "providers", "deepinfra", "models");
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const id = "zai-org/GLM-5.2";
  const base = "zhipuai/glm-5.2";
  const source = (pricing: DeepInfraModel["pricing"]): DeepInfraModel => ({
    model_name: id,
    type: "text-generation",
    tags: ["openai", "tools", "json", "structured-output", "reasoning", "can-disable-reasoning"],
    pricing,
    max_tokens: 1_048_576,
    deprecated: null,
    private: 0,
  });

  try {
    await mkdir(path.dirname(path.join(modelsDir, `${id}.toml`)), { recursive: true });
    await mkdir(path.dirname(path.join(root, "models", `${base}.toml`)), { recursive: true });
    await copyFile(path.join(repo, "models", `${base}.toml`), path.join(root, "models", `${base}.toml`));
    await copyFile(path.join(repo, "providers", "deepinfra", "models", `${id}.toml`), path.join(modelsDir, `${id}.toml`));
    const read = async () => {
      const text = await readFile(path.join(modelsDir, `${id}.toml`), "utf8");
      return text.slice(text.indexOf("schema = 2"));
    };

    // Retention and service tiers gone, cache reads still priced.
    await syncProvider({
      ...deepinfra,
      modelsDir,
      fetchModels: async () => [source({
        cents_per_input_token: 0.000075,
        cents_per_output_token: 0.00024,
        rate_per_input_token_cached: 0.18666667,
      })],
    });
    let text = await read();
    expect(text).toContain("cache = { read = 0.14 }");
    expect(text).toContain("cache = { implicit = true }");
    expect(text).not.toContain("explicit");
    expect(text).not.toContain("service_tier");

    // No cache price at all: the cache table and capability go too.
    await syncProvider({
      ...deepinfra,
      modelsDir,
      fetchModels: async () => [source({ cents_per_input_token: 0.000075, cents_per_output_token: 0.00024 })],
    });
    text = await read();
    expect(text).not.toContain("cache");
    expect(text).not.toContain("prompt_cache_key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DeepInfra preserves descriptions for standalone models", () => {
  const model = buildDeepInfraModel(
    deepInfraModel("example/model", []),
    {
      name: "Example Model",
      description: "Authored standalone model description",
      release_date: "2026-01-01",
      last_updated: "2026-01-01",
      attachment: false,
      reasoning: false,
      tool_call: false,
      open_weights: true,
      cost: { input: 1, output: 2 },
      limit: { context: 262_144, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
  );

  expect(model).toMatchObject({
    description: "Authored standalone model description",
  });
});

test("W&B preserves curated model dates", () => {
  const model: WandbModel = {
    id: "example/model",
    name: "Example Model",
    description: "Example model used to verify W&B date preservation",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2024-07-01",
    last_updated: "2024-07-01",
    open_weights: true,
  };

  expect(buildWandbModel(model, {
    release_date: "2024-07-23",
    last_updated: "2024-07-23",
  })).toMatchObject({
    release_date: "2024-07-23",
    last_updated: "2024-07-23",
  });
});

test("W&B keeps hand-authored reasoning effort through a sync", () => {
  const model: WandbModel = {
    id: "zai-org/GLM-5.3",
    name: "GLM 5.3",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    release_date: "2026-10-16",
    last_updated: "2026-10-16",
    open_weights: true,
  };

  expect(buildWandbModel(model, {
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  }, undefined)).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  });
});

test("W&B takes on/off from the endpoint and effort from the authored file", () => {
  const effort = { type: "effort" as const, values: ["high" as const, "max" as const] };
  expect(mergeReasoningOptions([{ type: "toggle" }], [effort])).toEqual([{ type: "toggle" }, effort]);
  expect(mergeReasoningOptions([], [{ type: "toggle" }, effort])).toEqual([effort]);
  expect(mergeReasoningOptions([{ type: "toggle" }], [{ type: "effort", values: ["none", "high"] }]))
    .toEqual([{ type: "effort", values: ["none", "high"] }]);
  expect(mergeReasoningOptions([{ type: "toggle" }], [{ type: "toggle" }])).toEqual([{ type: "toggle" }]);
  expect(mergeReasoningOptions([], [{ type: "budget_tokens" }])).toEqual([]);
  expect(mergeReasoningOptions([], undefined)).toEqual([]);
});

test("base_model files from W&B, Hyper and Chutes leave model facts to the lab", () => {
  const facts = ["family", "release_date", "last_updated", "knowledge", "open_weights"];
  const wandb = buildWandbModel({
    id: "zai-org/GLM-5.2",
    name: "GLM 5.2",
    family: "glm",
    attachment: false,
    reasoning: true,
    tool_call: true,
    knowledge: "2020-01",
    release_date: "2020-01-02",
    last_updated: "2020-01-03",
    open_weights: false,
  } as WandbModel, undefined, "zhipuai/glm-5.2");
  const hyper = buildHyperModel(hyperModel({ id: "glm-5.2", created: 0 }), undefined, "zhipuai/glm-5.2");
  const chutes = buildChutesModel({ id: "zai-org/GLM-5.2-TEE", created: 0 }, undefined);
  for (const model of [wandb, hyper, chutes]) {
    expect(model).toMatchObject({ base_model: "zhipuai/glm-5.2" });
    for (const key of facts) expect(model).not.toHaveProperty(key);
  }
});

test("Hyper writes effort levels from lowest to highest", () => {
  const model = hyperModel({
    id: "glm-5.2",
    reasoning: { effort_levels: [{ value: "max" }, { value: "low" }, { value: "high" }] },
  });
  expect(buildHyperModel(model, undefined, "zhipuai/glm-5.2").reasoning_options)
    .toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
});

test("defaults new reasoning models to empty reasoning options", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined)).toEqual({
    reasoning: true,
    reasoning_options: [],
  });
});

test("inherits base reasoning options instead of stamping empty ones", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined, undefined, [{ type: "toggle" }]))
    .toEqual({ reasoning: true });
});

test("normalizes Cortecs file modalities to pdf", () => {
  const [model] = cortecs.parseModels({
    object: "list",
    data: [{
      id: "document-model",
      created: 1_775_088_000,
      pricing: { currency: "EUR", input_token: 1, output_token: 2 },
      context_size: 65_536,
      input_modalities: ["text", "file"],
      output_modalities: ["text"],
    }],
  });

  expect(model.input_modalities).toEqual(["text", "pdf"]);
});

test("preserves authored Cortecs reasoning options missing from the API", () => {
  const model: CortecsModel = {
    id: "deepseek-v4-flash-0731",
    created: 1_775_088_000,
    pricing: { currency: "EUR", input_token: 0.224, output_token: 0.269 },
    context_size: 1_048_576,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: ["reasoning", "tools"],
  };
  const existing: ExistingModel = {
    base_model: "deepseek/deepseek-v4-flash-0731",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  };

  expect(buildCortecsModel(model, existing, existing)).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  });
});

test("overrides canonical metadata with Cortecs reasoning support", () => {
  const model: CortecsModel = {
    id: "apertus-70b",
    created: 1_775_088_000,
    pricing: { currency: "EUR", input_token: 1.25, output_token: 2 },
    context_size: 65_536,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: ["reasoning", "tools"],
  };
  const existing: ExistingModel = {
    base_model: "swiss-ai/apertus-70b",
    reasoning: true,
    reasoning_options: [],
  };

  expect(buildCortecsModel(model, existing, existing)).toMatchObject({
    base_model: "swiss-ai/apertus-70b",
    reasoning: true,
    reasoning_options: [],
  });
});

function cortecsModel(overrides: Partial<CortecsModel> = {}): CortecsModel {
  return {
    id: "voxtral-small-2507",
    created: 1_775_088_000,
    pricing: { currency: "EUR", input_token: 0.11, output_token: 0.33 },
    context_size: 32_000,
    max_output_tokens: 32_000,
    input_modalities: ["text", "audio"],
    output_modalities: ["text"],
    supported_features: ["json_mode", "tools"],
    ...overrides,
  };
}

test("Cortecs base_model files leave model facts to the lab", () => {
  const existing: ExistingModel = {
    base_model: "mistral/voxtral-small-24b-2507",
    family: "voxtral",
    release_date: "2020-01-01",
    last_updated: "2020-01-01",
    knowledge: "2020-01",
    open_weights: false,
  };
  const model = buildCortecsModel(cortecsModel(), existing, existing);
  for (const key of ["family", "knowledge", "release_date", "last_updated", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
});

test("Cortecs linked files keep a display name and description that differ from the lab", async () => {
  const renamed: ExistingModel = {
    base_model: "mistral/voxtral-small-24b-2507",
    name: "voxtral-small-2507",
    description: "Host-specific description",
  };
  expect(buildCortecsModel(cortecsModel(), renamed, renamed)).toMatchObject({
    name: "voxtral-small-2507",
    description: "Host-specific description",
  });

  // The sync passes the resolved model, so values inherited from the lab
  // must not be written back as overrides.
  const lab = Bun.TOML.parse(
    await readFile(path.join(import.meta.dir, "../../../models/mistral/voxtral-small-24b-2507.toml"), "utf8"),
  ) as { name: string; description: string };
  const inherited: ExistingModel = {
    base_model: "mistral/voxtral-small-24b-2507",
    name: lab.name,
    description: lab.description,
  };
  const model = buildCortecsModel(cortecsModel(), inherited, inherited);
  expect(model).not.toHaveProperty("name");
  expect(model).not.toHaveProperty("description");
});

test("syncs OpenRouter reasoning efforts from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), undefined);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-5",
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ],
  });
});

test("syncs OpenRouter toggles without an effort selector", () => {
  for (const supports_max_tokens of [undefined, true]) {
    const source = openRouterModel({
      reasoning: { mandatory: false, supports_max_tokens },
    });
    const translated = openrouter.translateModel(source, {
      existing: () => undefined,
      authored: () => undefined,
    });
    expect(translated?.model.reasoning_options).toEqual([
      { type: "toggle" },
      ...(supports_max_tokens ? [{ type: "budget_tokens" }] : []),
    ]);
    expect(translated?.header).toStartWith("# Toggle: reasoning.enabled = true|false\n");
  }
});

test("does not derive OpenRouter controls for non-reasoning models", () => {
  const model = buildOpenRouterModel(openRouterModel({
    supported_parameters: ["temperature"],
    reasoning: { mandatory: false, supports_max_tokens: true },
  }), { reasoning_options: [{ type: "toggle" }] });
  expect(model.reasoning).toBe(false);
  expect(model.reasoning_options).toBeUndefined();
});

test("does not add OpenRouter toggles to mandatory or effort-none models", () => {
  for (const reasoning of [
    { mandatory: true, supports_max_tokens: true },
    { mandatory: true, supported_efforts: ["none", "high"] as const },
    { mandatory: false, supported_efforts: ["none", "high"] as const },
    { mandatory: false, supported_efforts: null },
  ]) {
    const [source] = openrouter.parseModels({ data: [{ ...openRouterModel(), reasoning }] });
    const model = buildOpenRouterModel(source!, undefined);
    expect(model.reasoning_options?.some((option) => option.type === "toggle")).toBe(false);
  }
});

test("uses OpenRouter model context when top provider reports a shorter context", () => {
  const model = buildOpenRouterModel(openRouterModel({
    context_length: 1_048_576,
    top_provider: {
      context_length: 32_000,
      max_completion_tokens: 8_192,
    },
  }), undefined);

  expect(model).toMatchObject({
    limit: {
      context: 1_048_576,
      output: 8_192,
    },
  });
});

test("uses a verified OpenRouter output limit over catalog metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    id: "minimax/minimax-01",
    context_length: 1_000_192,
    top_provider: {
      context_length: 1_000_192,
      max_completion_tokens: 900_172,
    },
  }), undefined);

  expect(model.limit?.output).toBe(40_000);
});

test("factors OpenRouter Pro routes against canonical OpenAI metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    id: "openai/gpt-5.6-sol-pro",
    name: "OpenAI: GPT-5.6 Sol Pro",
    knowledge_cutoff: "2026-02-16",
    context_length: 1_050_000,
    top_provider: {
      context_length: 1_050_000,
      max_completion_tokens: 128_000,
    },
  }), undefined);

  expect([
    resolveCanonicalBaseModel("openai/gpt-5.6-luna-pro"),
    resolveCanonicalBaseModel("openai/gpt-5.6-sol-pro"),
    resolveCanonicalBaseModel("openai/gpt-5.6-terra-pro"),
    resolveCanonicalBaseModel("anthropic/claude-opus-5-fast"),
    resolveCanonicalBaseModel("anthropic/claude-opus-4.8-fast"),
  ]).toEqual([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4-8",
  ]);
  expect(model).toMatchObject({
    base_model: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol Pro",
  });
  expect("family" in model).toBe(false);
  expect("release_date" in model).toBe(false);
});

test("resolves dotted Claude versions without a family allowlist", () => {
  expect(resolveCanonicalBaseModel("anthropic/claude-fable-5.1")).toBe("anthropic/claude-fable-5-1");
  expect(resolveCanonicalBaseModel("anthropic/claude-fable-5.1-fast")).toBe("anthropic/claude-fable-5-1");
  expect(resolveCanonicalBaseModel("anthropic/claude-opus-4.6")).toBe("anthropic/claude-opus-4-6");
  expect(resolveCanonicalBaseModel("anthropic/claude-3.5-sonnet-20241022")).toBe("anthropic/claude-3-5-sonnet-20241022");
  expect(resolveCanonicalBaseModel("anthropic/claude-unknown-99.1")).toBeUndefined();
});

test("resolves SpaceXAI provider IDs to canonical xAI metadata", () => {
  expect(resolveCanonicalBaseModel("spacexai/grok-4.5")).toBe("xai/grok-4.5");
});

// Ensures Merge Gateway namespaces reuse the matching canonical model metadata.
test("resolves Merge Gateway provider aliases to canonical metadata", () => {
  expect([
    resolveCanonicalBaseModel("bytedance-seed/seed-2.0-code"),
    resolveCanonicalBaseModel("bytedance/dola-seed-2.0-code"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.5"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.6"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.7-code"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.7-code-highspeed"),
    resolveCanonicalBaseModel("sakana/fugu-ultra"),
    resolveCanonicalBaseModel("meta/muse-glimmer-30b"),
  ]).toEqual([
    "bytedance-seed/seed-2.0-code",
    "bytedance-seed/seed-2.0-code",
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.7-code",
    "moonshotai/kimi-k2.7-code-highspeed",
    "sakana/fugu-ultra",
    "meta/muse-glimmer-30b",
  ]);
});

test("resolves Venice Pro routes to canonical OpenAI metadata", () => {
  expect([
    resolveVeniceBaseModel("openai-gpt-56-luna-pro", "GPT-5.6 Luna Pro"),
    resolveVeniceBaseModel("openai-gpt-56-sol-pro", "GPT-5.6 Sol Pro"),
    resolveVeniceBaseModel("openai-gpt-56-terra-pro", "GPT-5.6 Terra Pro"),
    resolveVeniceBaseModel("claude-opus-5-fast", "Claude Opus 5 Fast"),
    resolveVeniceBaseModel("claude-opus-4-8-fast", "Claude Opus 4.8 Fast"),
  ]).toEqual([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4-8",
  ]);
});

function veniceModel(overrides: Partial<VeniceModel["model_spec"]> = {}): VeniceModel {
  return {
    id: "claude-opus-4-8-fast",
    created: 1_780_000_000,
    model_spec: {
      name: "Claude Opus 4.8 Fast",
      availableContextTokens: 1_000_000,
      maxCompletionTokens: 128_000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
        reasoningEffortOptions: ["max", "high", "low", "xhigh", "medium"],
        supportsResponseSchema: true,
        supportsVision: true,
      },
      pricing: { input: { usd: 30 }, output: { usd: 150 } },
      ...overrides,
    },
  } as VeniceModel;
}

test("Venice base_model files carry no model facts and keep the catalog display name", () => {
  const synced = buildVeniceModel(veniceModel(), undefined, "anthropic/claude-opus-4-8") as Record<string, unknown>;
  expect(synced).toMatchObject({ base_model: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8 Fast" });
  for (const fact of ["family", "release_date", "last_updated", "knowledge", "open_weights", "description"]) {
    expect(synced).not.toHaveProperty(fact);
  }
  // A description equal to the lab's is factored out; the file's own one is kept.
  const lab = { description: "Top Claude Opus tier for the hardest reasoning, coding, and long-horizon agents" } as ExistingModel;
  expect(buildVeniceModel(veniceModel(), lab, "anthropic/claude-opus-4-8")).not.toHaveProperty("description");
  const own = { description: "Venice's own description" } as ExistingModel;
  expect(buildVeniceModel(veniceModel(), own, "anthropic/claude-opus-4-8")).toMatchObject(own);
});

test("Venice sync marks models with a scheduled removal as deprecated", () => {
  const deprecation = { date: "2026-10-30T00:00:00.000Z", removesAt: "2026-10-30T00:00:00.000Z", autoRemap: false };
  expect(buildVeniceModel(veniceModel({ deprecation }), undefined, "anthropic/claude-opus-4-8"))
    .toMatchObject({ status: "deprecated" });
  expect(buildVeniceModel(veniceModel(), undefined, "anthropic/claude-opus-4-8")).not.toHaveProperty("status");
});

test("Venice sync sorts reasoning efforts low to high", () => {
  expect(buildVeniceModel(veniceModel(), undefined, null)).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  });
});

test("Venice sync lists Responses after the first API and prices web search", () => {
  const responses = {
    base_url: "https://api.venice.ai/api/v1",
    sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
  };
  // A file with no table gets the provider's default Chat Completions API first.
  expect(withResponsesApi(undefined)).toEqual({ "chat-completions": {}, responses });
  const first = { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } };
  const once = withResponsesApi(first);
  expect(Object.keys(once)).toEqual(["chat-completions", "responses"]);
  expect(withResponsesApi(once)).toEqual(once);

  const capabilities = veniceModel().model_spec.capabilities;
  expect(veniceV2Set(veniceModel({ capabilities: { ...capabilities, supportsWebSearch: true } }))["cost.web_search"])
    .toEqual({ price: 10 });
  expect(veniceV2Set(veniceModel())["cost.web_search"]).toBeUndefined();
});

test("prefers OpenRouter API reasoning options over authored ones", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ],
  });
});

test("OpenRouter base_model files leave model facts to the lab", async () => {
  const { patchModelV2 } = await import("../src/model-file-v2.js");
  const { modelV2ToV1 } = await import("../src/translate.js");
  // A route with no canonical prefix, linked to its lab by hand, still carrying stale facts.
  const doc = {
    schema: 2,
    base_model: "aion-labs/aion-2.0",
    family: "llama",
    open_weights: true,
    knowledge: "2024-01",
    release_date: "2020-01-01",
    last_updated: "2020-02-01",
    capabilities: { reasoning: { supported: true } },
    cost: { text: { input: { price: 0.8 }, output: { price: 1.6 } } },
  };
  const { id: _id, ...existing } = modelV2ToV1({ ...doc, id: "aion-labs/aion-2.0" });
  const synced = buildOpenRouterModel(openRouterModel({
    id: "aion-labs/aion-2.0",
    name: "AionLabs: Aion 2.0",
    hugging_face_id: "aion-labs/aion-2.0",
    knowledge_cutoff: "2025-06-30",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["reasoning", "tools"],
    pricing: { prompt: "0.0000008", completion: "0.0000016" },
  }), existing as ExistingModel) as Record<string, unknown>;

  expect(synced.base_model).toBe("aion-labs/aion-2.0");
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(synced).not.toHaveProperty(fact);
  }
  const next = patchModelV2(doc, existing, synced);
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(next).not.toHaveProperty(fact);
  }
});

test("keeps authored OpenRouter reasoning options when API omits reasoning metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    supported_parameters: ["tools", "tool_choice", "reasoning", "temperature"],
    reasoning: undefined,
  }), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
  });
});

test("upgrades empty OpenRouter reasoning options from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for coding and agentic workflows",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high"] },
    ],
  });
});

test("factors new LLM Gateway models against the canonical base metadata", () => {
  const model = buildLLMGatewayModel(llmGatewayModel(), undefined);

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
  expect("name" in model).toBe(false);
  expect("modalities" in model).toBe(false);
});

test("syncs explicitly advertised LLM Gateway reasoning efforts", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    id: "seed-2-1-turbo",
    name: "Seed 2.1 Turbo",
    family: "bytedance",
    providers: [{
      reasoning_efforts: ["high", "none", "max", "low", "xhigh", "minimal", "medium"],
    }],
  }), undefined);

  expect(model).toMatchObject({
    reasoning_options: [{
      type: "effort",
      values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }],
  });
});

test("unions LLM Gateway reasoning efforts in canonical order", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    id: "unreviewed-reasoner",
    providers: [
      { reasoning_efforts: ["high", "low"] },
      { reasoning_efforts: ["none", "low", "xhigh"] },
    ],
  }), undefined);

  expect(model).toMatchObject({
    reasoning_options: [{
      type: "effort",
      values: ["none", "low", "high", "xhigh"],
    }],
  });
});

test("keeps curated LLM Gateway toggle controls over the effort union", () => {
  const curated = [
    { type: "toggle" as const },
    { type: "effort" as const, values: ["low", "high", "max"] },
  ];
  const model = buildLLMGatewayModel(llmGatewayModel({
    providers: [
      { reasoning_efforts: ["none", "low", "high", "max"] },
      { reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    ],
  }), {
    base_model: "anthropic/claude-fable-5",
    reasoning: true,
    reasoning_options: curated,
  });

  expect(model).toMatchObject({ reasoning_options: curated });
});

test("keeps non-effort LLM Gateway controls when syncing efforts", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    providers: [{ reasoning_efforts: ["none", "low", "high"] }],
  }), {
    name: "Claude Fable 5",
    reasoning: true,
    reasoning_options: [
      { type: "budget_tokens", min: 1024 },
      { type: "effort", values: ["low"] },
    ],
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "budget_tokens", min: 1024 },
      { type: "effort", values: ["none", "low", "high"] },
    ],
  });
});

test("factors aliased LLM Gateway routes against canonical metadata", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    id: "glm-5-2",
    name: "GLM-5.2 (260617)",
    family: "bytedance",
    context_length: 1_024_000,
    pricing: {
      prompt: "1.4e-6",
      completion: "4.4e-6",
      input_cache_read: "0.26e-6",
    },
  }), undefined);

  expect(model).toEqual({
    base_model: "zhipuai/glm-5.2",
    name: "GLM-5.2 (260617)",
    cost: {
      input: 1.4,
      output: 4.4,
      cache_read: 0.26,
    },
    limit: {
      context: 1_024_000,
    },
  });
});

test("factors mapped LLM Gateway entries against the root model metadata", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel(), undefined);

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    structured_output: true,
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
});

test("applies deployment capability flags on mapped factored entries", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    providers: [{ providerId: "anthropic", vision: false, tools: false, reasoning: false }],
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    max_output: 64_000,
  }), undefined);

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    attachment: false,
    reasoning: false,
    tool_call: false,
    structured_output: true,
    modalities: {
      input: ["text"],
    },
    limit: {
      output: 64_000,
    },
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
});

test("factors Grok LLM Gateway routes against xAI metadata", () => {
  const model = buildLLMGatewayModel(llmGatewayModel({
    id: "grok-4-6",
    name: "Grok 4.6",
    family: "grok",
    context_length: 500_000,
    pricing: {
      prompt: "2e-6",
      completion: "6e-6",
      input_cache_read: "0.5e-6",
    },
  }), undefined);

  expect(model).toEqual({
    base_model: "xai/grok-4.6",
    cost: {
      input: 2,
      output: 6,
      cache_read: 0.5,
    },
  });
});

test("prefers the gateway max_output over authored output on mapped resyncs", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({ max_output: 32_000 }), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    description: "Claude Fable 5 served by Anthropic",
    limit: { output: 64_000 },
  });

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    description: "Claude Fable 5 served by Anthropic",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    structured_output: true,
    limit: {
      output: 32_000,
    },
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
});

test("sorts mapped LLM Gateway deployment efforts low to high", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    providers: [{
      providerId: "anthropic",
      vision: true,
      tools: true,
      reasoning: true,
      reasoning_efforts: ["max", "xhigh", "none", "high", "low"],
    }],
  }), undefined);

  expect(model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh", "max"] }],
  });
});

test("keeps attachments and audio prices on mapped LLM Gateway audio deployments", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "openai/whisper-fable",
    name: "Whisper Fable (OpenAI)",
    family: "openai",
    architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] },
    providers: [{ providerId: "openai", vision: false, tools: false, reasoning: false }],
    pricing: { prompt: "2.5e-6", completion: "10e-6", input_audio: "6e-6" },
    context_length: 16_000,
    max_output: 2_000,
  }), {
    name: "Whisper Fable (OpenAI)",
    description: "Speech transcription model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: true,
    reasoning: false,
    tool_call: false,
    open_weights: false,
    modalities: { input: ["text", "audio"], output: ["text"] },
    limit: { context: 16_000, output: 2_000 },
  });

  expect(model).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "audio"], output: ["text"] },
    cost: { input: 2.5, output: 10, input_audio: 6 },
  });
});

test("translates a none-only effort list into a reasoning toggle", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    providers: [{ providerId: "anthropic", vision: true, tools: true, reasoning: true, reasoning_efforts: ["none"] }],
  }), undefined);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-fable-5",
    reasoning_options: [{ type: "toggle" }],
  });
});

test("realigns capability flags from the mapping on mapped factored resyncs", () => {
  // The deployment dropped reasoning and gained tools since the file was
  // written: the resync must move the booleans and the reasoning controls
  // together instead of clearing options under a frozen reasoning = true.
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    providers: [{ providerId: "anthropic", vision: true, tools: true, reasoning: false }],
  }), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: false,
  });

  expect(model).toMatchObject({ reasoning: false });
  expect(model!.reasoning_options).toBeUndefined();
  // Realigned to the mapping and now equal to the base, the stale
  // tool_call = false override is dropped and inherits the base again.
  expect(model!.tool_call).toBeUndefined();
});

test("restores image input when vision returns on mapped resyncs", () => {
  // The file was written while the deployment had no vision (text-only
  // stripped modalities); vision is back, so the stale override must clear.
  const factored = buildLLMGatewayMappedModel(llmGatewayMappedModel(), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    attachment: false,
    modalities: { input: ["text"] },
  });
  expect(factored!.modalities).toBeUndefined();
  expect(factored!.attachment).toBeUndefined();

  const full = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "acme/mystery-model",
    name: "Mystery Model (Acme)",
    family: undefined,
    providers: [{ providerId: "acme", vision: true, tools: true, reasoning: false }],
  }), {
    name: "Mystery Model (Acme)",
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  });
  expect(full).toMatchObject({
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  });
});

test("never synthesizes a description on mapped factored resyncs", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel(), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
  });

  // An unset description must keep inheriting the base's lab text instead of
  // being stamped with a sticky synthesized override on the first resync.
  expect(model).toBeDefined();
  expect(model!.description).toBeUndefined();
});

test("authors the toggle wire-path header on mapped sync creates", () => {
  const context = { existing: () => undefined, authored: () => undefined };

  const toggle = llmgatewayProviders.translateModel(llmGatewayMappedModel({
    providers: [{ providerId: "anthropic", vision: true, tools: true, reasoning: true, reasoning_efforts: ["none"] }],
  }), context);
  expect(toggle?.header).toStartWith("# Toggle: $.reasoning_effort");

  const effort = llmgatewayProviders.translateModel(llmGatewayMappedModel(), context);
  expect(effort?.model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  });
  expect(effort?.header).toBeUndefined();
});

test("keeps inheriting base output on factored resyncs without max_output", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({ max_output: undefined }), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    description: "Claude Fable 5 served by Anthropic",
  });

  expect(model).toEqual({
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    description: "Claude Fable 5 served by Anthropic",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    structured_output: true,
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    },
  });
});

test("skips unfactorable LLM Gateway creates without a served context", () => {
  // Unknown family, so no canonical base to inherit a context from.
  const mapped = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "acme/mystery-model",
    name: "Mystery Model (Acme)",
    family: undefined,
    context_length: undefined,
  }), undefined);
  expect(mapped).toBeUndefined();

  const aggregated = buildLLMGatewayModel(llmGatewayModel({
    id: "mystery-model",
    name: "Mystery Model",
    family: undefined,
    context_length: undefined,
  }), undefined);
  expect(aggregated).toBeUndefined();
});

test("keeps curated budget controls under deployment efforts", () => {
  // Deployment efforts own only the effort/toggle surface: the hand-authored
  // budget_tokens control (this host's $.reasoning.max_tokens path) survives
  // the resync, while the stale effort list is replaced.
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel(), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    reasoning_options: [
      { type: "effort", values: ["low", "high"] },
      { type: "budget_tokens", min: 1_024, max: 63_999 },
    ],
  });
  expect(model!.reasoning_options).toEqual([
    { type: "budget_tokens", min: 1_024, max: 63_999 },
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);

  // Same merge on creates, with the budget coming from the aggregated
  // sibling's curation for the same root model.
  const seeded = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Anthropic)",
  }), undefined);
  expect(seeded!.reasoning_options).toEqual([
    { type: "budget_tokens", min: 1_024, max: 63_999 },
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);
});

test("seeds context pricing tiers from the aggregated sibling on creates", () => {
  // The gateway API carries no tier pricing; without the sibling's curated
  // tiers the bulk sync would author tiered models at flat long-context rates.
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "openai/gpt-5.5",
    name: "GPT-5.5 (OpenAI)",
    family: "openai",
  }), undefined);

  expect(model!.cost?.tiers).toEqual([
    { tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache_read: 1 },
  ]);
});

test("LLM Gateway base_model files leave model facts to the lab", () => {
  const model = buildLLMGatewayModel(llmGatewayModel(), {
    base_model: "anthropic/claude-fable-5",
    family: "claude-fable",
    knowledge: "2020-01",
    release_date: "2020-01-01",
    last_updated: "2020-01-01",
    open_weights: true,
  });
  for (const key of ["family", "knowledge", "release_date", "last_updated", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
});

test("LLM Gateway keeps its display name on linked files", () => {
  // A resync keeps the authored name override; a new linked file takes the
  // catalog name where it differs from the lab.
  const resync = buildLLMGatewayModel(llmGatewayModel({ name: "Renamed Upstream" }), {
    base_model: "anthropic/claude-fable-5",
    name: "Claude Fable Five",
  });
  expect(resync).toMatchObject({ name: "Claude Fable Five" });

  const created = buildLLMGatewayModel(llmGatewayModel({ name: "Claude Fable Five" }), undefined);
  expect(created).toMatchObject({ base_model: "anthropic/claude-fable-5", name: "Claude Fable Five" });

  const same = buildLLMGatewayModel(llmGatewayModel({ name: "Claude Fable 5" }), undefined);
  expect(same).not.toHaveProperty("name");
});

test("LLM Gateway linked files drop a description equal to the lab's", () => {
  // The sync passes the resolved existing model, so an inherited description
  // must not be written back as an override; a real delta stays.
  const inherited = buildLLMGatewayModel(llmGatewayModel(), {
    base_model: "anthropic/claude-fable-5",
    description: "Claude model for creative writing, analysis, and controlled agent workflows",
  });
  expect(inherited).not.toHaveProperty("description");

  const delta = buildLLMGatewayModel(llmGatewayModel(), {
    base_model: "anthropic/claude-fable-5",
    description: "Host-specific description",
  });
  expect(delta).toMatchObject({ description: "Host-specific description" });
});

test("reads curation from v2 aggregated siblings", () => {
  // providers/llmgateway/models/Qwen3.8-27B.toml is a v2 file whose effort
  // list lives under [capabilities]; mapped deployments still inherit it.
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "novita/qwen3.8-27b",
    name: "Qwen3.8 27B (NovitaAI)",
    family: "alibaba",
    providers: [{ providerId: "novita", vision: false, tools: true, reasoning: true }],
  }), undefined);
  expect(model!.reasoning_options).toEqual([{ type: "effort", values: ["low", "medium", "xhigh"] }]);
});

test("factors perplexity entries without widening the shared prefix map", () => {
  // The perplexity family resolves through resolveModelMetadataBaseModel's
  // exact models/ path match; CANONICAL_PROVIDER_PREFIXES stays untouched so
  // other hosts' standalone perplexity files keep their current behavior.
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "perplexity/sonar-pro",
    name: "Sonar Pro (Perplexity)",
    family: "perplexity",
  }), undefined);

  expect(model).toMatchObject({ base_model: "perplexity/sonar-pro" });
});

test("refuses to author a zero context on full LLM Gateway resyncs", () => {
  // Existing full rows (no base to inherit from) with nothing usable from the
  // API or the file must fail loudly instead of being rewritten with
  // limit.context = 0.
  expect(() => buildLLMGatewayMappedModel(llmGatewayMappedModel({
    context_length: undefined,
    max_output: undefined,
  }), {
    name: "Claude Fable 5 (Anthropic)",
  })).toThrow("no usable context");

  // An authored 0 on disk is as unusable as an absent context.
  expect(() => buildLLMGatewayMappedModel(llmGatewayMappedModel({
    context_length: 0,
    max_output: undefined,
  }), {
    name: "Claude Fable 5 (Anthropic)",
    limit: { context: 0 },
  })).toThrow("no usable context");

  expect(() => buildLLMGatewayModel(llmGatewayModel({
    context_length: undefined,
  }), {
    name: "Claude Fable 5",
  })).toThrow("no usable context");
});

test("leaves context unset on mapped factored creates without a served context", () => {
  const model = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    context_length: undefined,
    max_output: undefined,
  }), undefined);

  // Everything limit-related inherits from the base; no zero is authored.
  expect(model).toBeDefined();
  expect("limit" in model!).toBe(false);
});

test("strips image input when the deployment has no vision", () => {
  // The model-level architecture still claims image input; the deployment
  // flag must win on both the factored and the unfactored path.
  const factored = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    providers: [{ providerId: "anthropic", vision: false, tools: true, reasoning: false }],
  }), undefined);
  expect(factored).toMatchObject({
    base_model: "anthropic/claude-fable-5",
    attachment: false,
    modalities: { input: ["text"] },
  });

  const full = buildLLMGatewayMappedModel(llmGatewayMappedModel({
    id: "acme/mystery-model",
    name: "Mystery Model (Acme)",
    family: undefined,
    providers: [{ providerId: "acme", vision: false, tools: true, reasoning: false }],
  }), undefined);
  expect(full).toMatchObject({
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  });
});

test("keeps the last LLM Gateway entry for case-insensitive duplicate IDs", () => {
  const first = llmGatewayModel({ id: "qwen3.8-27b", family: "alibaba" });
  const other = llmGatewayModel();
  for (const id of [first.id, "Qwen3.8-27B"]) {
    const last = llmGatewayModel({
      id,
      family: "consensusprotocol",
      context_length: 32_768,
      pricing: { prompt: "0.41e-6", completion: "2.5e-6" },
    });
    expect(llmgateway.parseModels({ data: [first, other, last] })).toEqual([last, other]);
    expect(llmgateway.parseModels({ data: [last, other, first] })).toEqual([first, other]);
  }
  const nonText = llmGatewayModel({
    id: first.id,
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  });
  expect(llmgateway.parseModels({ data: [first, nonText] })).toEqual([first]);
});

test("syncs the last LLM Gateway case variant without mixing source records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-llmgateway-case-"));
  const modelsDir = path.join(root, "providers", "llmgateway", "models");
  await mkdir(modelsDir, { recursive: true });
  const first = llmGatewayModel({ id: "qwen3.8-27b", family: undefined });
  const last = llmGatewayModel({
    id: "Qwen3.8-27B",
    family: undefined,
    context_length: 32_768,
    pricing: { prompt: "0.41e-6", completion: "2.5e-6" },
  });
  const provider = { ...llmgateway, modelsDir, fetchModels: async () => ({ data: [first, last] }) };

  try {
    await syncProvider({ ...provider, fetchModels: async () => ({ data: [first] }) });
    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 1 });
    expect(await Bun.file(path.join(modelsDir, `${first.id}.toml`)).exists()).toBe(false);
    const written = Bun.TOML.parse(await readFile(path.join(modelsDir, `${last.id}.toml`), "utf8"));
    expect(written).toMatchObject({
      cost: { input: 0.41, output: 2.5 },
      limit: { context: 32_768 },
    });
    expect(written.cost).not.toHaveProperty("cache_write");
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses empty responses in both LLM Gateway syncs", () => {
  expect(() => llmgateway.parseModels({ data: [] })).toThrow("no text models");
  expect(() => llmgatewayProviders.parseModels({ data: [] })).toThrow("mapped view unavailable");
});

test("refuses aggregated responses in the mapped LLM Gateway sync", () => {
  expect(() => llmgatewayProviders.parseModels({ data: [llmGatewayModel()] }))
    .toThrow("mapped view unavailable");
});

test("filters pseudo and non-text entries from the mapped LLM Gateway sync", () => {
  const parsed = llmgatewayProviders.parseModels({
    data: [
      llmGatewayMappedModel(),
      llmGatewayMappedModel({ id: "llmgateway/auto", name: "Auto Route (LLM Gateway)" }),
      llmGatewayMappedModel({
        id: "openai/sora-2",
        name: "Sora 2 (OpenAI)",
        architecture: { input_modalities: ["text"], output_modalities: ["video"] },
      }),
    ],
  });

  expect(parsed.map((model) => model.id)).toEqual(["anthropic/claude-fable-5"]);
});

test("refuses mapped LLM Gateway entries without exactly one provider mapping", () => {
  expect(() => llmgatewayProviders.parseModels({
    data: [llmGatewayMappedModel({ providers: undefined })],
  })).toThrow("without exactly one provider mapping");

  expect(() => llmgatewayProviders.parseModels({
    data: [llmGatewayMappedModel({ providers: [] })],
  })).toThrow("without exactly one provider mapping");

  expect(() => llmgatewayProviders.parseModels({
    data: [
      llmGatewayMappedModel(),
      llmGatewayMappedModel({
        id: "azure/gpt-5.5",
        name: "GPT-5.5 (Azure)",
        providers: [{ providerId: "azure" }, { providerId: "openai" }],
      }),
    ],
  })).toThrow("azure/gpt-5.5");

  // Entries the sync drops anyway (pseudo-models, non-text) may lack a
  // mapping without tripping the guard.
  const parsed = llmgatewayProviders.parseModels({
    data: [
      llmGatewayMappedModel(),
      llmGatewayMappedModel({
        id: "llmgateway/auto",
        name: "Auto Route (LLM Gateway)",
        providers: undefined,
      }),
    ],
  });
  expect(parsed.map((model) => model.id)).toEqual(["anthropic/claude-fable-5"]);
});

// Ensures catalog pagination preserves authentication and returns every page.
test("fetches every page of the Merge Gateway catalog", async () => {
  const requests: string[] = [];
  const authorizations: string[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
    const next = url.includes("cursor=next-page");
    return Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [mergeGatewayModel({
        model: next ? "openai/gpt-5.6-terra" : "openai/gpt-5.6-sol",
        display_name: next ? "GPT-5.6 Terra" : "GPT-5.6 Sol",
      })],
      has_more: !next,
      next_cursor: next ? null : "next-page",
    })));
  }) as typeof fetch;

  const result = await fetchMergeGatewayModels(fetcher, "test-key");

  expect(result.data.map((model) => model.model)).toEqual([
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain("limit=500");
  expect(requests[1]).toContain("cursor=next-page");
  expect(authorizations).toEqual(["Bearer test-key", "Bearer test-key"]);
});

// Prevents pagination overlap from publishing the same model ID twice.
test("rejects duplicate Merge Gateway model IDs across pages", async () => {
  const fetcher = ((input: string | URL | Request) => {
    const next = String(input).includes("cursor=next-page");
    return Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [mergeGatewayModel()],
      has_more: !next,
      next_cursor: next ? null : "next-page",
    })));
  }) as typeof fetch;

  expect(fetchMergeGatewayModels(fetcher, "test-key")).rejects.toThrow(
    "Merge Gateway returned duplicate model ID: openai/gpt-5.6-sol",
  );
});

// Rejects API records whose provider disagrees with the model ID namespace.
test("rejects Merge Gateway provider and model namespace mismatches", () => {
  expect(() => MergeGatewayResponse.parse({
    object: "list",
    data: [mergeGatewayModel({ provider: "anthropic" })],
    has_more: false,
    next_cursor: null,
  })).toThrow("Model namespace openai does not match provider anthropic");
});

// Keeps audio-capable records valid when the API advertises audio input.
test("accepts audio modalities from the Merge Gateway catalog", () => {
  const model = mergeGatewayModel();
  model.vendors.openai.capabilities.input.push("audio");

  expect(MergeGatewayResponse.parse({
    object: "list",
    data: [model],
    has_more: false,
    next_cursor: null,
  }).data[0]?.vendors.openai.capabilities.input).toContain("audio");
});

// Prevents a valid multimodal route from rejecting the entire live catalog.
test("accepts video modalities from the Merge Gateway catalog", () => {
  const model = mergeGatewayModel();
  model.vendors.openai.capabilities.input.push("video");

  const parsed = MergeGatewayResponse.parse({
    object: "list",
    data: [model],
    has_more: false,
    next_cursor: null,
  }).data[0]!;

  expect(parsed.vendors.openai.capabilities.input).toContain("video");
  expect(buildMergeGatewayModel(parsed, undefined)).toMatchObject({
    modalities: {
      input: ["text", "image", "pdf", "video"],
    },
  });
});

// Keeps the API boundary forward-compatible while output normalization remains strict.
test("filters unknown Merge Gateway modalities without rejecting the catalog", () => {
  const model = mergeGatewayModel();
  model.vendors.openai.capabilities.input.push("future_modality");
  model.vendors.openai.capabilities.output.push("future_output_modality");

  const parsed = MergeGatewayResponse.parse({
    object: "list",
    data: [model],
    has_more: false,
    next_cursor: null,
  }).data[0]!;
  const synced = buildMergeGatewayModel(parsed, undefined);

  expect(synced).toEqual({
    base_model: "openai/gpt-5.6-sol",
    structured_output: true,
    cost: {
      input: 5,
      output: 30,
    },
  });
});

// Emits only route-specific overrides when canonical metadata already matches.
test("factors Merge Gateway GPT-5.6 Sol against canonical metadata", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel(), undefined);

  expect(model).toEqual({
    base_model: "openai/gpt-5.6-sol",
    structured_output: true,
    cost: {
      input: 5,
      output: 30,
    },
  });
});

// Protects curated reasoning metadata from an unreliable negative API signal.
test("preserves curated reasoning when Merge Gateway routes report supports_reasoning = false", () => {
  // `supports_reasoning = false` is a positive-only signal: the field is
  // undocumented in the public schema and inconsistently populated across
  // vendor routes, so it must not erase curated reasoning metadata.
  const vendor = mergeGatewayVendor();
  vendor.capabilities.supports_reasoning = false;
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: { openai: vendor },
  }), {
    base_model: "openai/gpt-5.6-sol",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    cost: { input: 5, output: 30 },
  });

  expect(model).toMatchObject({
    base_model: "openai/gpt-5.6-sol",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  });
  expect(model).not.toMatchObject({ reasoning: false });
});

// Treats a positive signal from any available route as model-level confirmation.
test("confirms reasoning when any available Merge Gateway route reports supports_reasoning = true", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.supports_reasoning = false;
  const confirming = mergeGatewayVendor({
    pricing: { currency: "USD", input_per_million: 9, output_per_million: 45 },
  });
  confirming.capabilities.supports_reasoning = true;
  confirming.capabilities.reasoning = {
    configurable: false,
    disable_supported: false,
    default_enabled: true,
    controls: [],
    output_style: "reasoning_content",
  };
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: { openai: selected, fireworks: confirming },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: { input: 5, output: 30 },
  });

  // The model reasons on the gateway with no verified caller control.
  expect(model).toMatchObject({ reasoning_options: [] });
  expect(model).not.toMatchObject({ reasoning: false });
});

// The live catalog emits reasoning: null on some routes even when
// supports_reasoning is true. Treat that as unknown controls, not a crash.
test("tolerates a null Merge Gateway reasoning object when reasoning is confirmed", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.supports_reasoning = true;
  selected.capabilities.reasoning = null;
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: { openai: selected },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: { input: 5, output: 30 },
  });

  expect(model).toMatchObject({ reasoning_options: [] });
  expect(model).not.toMatchObject({ reasoning: false });
});

// Publishes a toggle only when the selected route explicitly supports disabling reasoning.
test("derives a Merge Gateway reasoning toggle when the selected route supports disabling", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.reasoning = {
    configurable: true,
    disable_supported: true,
    default_enabled: true,
    controls: ["thinking"],
    output_style: "reasoning_content",
  };
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: { openai: selected },
  }), {
    base_model: "openai/gpt-5.6-sol",
    reasoning: true,
    reasoning_options: [],
    cost: { input: 5, output: 30 },
  });

  expect(model).toMatchObject({ reasoning_options: [{ type: "toggle" }] });
});

test("syncs Merge Gateway explicitly advertised thinking budgets", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.supports_reasoning = true;
  selected.capabilities.reasoning = {
    configurable: true,
    disable_supported: true,
    default_enabled: false,
    controls: ["thinking.budget_tokens"],
    output_style: "reasoning_content",
  };
  const source = mergeGatewayModel({ vendors: { openai: selected } });
  const translated = mergeGateway.translateModel(source, {
    existing: () => ({ reasoning: true, reasoning_options: [] }),
    authored: () => undefined,
  });
  expect(translated?.model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "budget_tokens" },
  ]);
  expect(translated?.header).toStartWith('# Toggle: thinking.type = "enabled"|"disabled"');

  selected.capabilities.reasoning.disable_supported = false;
  expect(buildMergeGatewayModel(source, { reasoning: true })?.reasoning_options).toEqual([
    { type: "budget_tokens" },
  ]);
});

test("does not infer Merge Gateway budgets from other controls or output limits", () => {
  for (const controls of [undefined, [], ["thinking"], ["max_tokens"], ["reasoning.effort"]]) {
    const selected = mergeGatewayVendor();
    selected.capabilities.reasoning = { configurable: true, controls };
    const model = buildMergeGatewayModel(mergeGatewayModel({ vendors: { openai: selected } }), {
      reasoning: true,
      reasoning_options: [],
    });
    expect(model?.reasoning_options).toEqual([]);
  }
});

test("preserves curated Merge Gateway controls when a budget is advertised", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.reasoning = { controls: ["thinking.budget_tokens"] };
  const reasoning_options = [{ type: "effort" as const, values: ["high"] }];
  const model = buildMergeGatewayModel(mergeGatewayModel({ vendors: { openai: selected } }), {
    reasoning: true,
    reasoning_options,
  });
  expect(model?.reasoning_options).toEqual(reasoning_options);
});

// Effort control yields toggle + effort, not a bare toggle (claude-opus-5 regression).
test("derives Merge Gateway toggle + effort from an effort control", () => {
  const selected = mergeGatewayVendor({
    pricing: { currency: "USD", input_per_million: 5, output_per_million: 25 },
  });
  selected.capabilities.reasoning = {
    configurable: true,
    disable_supported: true,
    default_enabled: true,
    controls: ["reasoning.effort"],
    effort_values: ["low", "medium", "high", "xhigh", "max"],
    output_style: "hidden",
  };
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "anthropic/claude-opus-5",
    provider: "anthropic",
    display_name: "Claude Opus 5",
    vendors: { anthropic: selected },
  }), {
    base_model: "anthropic/claude-opus-5",
    reasoning: true,
    reasoning_options: [],
    cost: { input: 5, output: 25 },
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ],
  });
});

// Effort control without disable support yields effort only.
test("derives Merge Gateway effort without a toggle when disable is unsupported", () => {
  const selected = mergeGatewayVendor({
    pricing: { currency: "USD", input_per_million: 5, output_per_million: 25 },
  });
  selected.capabilities.reasoning = {
    configurable: true,
    disable_supported: false,
    default_enabled: true,
    controls: ["reasoning.effort"],
    effort_values: ["low", "medium", "high", "xhigh", "max"],
    output_style: "hidden",
  };
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    display_name: "Claude Sonnet 5",
    vendors: { anthropic: selected },
  }), {
    base_model: "anthropic/claude-sonnet-5",
    reasoning: true,
    reasoning_options: [],
    cost: { input: 3, output: 15 },
  });

  expect(model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  });
});

// Prevents deprecated routes from contributing capabilities to an available model.
test("ignores supports_reasoning = true on unavailable Merge Gateway routes", () => {
  const selected = mergeGatewayVendor();
  selected.capabilities.supports_reasoning = false;
  const deprecated = mergeGatewayVendor({ availability_status: "deprecated" });
  deprecated.capabilities.supports_reasoning = true;
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: { openai: selected, legacy: deprecated },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: { input: 5, output: 30 },
  });

  expect(model).not.toHaveProperty("reasoning_options");
});

// Updates API-provided cache prices without discarding curated cache fields.
test("merges authoritative Merge Gateway cache pricing field by field", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: {
      openai: mergeGatewayVendor({
        pricing: {
          currency: "USD",
          input_per_million: 3.75,
          output_per_million: 22.5,
        },
        prompt_caching: {
          mode: "automatic",
          cache_read_cost_per_million: 0.375,
        },
      }),
    },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: {
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
    },
  });

  expect(model).toEqual({
    base_model: "openai/gpt-5.6-sol",
    structured_output: true,
    cost: {
      input: 3.75,
      output: 22.5,
      cache_read: 0.375,
      cache_write: 6.25,
    },
  });
});

// Retains curated cache prices when the API confirms caching but omits prices.
test("preserves Merge Gateway cache pricing when prompt caching exposes only its mode", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: {
      openai: mergeGatewayVendor({
        prompt_caching: { mode: "automatic" },
      }),
    },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: {
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
    },
  });

  expect(model).toMatchObject({
    cost: {
      cache_read: 0.5,
      cache_write: 6.25,
    },
  });
});

// Removes inherited cache prices when the selected route explicitly disables caching.
test("removes Merge Gateway cache pricing when prompt caching mode is none", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: {
      openai: mergeGatewayVendor({
        prompt_caching: { mode: "none" },
      }),
    },
  }), {
    base_model: "openai/gpt-5.6-sol",
    cost: {
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
    },
  });

  expect(model).toMatchObject({
    cost: { input: 5, output: 30 },
  });
  expect(model.cost).not.toHaveProperty("cache_read");
  expect(model.cost).not.toHaveProperty("cache_write");
});

// Avoids overriding a curated name with a display value that is effectively an ID.
test("inherits canonical names for ID-shaped Merge Gateway display names", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "minimax/minimax-m2",
    provider: "minimax",
    display_name: "MiniMaxAI/MiniMax-M2",
    vendors: { minimax: mergeGatewayVendor() },
  }), undefined);

  expect(model).not.toHaveProperty("name");
});

// Avoids overriding a curated name with an unformatted model slug.
test("inherits canonical names for slug-shaped Merge Gateway display names", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "openai/gpt-oss-safeguard-120b",
    display_name: "gpt-oss-safeguard-120b",
    vendors: { openai: mergeGatewayVendor() },
  }), undefined);

  expect(model).not.toHaveProperty("name");
});

// Removes a canonical input limit that exceeds the selected route's context window.
test("omits inherited input limits above the Merge Gateway context", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "openai/gpt-5-chat-latest",
    display_name: "GPT-5 Chat Latest",
    vendors: {
      openai: mergeGatewayVendor({
        context_window: 128_000,
        max_output_tokens: 16_384,
      }),
    },
  }), {
    base_model: "openai/gpt-5-chat-latest",
    limit: {
      context: 128_000,
      input: 272_000,
      output: 16_384,
    },
  }, {
    base_model: "openai/gpt-5-chat-latest",
    limit: {
      context: 128_000,
      output: 16_384,
    },
  });

  expect(model).toHaveProperty("base_model_omit", ["limit.input"]);
});

// Prefers the model provider's own route over alternate vendors.
test("uses the canonical Merge Gateway vendor as the catalog baseline", () => {
  const model = mergeGatewayModel({
    vendors: {
      azure: mergeGatewayVendor({ context_window: 200_000 }),
      openai: mergeGatewayVendor({ context_window: 1_050_000 }),
    },
  });

  expect(selectMergeGatewayVendor(model)).toMatchObject({
    id: "openai",
    info: { context_window: 1_050_000 },
  });
});

// Falls back to the lowest-cost available route when the canonical vendor is absent.
test("uses Merge Gateway's cheapest fallback route when no canonical route exists", () => {
  const model = mergeGatewayModel({
    provider: "qwen",
    vendors: {
      bedrock: mergeGatewayVendor({
        pricing: { currency: "USD", input_per_million: 0.15, output_per_million: 0.6 },
      }),
      alibaba: mergeGatewayVendor({
        pricing: { currency: "USD", input_per_million: 0.287, output_per_million: 0.64 },
      }),
    },
  });

  expect(selectMergeGatewayVendor(model)).toMatchObject({
    id: "bedrock",
    info: { pricing: { input_per_million: 0.15, output_per_million: 0.6 } },
  });
});

// Keeps API insertion order deterministic when fallback routes have equal prices.
test("uses Merge Gateway's CMS order to break equal-cost fallback ties", () => {
  const model = mergeGatewayModel({
    provider: "qwen",
    vendors: {
      empiriolabs: mergeGatewayVendor({
        pricing: { currency: "USD", input_per_million: 0.4, output_per_million: 1.6 },
      }),
      fireworks: mergeGatewayVendor({
        pricing: { currency: "USD", input_per_million: 0.4, output_per_million: 1.6 },
      }),
    },
  });

  expect(selectMergeGatewayVendor(model)).toMatchObject({ id: "empiriolabs" });
});

// Prevents a scoped API response from deleting catalog entries it cannot see.
test("retains Merge Gateway models missing from an API-key-scoped response", () => {
  expect(mergeGateway.deleteMissing).toBe(false);
});

test("sorts Merge Gateway effort values from low to high", () => {
  expect(mergeGatewayReasoningOptions({
    disable_supported: false,
    controls: ["reasoning_effort"],
    effort_values: ["high", "max", "low", "none", "medium"],
  })).toEqual([{ type: "effort", values: ["none", "low", "medium", "high", "max"] }]);
});

test("maps Merge Gateway long-context pricing to a context tier", () => {
  const model = buildMergeGatewayModel(mergeGatewayModel({
    vendors: {
      openai: mergeGatewayVendor({
        pricing: {
          currency: "USD",
          input_per_million: 5,
          output_per_million: 30,
          cache_read_per_million: 0.5,
          cache_write_per_million: 5,
          long_context: {
            threshold_tokens: 272_000,
            input_per_million: 8,
            output_per_million: null,
            cache_read_per_million: 0.8,
            cache_write_per_million: null,
          },
        },
      }),
    },
  }), undefined);

  // A null long-context rate keeps the base rate.
  expect(model.cost?.tiers).toEqual([{
    tier: { type: "context", size: 272_000 },
    input: 8,
    output: 30,
    cache_read: 0.8,
    cache_write: 5,
  }]);
});

test("leaves the price of Merge Gateway routes billed per second to the file", () => {
  const vendor = mergeGatewayVendor({
    context_window: 448_000,
    max_output_tokens: 4_096,
    pricing: { currency: "USD", input_per_million: 0, output_per_million: 0, unit: "per_second", input_per_second: 0.0001 },
  });
  vendor.capabilities = { ...vendor.capabilities, input: ["audio"], output: ["text"], supports_tool_calling: false, supports_structured_outputs: false };
  const model = buildMergeGatewayModel(mergeGatewayModel({
    model: "openai/whisper-1",
    display_name: "Whisper",
    vendors: { openai: vendor },
  }), { base_model: "openai/whisper-1" });

  expect(model).toBeDefined();
  expect(model).not.toHaveProperty("cost");
});

test("Merge Gateway v2 base_model files keep the display name and leave model facts to the lab", () => {
  const lab = Bun.TOML.parse(readFileSync(path.join(import.meta.dir, "../../../models/openai/gpt-5.6-sol.toml"), "utf8")) as Record<string, any>;
  const model = buildMergeGatewayModel(mergeGatewayModel({ display_name: "GPT 5.6 Sol (Merge)" }), {
    base_model: "openai/gpt-5.6-sol",
    description: lab.description,
    family: lab.family,
    release_date: lab.release_date,
    last_updated: "2026-07-09",
    knowledge: lab.knowledge,
    open_weights: lab.open_weights,
  });

  expect(model).toMatchObject({ base_model: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol (Merge)" });
  for (const fact of ["description", "family", "release_date", "last_updated", "knowledge", "open_weights"]) {
    expect(model).not.toHaveProperty(fact);
  }
});

test("writes the Merge Gateway toggle wire path for every toggle", () => {
  const vendor = mergeGatewayVendor();
  vendor.capabilities = {
    ...vendor.capabilities,
    supports_reasoning: true,
    reasoning: { configurable: true, disable_supported: true, controls: ["thinking"], effort_values: [] },
  };
  const translated = mergeGateway.translateModel(mergeGatewayModel({
    model: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
    display_name: "DeepSeek V4 Pro",
    vendors: { deepseek: vendor },
  }), { existing: () => undefined, authored: () => undefined });

  expect(translated && "model" in translated ? translated.model.reasoning_options : undefined).toEqual([{ type: "toggle" }]);
  expect(translated?.header).toStartWith('# Toggle: thinking.type = "enabled"|"disabled"');
});

test("translates Vercel pricing tiers with an implicit zero minimum", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      created: 1_780_963_200,
      context_window: 1_050_000,
      max_tokens: 128_000,
      type: "language",
      pricing: {
        input: "0.000001",
        output: "0.000006",
        input_cache_read: "0.0000001",
        input_cache_read_tiers: [
          { cost: "0.0000001", max: 272_000 },
          { cost: "0.0000002", min: 272_000 },
        ],
        input_tiers: [
          { cost: "0.000001", max: 272_000 },
          { cost: "0.000002", min: 272_000 },
        ],
        output_tiers: [
          { cost: "0.000006", max: 272_000 },
          { cost: "0.000009", min: 272_000 },
        ],
      },
    }],
  });

  expect(model).toBeDefined();
  const synced = buildVercelModel(model!, undefined);
  expect(synced).toMatchObject({
    cost: {
      input: 1,
      output: 6,
      cache_read: 0.1,
      tiers: [{
        tier: { type: "context", size: 272_000 },
        input: 2,
        output: 9,
        cache_read: 0.2,
      }],
    },
  });
});

test("maps Vercel language models tagged video-generation to video output", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "example/video-language",
      name: "Video Language",
      created: 1_780_963_200,
      context_window: 1_000_000,
      max_tokens: 57_920,
      type: "language",
      tags: ["vision", "video-generation"],
      pricing: { input: "0.0000015", output: "0.000009" },
    }],
  });

  expect(buildVercelModel(model!, undefined).modalities?.output).toEqual(["video"]);
});

test("uses verified Vercel output limits over catalog metadata", () => {
  const limits = {
    "alibaba/qwen3.6-27b": 65_536,
    "amazon/nova-2-lite": 65_535,
    "bytedance/seed-1.8": 32_768,
    "deepseek/deepseek-v3.1-terminus": 32_768,
    "inception/mercury-2": 50_000,
    "minimax/minimax-m2": 196_608,
    "quiverai/arrow-2": 65_536,
    "quiverai/arrow-2-telos": 65_536,
    "zai/glm-5-turbo": 131_072,
  };

  for (const [id, output] of Object.entries(limits)) {
    const [model] = vercel.parseModels({
      data: [{
        id,
        name: id,
        created: 1_780_963_200,
        context_window: 1_000_000,
        max_tokens: 1_000_000,
        type: "language",
      }],
    });

    const inherited = [
      "alibaba/qwen3.6-27b",
      "zai/glm-5-turbo",
    ].includes(id);
    expect(buildVercelModel(model!, undefined).limit?.output).toBe(inherited ? undefined : output);
  }
});

test("Vercel factored models inherit temperature from base metadata", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "moonshotai/kimi-k3",
      name: "Kimi K3",
      created: 1_784_160_000,
      context_window: 1_000_000,
      max_tokens: 131_072,
      type: "language",
      tags: ["reasoning", "tool-use", "vision"],
      pricing: {
        input: "0.000003",
        output: "0.000015",
        input_cache_read: "0.0000003",
      },
    }],
  });

  const synced = buildVercelModel(model!, {
    base_model: "moonshotai/kimi-k3",
    name: "Kimi K3",
    description: "Kimi multimodal agent model for visual understanding, coding, and planning",
    open_weights: false,
    reasoning_options: [],
    cost: { input: 3, output: 15, cache_read: 0.3 },
    limit: { context: 1_000_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(synced).toMatchObject({ base_model: "moonshotai/kimi-k3" });
  expect(synced).not.toHaveProperty("temperature");
});

test("Vercel free routes factor onto the canonical non-free model", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "zai/glm-4.6v-flash-free",
      name: "GLM-4.6V-Flash (Free)",
      created: 1_765_152_000,
      released: 1_765_152_000,
      context_window: 128_000,
      max_tokens: 24_000,
      type: "language",
      tags: ["reasoning", "tool-use", "vision", "file-input"],
      pricing: { input: "0", output: "0" },
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      return id === "zai/glm-4.6v-flash"
        ? { reasoning_options: [{ type: "toggle" }] }
        : undefined;
    },
    authored() {
      return undefined;
    },
  });

  expect(translated?.model).toMatchObject({
    base_model: "zhipuai/glm-4.6v-flash",
    name: "GLM-4.6V-Flash (Free)",
    reasoning_options: [{ type: "toggle" }],
    cost: { input: 0, output: 0 },
    limit: { output: 24_000 },
    modalities: { input: ["text", "image", "pdf"] },
  });
  expect(translated?.model).not.toHaveProperty("description");
  expect(translated?.model).not.toHaveProperty("family");
});

test("Vercel Claude Opus fast variants factor onto base opus metadata", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "anthropic/claude-opus-5-fast",
      name: "Claude Opus 5 (Fast)",
      created: 1_784_937_600,
      context_window: 1_000_000,
      max_tokens: 128_000,
      type: "language",
      tags: ["tool-use", "reasoning", "vision", "file-input", "fast"],
      pricing: {
        input: "0.00001",
        output: "0.00005",
        input_cache_read: "0.000001",
        input_cache_write: "0.0000125",
      },
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      return id === "anthropic/claude-opus-5"
        ? { reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] }
        : undefined;
    },
    authored() {
      return undefined;
    },
  });
  const synced = translated?.model;

  expect(synced).toMatchObject({
    base_model: "anthropic/claude-opus-5",
    name: "Claude Opus 5 (Fast)",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  });
  expect(synced).not.toHaveProperty("description");
  expect(synced).not.toHaveProperty("family");
});

test("Vercel sync accepts evaluation and unknown future model types", () => {
  const [evaluation, future] = vercel.parseModels({
    data: [
      {
        id: "typesafe-ai/jev",
        name: "Jev",
        description: "Decision model for typed classification and scoring",
        created: 1_755_815_280,
        released: 1_789_430_400,
        context_window: 0,
        max_tokens: 0,
        type: "evaluation",
        pricing: { input: "0.000000042", output: "0" },
      },
      {
        id: "example/future-model",
        name: "Future Model",
        created: 1_755_815_280,
        context_window: 8_000,
        max_tokens: 4_000,
        type: "something-new",
      },
    ],
  });

  expect(evaluation).toBeDefined();
  expect(future).toBeDefined();
  expect(buildVercelModel(evaluation!, undefined)).toMatchObject({
    type: "decision",
    description: "Decision model for typed classification and scoring",
    cost: { input: 0.042, output: 0 },
    limit: { context: 0, output: 0 },
    modalities: { input: ["text"], output: ["text"] },
  });
  expect(buildVercelModel(future!, undefined)).toMatchObject({
    limit: { context: 8_000, output: 4_000 },
    modalities: { input: ["text"], output: ["text"] },
  });
  expect(buildVercelModel(future!, undefined).type).toBeUndefined();
});

test("Vercel sync skips batch routes", () => {
  const route = (id: string) => ({
    id,
    name: id,
    created: 1_755_815_280,
    context_window: 200_000,
    max_tokens: 64_000,
    type: "language",
  });
  const models = vercel.parseModels({
    data: [route("anthropic/claude-sonnet-4.5"), route("anthropic/claude-sonnet-4.5-batch")],
  });

  expect(models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-4.5"]);
});

test("Vercel sync preserves Liquid d1 as a decision model via its lab metadata", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "liquid/d1",
      name: "Liquid d1",
      description: "Liquid d1 is a decision model for classification, routing, and scoring",
      created: 1_755_815_280,
      released: 1_790_640_000,
      context_window: 65_536,
      max_tokens: 0,
      type: "evaluation",
      pricing: { input: "0.00000004", output: "0" },
    }],
  });
  const translated = vercel.translateModel(model!, {
    existing: (id) => id === "liquid/d1" ? { base_model: "liquid/d1", cost: { input: 0.04, output: 0 } } : undefined,
    authored: () => undefined,
  });

  expect(translated?.model).toMatchObject({
    base_model: "liquid/d1",
    cost: { input: 0.04, output: 0 },
  });
  expect(translated?.model).not.toHaveProperty("type"); // inherited from lab metadata
  expect(translated?.model).not.toHaveProperty("description"); // don't reintroduce a generic chat description
});

test("Vercel family inference requires word boundaries", () => {
  const [jev, rerank, o3] = vercel.parseModels({
    data: [
      {
        id: "typesafe-ai/jev",
        name: "Jev",
        created: 1_755_815_280,
        context_window: 0,
        max_tokens: 0,
        type: "evaluation",
      },
      {
        id: "cohere/rerank-v3.5",
        name: "Cohere Rerank 3.5",
        created: 1_733_000_000,
        context_window: 4_096,
        max_tokens: 4_096,
        type: "reranking",
      },
      {
        id: "example/o3",
        name: "o3",
        created: 1_745_000_000,
        context_window: 200_000,
        max_tokens: 100_000,
        type: "language",
      },
    ],
  });

  // No fuzzy subsequence matches ("yi") or single-letter substring matches ("o").
  expect(buildVercelModel(jev!, undefined).family).toBeUndefined();
  expect(buildVercelModel(rerank!, undefined).family).toBeUndefined();
  // Genuine o-series IDs still match, and keep their stamp when re-synced.
  expect(buildVercelModel(o3!, undefined).family).toBe("o");
  expect(buildVercelModel(o3!, { family: "o" }).family).toBe("o");
  // Existing bogus "o" stamps self-heal on the next sync.
  expect(buildVercelModel(rerank!, { family: "o" }).family).toBeUndefined();
});

test("Vercel empty existing reasoning_options falls back to the route base menu", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "minimax/minimax-m2.7-free",
      name: "MiniMax M2.7 (Free)",
      created: 1_784_160_000,
      context_window: 200_000,
      max_tokens: 128_000,
      type: "language",
      tags: ["reasoning", "tool-use"],
      pricing: { input: "0", output: "0" },
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      if (id === "minimax/minimax-m2.7-free") return { reasoning_options: [] };
      if (id === "minimax/minimax-m2.7") {
        return { reasoning_options: [{ type: "effort", values: ["low", "high"] }] };
      }
      return undefined;
    },
    authored() {
      return undefined;
    },
  });

  expect(translated?.model).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  });
});

test("Vercel preserves a non-empty existing reasoning_options over the base menu", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "minimax/minimax-m2.7-free",
      name: "MiniMax M2.7 (Free)",
      created: 1_784_160_000,
      context_window: 200_000,
      max_tokens: 128_000,
      type: "language",
      tags: ["reasoning", "tool-use"],
      pricing: { input: "0", output: "0" },
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      if (id === "minimax/minimax-m2.7-free") {
        return { reasoning_options: [{ type: "toggle" }] };
      }
      if (id === "minimax/minimax-m2.7") {
        return { reasoning_options: [{ type: "effort", values: ["low", "high"] }] };
      }
      return undefined;
    },
    authored() {
      return undefined;
    },
  });

  expect(translated?.model).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
  });
});

test("Vercel tool_choice sets every documented tool choice for tool-calling models", () => {
  const toolsSet = (tags: string[], supported_parameters: string[], existing?: ExistingModel) => {
    const [model] = vercel.parseModels({
      data: [{ id: "lab/model", name: "Model", created: 1_780_963_200, type: "language", tags, supported_parameters }],
    });
    const translated = vercel.translateModel(model!, { existing: () => existing, authored: () => undefined }) as {
      v2Set: Record<string, (current: unknown) => unknown>;
    };
    return translated.v2Set["capabilities.tools"]!;
  };
  const choice = ["auto", "none", "required", "tool"];

  expect(toolsSet(["tool-use"], ["tools", "tool_choice"])(undefined)).toEqual({ supported: true, choice });
  expect(toolsSet(["tool-use"], ["tools", "tool_choice"])({ supported: true, updates: true })).toEqual({ supported: true, updates: true, choice });
  expect(toolsSet(["tool-use"], ["tools"])({ supported: true, choice })).toEqual({ supported: true });
  // The file's tool_call wins over the catalog tag, as in the v1 fields.
  expect(toolsSet(["tool-use"], ["tools", "tool_choice"], { tool_call: false })({ supported: false })).toEqual({ supported: false });
  expect(toolsSet([], [])(undefined)).toBeUndefined();
  // A stale `supported = false` in the file doesn't survive tool support.
  expect(toolsSet(["tool-use"], ["tools", "tool_choice"])({ supported: false })).toEqual({ supported: true, choice });
  // A lab that limits choice (Claude Opus 5.5: auto, none) is inherited, not restated.
  const opus = { base_model: "anthropic/claude-opus-5-5" };
  expect(toolsSet(["tool-use"], ["tools", "tool_choice"], opus)(undefined)).toBeUndefined();
  expect(toolsSet(["tool-use"], ["tools", "tool_choice"], opus)({ supported: true, choice })).toEqual({ supported: true });
});

test("Vercel sync takes catalog reasoning controls over stale authored controls", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "alibaba/qwen3.8-max-prime",
      name: "Qwen 3.8 Max Prime",
      created: 1_790_115_600,
      context_window: 1_000_000,
      max_tokens: 131_072,
      type: "language",
      tags: ["reasoning", "tool-use", "vision"],
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["none", "low", "medium", "high"] },
      ],
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      return id === "alibaba/qwen3.8-max-prime"
        ? { base_model: "alibaba/qwen3.8-max-prime", reasoning_options: [] }
        : undefined;
    },
    authored() {
      return undefined;
    },
  });

  expect(translated?.model).toMatchObject({
    base_model: "alibaba/qwen3.8-max-prime",
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
  });
});

test("Vercel catalog budgets and toggles are synced when effort does not include none", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "alibaba/qwen3.8-max-0902",
      name: "Qwen 3.8 Max 0902",
      created: 1_780_963_200,
      type: "language",
      tags: ["reasoning"],
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "xhigh"] },
        { type: "budget_tokens", min: 0, max: 262_144 },
      ],
    }],
  });

  const translated = vercel.translateModel(model!, {
    existing(id) {
      return id === "alibaba/qwen3.8-max-0902" ? { reasoning_options: [] } : undefined;
    },
    authored() {
      return undefined;
    },
  });
  expect(translated?.model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "xhigh"] },
    { type: "budget_tokens", min: 0, max: 262_144 },
  ]);
  expect(translated?.header).toContain("# Toggle: reasoning.enabled = true|false");
});

test("Vercel missing, empty, and unknown catalog controls have distinct meanings", () => {
  const base = {
    id: "example/reasoner",
    name: "Reasoner",
    created: 1_780_963_200,
    type: "language",
    tags: ["reasoning"],
  };
  const authored = { reasoning_options: [{ type: "effort" as const, values: ["low" as const] }] };
  const [missing, empty, unknown] = vercel.parseModels({
    data: [
      base,
      { ...base, reasoning_options: [] },
      { ...base, reasoning_options: [{ type: "effort", values: ["new-level"] }] },
    ],
  });

  expect(buildVercelModel(missing!, authored).reasoning_options).toEqual(authored.reasoning_options);
  expect(buildVercelModel(empty!, authored).reasoning_options).toEqual([]);
  expect(buildVercelModel(unknown!, authored).reasoning_options).toEqual(authored.reasoning_options);
});

test("Vercel ignores catalog controls when the resolved model cannot reason", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "example/non-reasoner",
      name: "Non-Reasoner",
      created: 1_780_963_200,
      type: "language",
      tags: [],
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    }],
  });

  expect(buildVercelModel(model!, undefined).reasoning_options).toBeUndefined();
});

function vercelMedia(fields: Record<string, unknown>) {
  return vercel.parseModels({
    data: [{ name: "Media", created: 1_780_963_200, context_window: 0, max_tokens: 0, ...fields }],
  })[0]!;
}

test("Vercel sync maps every catalog type and lists the standard endpoint where there is one", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  const base_url = "https://ai-gateway.vercel.sh/v1";
  const standard: Record<string, unknown> = {
    image: { base_url, sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/images" } },
    embedding: { base_url, sdk: { aisdk: "@ai-sdk/openai", opencodeai: "none" } },
    reranking: { base_url, sdk: { aisdk: "@ai-sdk/cohere", opencodeai: "none" } },
  };
  const vercelOnly = { base_url: "https://ai-gateway.vercel.sh/v4/ai", sdk: { opencodeai: "none" } };
  const cases: Array<[string, string, string]> = [
    ["image", "image", "images"],
    ["video", "video", "videos"],
    ["embedding", "embedding", "embeddings"],
    ["reranking", "reranking", "rerank"],
    ["speech", "speech", "speech"],
    ["transcription", "transcription", "transcriptions"],
    ["realtime", "realtime", "realtime"],
  ];
  for (const [catalogType, type, protocol] of cases) {
    const translated = vercel.translateModel(vercelMedia({ id: `example/${catalogType}-model`, type: catalogType }), context) as any;
    expect(translated.v2.type).toBe(type);
    expect(translated.v2.api).toEqual({ [protocol]: standard[catalogType] ?? vercelOnly });
    expect(translated.model).toBeUndefined();
    // The written file reads back as a typed v1 model.
    expect(modelV2ToV1({ ...translated.v2, id: "x" }).type).toBe(type);
  }
  // GPT-Live uses the Live endpoint; language and evaluation stay on the chat path.
  const live = vercel.translateModel(vercelMedia({ id: "openai/gpt-live-1", type: "realtime" }), context) as any;
  expect(live.v2.api).toEqual({
    live: { base_url: "https://ai-gateway.vercel.sh/v4/ai", sdk: { aisdk: "none", opencodeai: "none" } },
  });
  const evaluation = vercel.translateModel(vercelMedia({ id: "example/decision-model", type: "evaluation" }), context) as any;
  expect(evaluation.v2Set).toEqual({
    api: {
      decisions: { base_url, sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/decisions" } },
    },
  });
  // v1 reads the first API.
  expect(evaluation.model.provider).toEqual({ npm: "@ai-sdk/openai", api: "https://ai-gateway.vercel.sh/v1" });
  expect(vercel.translateModel(vercelMedia({ id: "example/chat-model", type: "language" }), context)).toHaveProperty("v2Set.api", chatApis);
  // A language route for a model we type as image keeps only its default API.
  const imageContext = { ...context, existing: () => ({ type: "image" }) as any };
  expect(vercel.translateModel(vercelMedia({ id: "example/image-chat", type: "language" }), imageContext)).not.toHaveProperty("v2Set");
  for (const catalogType of ["language", "evaluation", "something-new"]) {
    const translated = vercel.translateModel(vercelMedia({ id: "example/chat-model", type: catalogType }), context) as any;
    expect(translated.v2).toBeUndefined();
    expect(translated.model).toBeDefined();
  }
});

test("Vercel text models keep their default API first and add Responses and Messages", () => {
  const extra = {
    responses: {
      base_url: "https://ai-gateway.vercel.sh/v1",
      sdk: { aisdk: "@ai-sdk/open-responses", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/responses" },
    },
    messages: {
      base_url: "https://ai-gateway.vercel.sh/v1",
      sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/messages" },
    },
  };
  const fresh = chatApis(undefined);
  expect(fresh).toEqual({ "chat-completions": {}, ...extra });
  expect(Object.keys(fresh)).toEqual(["chat-completions", "responses", "messages"]);
  const own = { "chat-completions": { legacy_interleaved: true } };
  expect(chatApis(own)).toEqual({ ...own, ...extra });
  // A second run changes nothing.
  expect(chatApis(chatApis(own))).toEqual(chatApis(own));
  // Per-API capabilities on the extra tables survive a sync.
  const flagged = { ...chatApis(own), responses: { ...extra.responses, capabilities: { effort_updates: true } } };
  expect(chatApis(flagged)).toEqual(flagged);
});

test("Vercel media files already in v1 publish the standard endpoint there too", () => {
  const image = vercelMedia({ id: "bfl/flux-2-pro", name: "FLUX.2 [pro]", type: "image" });
  const doc = buildVercelMediaModel(image, "image", { schema: 2, base_model: "bfl/flux-2-pro" });
  expect(doc.v2_only).toBeUndefined();
  expect(doc.api).toEqual({
    images: {
      base_url: "https://ai-gateway.vercel.sh/v1",
      sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/images" },
    },
  });
  expect(modelV2ToV1({ ...doc, id: "bfl/flux-2-pro" }, undefined, "@ai-sdk/gateway").provider)
    .toEqual({ npm: "@ai-sdk/openai", api: "https://ai-gateway.vercel.sh/v1" });
});

test("Vercel media models drop chat capabilities and take exact MIME types", () => {
  const video = buildVercelMediaModel(vercelMedia({
    id: "example/video-model",
    type: "video",
    modalities: { input: ["text"], output: ["video"] },
    video_capabilities: {
      input_limits: {
        text: { max_chars: 1500 },
        image: { supported_formats: ["jpeg", "jpg", "png"] },
        video: { supported_formats: ["mp4", "mov"] },
      },
    },
  }), "video", {
    schema: 2,
    name: "Video Model",
    description: "Curated description",
    open_weights: false,
    release_date: "2026-01-01",
    modalities: { input: ["text"], output: ["video/mp4"] },
    capabilities: { tools: { supported: false }, reasoning: { supported: false }, temperature: true, structured_output: true },
    limit: { context: 0, output: 0 },
  });
  expect(video).toMatchObject({
    type: "video",
    name: "Video Model",
    description: "Curated description",
    modalities: { input: ["text", "image/jpeg", "image/png", "video/mp4", "video/quicktime"], output: ["video/mp4"] },
    capabilities: { tools: { supported: false }, reasoning: { supported: false }, temperature: false, top_p: false, top_k: false },
  });
  expect(video.capabilities).not.toHaveProperty("structured_output");

  // Realtime sessions take tools; the catalog states temperature.
  const realtime = buildVercelMediaModel(vercelMedia({ id: "example/voice", type: "realtime", temperature: true }), "realtime");
  expect(realtime.capabilities).toEqual({ tools: { supported: true }, reasoning: { supported: false }, temperature: true });
  expect(realtime.modalities).toEqual({ input: ["text", "audio/pcm"], output: ["text", "audio/pcm"] });
});

test("Vercel media models on a lab of the same type keep only host differences", () => {
  // A v1 file: generic modality override, stale chat capabilities.
  const synced = buildVercelMediaModel(
    vercelMedia({
      id: "openai/gpt-realtime-1.5",
      type: "realtime",
      temperature: true,
      pricing: { input: "0.000004", output: "0.000016", input_cache_read: "0.0000004", audio_input_token_cost: "0.000032", audio_output_token_cost: "0.000064", web_search: "10" },
    }),
    "realtime",
    undefined,
    {
      base_model: "openai/gpt-realtime-1.5",
      attachment: false,
      tool_call: false,
      temperature: true,
      cost: { input: 4, output: 16 },
      modalities: { input: ["text", "audio"] },
    },
  );
  expect(synced.base_model).toBe("openai/gpt-realtime-1.5");
  expect(synced).not.toHaveProperty("type");
  // Generic "audio" becomes the lab's exact types; the lab's image input stays out.
  expect(synced.modalities.input).toEqual(["text", "audio/pcm", "audio/pcmu", "audio/pcma"]);
  // tools = true matches the lab, so only temperature differs.
  expect(synced.capabilities).toEqual({ temperature: true });
  expect(synced.cost).toEqual({
    text: { input: { price: 4, cache: { read: 0.4 } }, output: { price: 16 } },
    audio: { input: { price: 32 }, output: { price: 64 } },
  });
  const v1 = modelV2ToV1({ ...synced, id: "x" });
  expect(v1).not.toHaveProperty("tool_call");
  expect(v1.cost).toEqual({ input: 4, output: 16, cache_read: 0.4, input_audio: 32, output_audio: 64 });
});

test("Vercel media base_model files inherit lab descriptions and limits, keeping only Vercel deltas", () => {
  // Stale chat-path values: a generic description and token limits on an embedding model.
  const current = {
    schema: 2,
    base_model: "openai/text-embedding-3-large",
    name: "text-embedding-3-large",
    description: "Embedding model for semantic search, retrieval, clustering, and ranking pipelines",
    limit: { input: 6_656, output: 1_536 },
  };
  const embedding = buildVercelMediaModel(
    vercelMedia({ id: "openai/text-embedding-3-large", name: "text-embedding-3-large", type: "embedding", max_tokens: 8_192 }),
    "embedding",
    current,
  );
  for (const key of ["name", "description", "limit"]) expect(embedding).not.toHaveProperty(key);

  // The file's display name differs from the lab's ("Rerank 3.5"), and the catalog's
  // context differs too; the catalog's max_tokens is not a rerank output limit.
  const rerankModel = vercelMedia({ id: "cohere/rerank-v3.5", name: "Cohere Rerank 3.5", type: "reranking", context_window: 4_000, max_tokens: 4_000 });
  const rerank = buildVercelMediaModel(
    rerankModel,
    "reranking",
    { schema: 2, base_model: "cohere/rerank-v3.5", name: "Cohere Rerank 3.5", description: "Reranking model", limit: { output: 4_096 } },
  );
  expect(rerank.name).toBe("Cohere Rerank 3.5");
  // A file that inherits the lab's name keeps it when Vercel renames the model;
  // a new file takes Vercel's display name.
  const inheritsName = buildVercelMediaModel(rerankModel, "reranking", { schema: 2, base_model: "cohere/rerank-v3.5" });
  expect(inheritsName).not.toHaveProperty("name");
  expect(buildVercelMediaModel(rerankModel, "reranking").name).toBe("Cohere Rerank 3.5");
  expect(rerank).not.toHaveProperty("description");
  expect(rerank.limit).toEqual({ context: 4_000 });

  // No catalog limits: the lab's apply, not the file's zeros.
  const live = buildVercelMediaModel(
    vercelMedia({ id: "google/gemini-3.8-live", name: "Gemini 3.8 Live", type: "realtime" }),
    "realtime",
    { schema: 2, base_model: "google/gemini-3.8-live", limit: { context: 0, output: 0 } },
  );
  expect(live).not.toHaveProperty("limit");

  // Standalone embedding files take the catalog's context and no output tokens.
  const standalone = buildVercelMediaModel(
    vercelMedia({ id: "example/embed", type: "embedding", context_window: 32_768, max_tokens: 32_768 }),
    "embedding",
    { schema: 2, name: "Embed", description: "Embedding model", open_weights: false, release_date: "2026-01-01", limit: { context: 32_768, output: 32_768 } },
  );
  expect(standalone.limit).toEqual({ context: 32_768, output: 0 });
  // No catalog context: the authored (documented) context is kept, not a stale default.
  const documented = buildVercelMediaModel(
    vercelMedia({ id: "voyage/voyage-law-2", type: "embedding", context_window: 0, max_tokens: 0 }),
    "embedding",
    { schema: 2, name: "Voyage Law 2", description: "Embedding model", open_weights: false, release_date: "2024-04-15", limit: { context: 16_000, output: 0 } },
  );
  expect(documented.limit).toEqual({ context: 16_000, output: 0 });
});

test("Vercel media prices map to CostV2 units with conditional overrides", () => {
  const cost = (type: Parameters<typeof vercelMediaCost>[1], pricing: Record<string, unknown>) =>
    vercelMediaCost(vercelMedia({ id: "example/model", type, pricing }), type);

  // Embeddings: per token, cache reads, audio tokens, regional prices only where they differ.
  expect(cost("embedding", {
    input: "0.00000015",
    input_cache_read: "0.000000015",
    audio_input_token_cost: "0.0000065",
    regional: { us: { input: "0.00000015" }, eu: { input: "0.000000165" } },
  })).toEqual({
    cost: {
      text: { input: { price: 0.15, cache: { read: 0.015 }, overrides: [{ when: { region: { equals: "eu" } }, price: 0.165 }] } },
      audio: { input: { price: 6.5 } },
    },
  });
  expect(cost("reranking", { input: "0.00000005" })).toEqual({ cost: { text: { input: { price: 0.05 } } } });
  expect(cost("reranking", {})).toEqual({});

  // Speech: per character, or text in and audio out per token.
  expect(cost("speech", { input: "0.000015", speech_input_character_cost: "0.000015" }))
    .toEqual({ cost: { text: { input: { unit: "character", price: 15 } } } });
  expect(cost("speech", { input: "0.0000005", output: "0.000006", audio_output_token_cost: "0.000006" })).toEqual({
    cost: { text: { input: { price: 0.5 }, output: { price: 6 } }, audio: { output: { price: 6 } } },
  });

  // Transcription: per second; `input` next to it is a nominal placeholder.
  expect(cost("transcription", { input: "0.0000000002", transcription_duration_cost_per_second: "0.000284" }))
    .toEqual({ cost: { audio: { input: { unit: "second", price: 0.000284 } } } });
  expect(cost("transcription", { input: "0.000002", transcription_duration_cost_per_second: "0.0001" }).issue)
    .toBe("input next to transcription_duration_cost_per_second");

  // Images: per image with size, quality and combined overrides; the grounding fee isn't a model price.
  expect(cost("image", {
    image: "0.06",
    image_dimension_quality_pricing: [
      { quality: "low", cost: "0.04" },
      { size: "2048x2048", cost: "0.08" },
      { size: "2048x2048", quality: "low", cost: "0.06" },
      { size: "1024x1024", cost: "0.06" },
    ],
  })).toEqual({
    cost: {
      image: {
        output: {
          unit: "image",
          price: 0.06,
          overrides: [
            { when: { quality: { equals: "low" } }, price: 0.04 },
            { when: { resolution: { equals: "2048x2048" } }, price: 0.08 },
            { when: { resolution: { equals: "2048x2048" }, quality: { equals: "low" } }, price: 0.06 },
          ],
        },
      },
    },
  });
  // Image output tokens: `text.output` keeps the v1 pair.
  expect(cost("image", {
    input: "0.000005",
    output: "0.000038",
    image_dimension_quality_pricing: [{ operation: "web-grounding", cost: "0.014" }],
  })).toEqual({
    cost: { text: { input: { price: 5 }, output: { price: 38 } }, image: { output: { price: 38 } } },
  });
  expect(cost("image", { image: "0.04", image_dimension_quality_pricing: [{ operation: "upscale", cost: "0.1" }] }).cost)
    .toBeUndefined();

  // Video: per second by resolution, audio and mode; the most specific override applies last.
  expect(cost("video", {
    video_duration_pricing: [
      { audio: false, mode: "std", cost_per_second: "0.168" },
      { audio: true, mode: "std", cost_per_second: "0.252" },
      { audio: true, mode: "std", voice_control: true, cost_per_second: "0.308" },
      { audio: false, mode: "pro", cost_per_second: "0.168" },
    ],
  })).toEqual({
    cost: {
      video: {
        output: {
          unit: "second",
          price: 0.168,
          overrides: [
            { when: { mode: { equals: "std" }, generate_audio: { equals: true } }, price: 0.252 },
            { when: { mode: { equals: "std" }, generate_audio: { equals: true }, voice_control: { equals: true } }, price: 0.308 },
          ],
        },
      },
    },
  });
  // A condition-free entry is the default price.
  expect(cost("video", {
    video_duration_pricing: [{ resolution: "480p", cost_per_second: "0.05" }, { cost_per_second: "0.2" }],
  }).cost?.video.output).toEqual({ unit: "second", price: 0.2, overrides: [{ when: { resolution: { equals: "480p" } }, price: 0.05 }] });
  // Video tokens per 1M, reduced when the input contains video.
  expect(cost("video", {
    video_token_pricing: {
      tiers: [
        { resolution: "480p", no_video_input: { cost_per_million_tokens: "7" }, with_video_input: { cost_per_million_tokens: "4.3" } },
        { resolution: "1080p", no_video_input: { cost_per_million_tokens: "7.7" }, with_video_input: { cost_per_million_tokens: "4.7" } },
      ],
      notes: "Token count includes both input and output video.",
    },
  }).cost?.video.output).toEqual({
    price: 7,
    overrides: [
      { when: { resolution: { equals: "1080p" } }, price: 7.7 },
      { when: { resolution: { equals: "480p" }, input_video: { equals: true } }, price: 4.3 },
      { when: { resolution: { equals: "1080p" }, input_video: { equals: true } }, price: 4.7 },
    ],
  });

  // Realtime sessions billed by duration: audio input per second. The per-message fee
  // has no CostV2 unit and is left out (the file's leading comment says so); web
  // search stays a tool fee.
  expect(cost("realtime", { realtime_client_message_cost: "0.004", realtime_session_duration_cost_per_second: "0.000834" }))
    .toEqual({ cost: { audio: { input: { unit: "second", price: 0.000834 } } } });
  expect(cost("realtime", { web_search: "10", realtime_session_duration_cost_per_second: "0.0008334" }))
    .toEqual({ cost: { audio: { input: { unit: "second", price: 0.0008334 } } } });
  expect(cost("realtime", { audio_input_token_cost: "0.000032", realtime_session_duration_cost_per_second: "0.0008" }).issue)
    .toBe("both audio_input_token_cost and realtime_session_duration_cost_per_second");
  const voice = (pricing: Record<string, unknown>) => realtimePriceNote(vercelMedia({ id: "example/voice", type: "realtime", pricing }));
  expect(voice({ realtime_client_message_cost: "0.004", realtime_session_duration_cost_per_second: "0.000834" }))
    .toBe("# Price: session duration billed as audio input per second; $0.004 per client message not represented\n");
  expect(voice({ realtime_session_duration_cost_per_second: "0.0008334" }))
    .toBe("# Price: session duration billed as audio input per second\n");
  expect(voice({ input: "0.000004" })).toBe("");
});

test("OpenRouter Claude Opus fast variants factor onto base opus metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    id: "anthropic/claude-opus-5-fast",
    name: "Anthropic: Claude Opus 5 (Fast)",
    context_length: 1_000_000,
    top_provider: {
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
    },
    pricing: {
      prompt: "0.00001",
      completion: "0.00005",
      input_cache_read: "0.000001",
      input_cache_write: "0.0000125",
    },
    reasoning: {
      mandatory: false,
      supported_efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  }), undefined);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-opus-5",
    name: "Claude Opus 5 (Fast)",
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  });
});

test("skips LLM Gateway base_model factoring when no metadata entry exists", () => {
  const model = buildLLMGatewayModel(
    llmGatewayModel({ id: "claude-fable-does-not-exist" }),
    undefined,
  );

  expect("base_model" in model).toBe(false);
  expect(model).toMatchObject({ name: "Claude Fable 5" });
});

test("preserves the authored header comment block when rewriting a changed model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-header-"));
  const modelsDir = path.join(dir, "providers", "example", "models");
  await mkdir(path.join(dir, "models"));
  await Bun.write(path.join(modelsDir, "example-model.toml"), [
    "# Documented quirk: this route needs a manual note.",
    "# https://example.com/docs (accessed 2026-06-25)",
    "schema = 2",
    'name = "Example Model"',
    'release_date = "2026-01-01"',
    "open_weights = false",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = false }",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[cost.text.input]",
    "price = 1",
    "",
    "[cost.text.output]",
    "price = 2",
    "",
  ].join("\n"));

  const provider: SyncProvider<{ id: string }> = {
    id: "example",
    name: "Example",
    modelsDir,
    deleteMissing: false,
    async fetchModels() {
      return [{ id: "example-model" }];
    },
    parseModels(raw) {
      return raw as { id: string }[];
    },
    translateModel(model) {
      return {
        id: model.id,
        model: {
          name: "Example Model",
          description: "Example model used to verify sync formatting behavior",
          release_date: "2026-01-01",
          last_updated: "2026-01-01",
          attachment: false,
          reasoning: false,
          tool_call: true,
          open_weights: false,
          cost: { input: 3, output: 9 },
          limit: { context: 1_000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
        },
      };
    },
  };

  try {
    const result = await syncProvider(provider);
    expect(result.updated).toBe(1);
    const written = await readFile(path.join(modelsDir, "example-model.toml"), "utf8");
    expect(written).toStartWith(
      "# Documented quirk: this route needs a manual note.\n# https://example.com/docs (accessed 2026-06-25)\n",
    );
    expect(written).toContain("[cost.text.input]\nprice = 3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retains authored data when OpenRouter reports an unavailable stub", () => {
  const authored = {
    name: "Claude Fable Latest",
    reasoning: true as const,
    reasoning_options: [{ type: "effort" as const, values: ["low", "high"] as const }],
    tool_call: true as const,
    structured_output: true as const,
  };
  const translated = openrouter.translateModel(unavailableStub(), {
    existing: () => undefined,
    authored: () => authored as never,
  });

  expect(translated).toEqual({ id: "~anthropic/claude-fable-latest", model: authored as never });
});

test("skips an unavailable OpenRouter stub with no authored file", () => {
  const translated = openrouter.translateModel(unavailableStub(), {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated).toBeUndefined();
});

test("maps OpenRouter output modalities to media model types", () => {
  const output = (value: string[]) =>
    mediaType(openRouterMediaModel({ architecture: { input_modalities: ["text"], output_modalities: value } }));

  expect(output(["speech"])).toBe("speech");
  expect(output(["transcription"])).toBe("transcription");
  expect(output(["embeddings"])).toBe("embedding");
  expect(output(["rerank"])).toBe("reranking");
  expect(output(["text"])).toBeUndefined();
  expect(output(["decisions"])).toBeUndefined();
  expect(output(["text", "audio"])).toBeUndefined();
});

test("prices OpenRouter media models in each type's cost unit", () => {
  const cost = (type: Parameters<typeof mediaCost>[1], pricing: OpenRouterModel["pricing"], id = "lab/model") =>
    mediaCost(openRouterMediaModel({ id, pricing }), type);

  // Speech: per input character, per output second, or per token.
  expect(cost("speech", { prompt: "0.00008", completion: "0" })).toEqual({
    text: { input: { unit: "character", price: 80 } },
  });
  expect(cost("speech", { prompt: "0", completion: "0.0025" })).toEqual({
    audio: { output: { unit: "second", price: 0.0025 } },
  });
  expect(cost("speech", { prompt: "0.0000005", completion: "0.000009" })).toEqual({
    text: { input: { price: 0.5 } },
    audio: { output: { price: 9 } },
  });
  // Transcription: per input second as reported, per token, or per hour for the
  // models OpenRouter bills in audio hours.
  expect(cost("transcription", { prompt: "0.0001", completion: "0" })).toEqual({
    audio: { input: { unit: "second", price: 0.0001 } },
  });
  expect(cost("transcription", { prompt: "0.36", completion: "0" })).toEqual({
    audio: { input: { unit: "second", price: 0.36 } },
  });
  expect(cost("transcription", { prompt: "0.36", completion: "0" }, "microsoft/mai-transcribe-1.5")).toEqual({
    audio: { input: { unit: "second", price: 0.0001 } },
  });
  expect(cost("transcription", { prompt: "0.0000025", completion: "0.00001" })).toEqual({
    text: { input: { price: 2.5 }, output: { price: 10 } },
    audio: { input: { price: 2.5 } },
  });
  // Embeddings: per token, with image and audio input prices when set.
  expect(cost("embedding", { prompt: "0.0000002", completion: "0", image: "0.00000045", audio: "0" })).toEqual({
    text: { input: { price: 0.2 } },
    image: { input: { price: 0.45 } },
  });
  // Rerank: "0" is no price, except on free routes.
  expect(cost("reranking", { prompt: "0", completion: "0" })).toBeUndefined();
  expect(cost("reranking", { prompt: "0", completion: "0" }, "lab/model:free")).toEqual({
    text: { input: { price: 0 } },
  });
});

test("syncs OpenRouter media models with no supported parameters and skips negative prices", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  const speech = openRouterMediaModel({ id: "examplelab/voice-1" });
  const translated = openrouter.translateModel(speech, context);

  expect(translated).toEqual({
    id: "examplelab/voice-1",
    header: expect.stringContaining("output_modalities=speech"),
    v2: {
      schema: 2,
      v2_only: true,
      type: "speech",
      name: "Voice 1",
      description: "Text-to-speech model",
      open_weights: false,
      release_date: "2026-10-13",
      modalities: { input: ["text"], output: ["audio/mpeg", "audio/pcm"] },
      capabilities: { tools: { supported: false }, reasoning: { supported: false } },
      limit: { context: 0, output: 0 },
      api: { speech: { base_url: "https://openrouter.ai/api/v1", sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-speech" } } },
      cost: { text: { input: { unit: "character", price: 15 } } },
    },
  });

  const unavailable = openRouterMediaModel({ id: "examplelab/voice-1", pricing: { prompt: "-1", completion: "-1" } });
  expect(openrouter.translateModel(unavailable, context)).toBeUndefined();
  const current = { schema: 2, v2_only: true, base_model: "openai/whisper-1" };
  expect(openrouter.translateModel(unavailable, { ...context, v2: () => current })).toEqual({
    id: "examplelab/voice-1",
    v2: current,
  });
  // Chat models keep the stricter check: an empty parameter list is a degraded stub.
  expect(openrouter.translateModel(openRouterModel({ supported_parameters: [] }), context)).toBeUndefined();
});

test("factors OpenRouter media models onto lab files and authors their API protocol", () => {
  const doc = buildOpenRouterMediaModel(openRouterMediaModel({
    id: "openai/whisper-1",
    name: "OpenAI: Whisper 1",
    architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] },
    pricing: { prompt: "0.0001", completion: "0" },
  }), "transcription");

  expect(doc).toEqual({
    schema: 2,
    v2_only: true,
    base_model: "openai/whisper-1",
    api: {
      transcriptions: {
        base_url: "https://openrouter.ai/api/v1",
        sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-transcription" },
      },
    },
    cost: { audio: { input: { unit: "second", price: 0.0001 } } },
  });
});

test("OpenRouter rerank and embedding files name the packages that speak their endpoint", () => {
  const media = (id: string, output: string, type: "reranking" | "embedding") =>
    buildOpenRouterMediaModel(openRouterMediaModel({
      id,
      architecture: { input_modalities: ["text"], output_modalities: [output] },
      pricing: { prompt: "0", completion: "0" },
    }), type).api;

  expect(media("examplelab/rerank-1", "rerank", "reranking")).toEqual({
    rerank: { base_url: "https://openrouter.ai/api/v1", sdk: { aisdk: "@ai-sdk/cohere", opencodeai: "none" } },
  });
  expect(media("examplelab/embed-1", "embeddings", "embedding")).toEqual({
    embeddings: { base_url: "https://openrouter.ai/api/v1", sdk: { aisdk: "@openrouter/ai-sdk-provider", opencodeai: "none" } },
  });
});

test("OpenRouter media files keep a name only when it differs from the lab", () => {
  const rerank = (id: string, name: string) => buildOpenRouterMediaModel(openRouterMediaModel({
    id,
    name,
    architecture: { input_modalities: ["text"], output_modalities: ["rerank"] },
    pricing: { prompt: "0", completion: "0" },
  }), "reranking");

  // Mapped through MEDIA_BASE_MODEL_OVERRIDES, same name as models/cohere/rerank-v4.0-pro.
  expect(rerank("cohere/rerank-4-pro", "Cohere: Rerank 4 Pro")).not.toHaveProperty("name");
  expect(rerank("cohere/rerank-4-pro", "Cohere: Rerank Four Pro")).toMatchObject({ name: "Rerank Four Pro" });
});

test("OpenRouter transcription routes on chat labs take the endpoint's capabilities", () => {
  const doc = buildOpenRouterMediaModel(openRouterMediaModel({
    id: "mistralai/voxtral-mini-3b-2507",
    name: "Mistral: Voxtral Mini 3B 2507",
    architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] },
    pricing: { prompt: "0.0000166667", completion: "0" },
  }), "transcription");

  expect(doc).toMatchObject({
    base_model: "mistral/voxtral-mini-3b-2507",
    type: "transcription",
    modalities: { input: ["audio/wav", "audio/mpeg"], output: ["text"] },
    capabilities: { tools: { supported: false } },
    limit: { context: 0, output: 0 },
    api: {
      transcriptions: {
        base_url: "https://openrouter.ai/api/v1",
        sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-transcription" },
      },
    },
  });
  // Transcription takes temperature, as the chat lab does, so it isn't restated.
  expect(doc.capabilities).not.toHaveProperty("temperature");
});

function openRouterImageModel(
  pricing: NonNullable<OpenRouterModel["image_endpoints"]>[number]["pricing"],
  overrides: Partial<OpenRouterModel> = {},
): OpenRouterModel {
  return openRouterMediaModel({
    id: "examplelab/painter-1",
    name: "Example Lab: Painter 1",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
    pricing: { prompt: "0", completion: "0" },
    image_endpoints: [{ provider_slug: "examplelab", pricing }],
    ...overrides,
  });
}

test("maps OpenRouter image-only models to the image type", () => {
  const output = (value: string[]) =>
    mediaType(openRouterMediaModel({ architecture: { input_modalities: ["text"], output_modalities: value } }));

  expect(output(["image"])).toBe("image");
  // Image and text output is a chat model (Gemini image models), synced from the text list.
  expect(output(["image", "text"])).toBeUndefined();
});

test("prices OpenRouter image models per image with resolution and quality overrides", () => {
  // Plain per-image price.
  expect(mediaCost(openRouterImageModel([{ billable: "output_image", unit: "image", cost_usd: 0.04 }]), "image")).toEqual({
    image: { output: { unit: "image", price: 0.04 } },
  });
  // Resolution tiers: the first line is the base, other tiers are overrides; equal tiers collapse.
  expect(mediaCost(openRouterImageModel([
    { billable: "input_image", unit: "image", cost_usd: 0.003 },
    { billable: "output_image", unit: "image", cost_usd: 0.041, variant: "768" },
    { billable: "output_image", unit: "image", cost_usd: 0.048, variant: "1k" },
    { billable: "output_image", unit: "image", cost_usd: 0.07, variant: "1.5k" },
    { billable: "output_image", unit: "image", cost_usd: 0.041, variant: "2k" },
  ]), "image")).toEqual({
    image: {
      input: { unit: "image", price: 0.003 },
      output: {
        unit: "image",
        price: 0.041,
        overrides: [
          { when: { resolution: { equals: "1K" } }, price: 0.048 },
          { when: { resolution: { equals: "1.5K" } }, price: 0.07 },
        ],
      },
    },
  });
  // Quality and resolution together.
  expect(mediaCost(openRouterImageModel([
    { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "low_1k" },
    { billable: "output_image", unit: "image", cost_usd: 0.08, variant: "medium_2k" },
  ]), "image")).toEqual({
    image: {
      output: {
        unit: "image",
        price: 0.04,
        overrides: [{ when: { quality: { equals: "medium" }, resolution: { equals: "2K" } }, price: 0.08 }],
      },
    },
  });
  // A plain line with a named tier that was matched to a resolution by a live request.
  expect(mediaCost(openRouterImageModel([
    { billable: "output_image", unit: "image", cost_usd: 0.045 },
    { billable: "output_image", unit: "image", cost_usd: 0.09, variant: "high_resolution" },
  ], { id: "bytedance-seed/seedream-5-0-pro" }), "image")).toEqual({
    image: {
      output: { unit: "image", price: 0.045, overrides: [{ when: { resolution: { equals: "2K" } }, price: 0.09 }] },
    },
  });
});

test("prices OpenRouter image models per megapixel and per token", () => {
  expect(mediaCost(openRouterImageModel([
    { billable: "input_image", unit: "megapixel", cost_usd: 0.06 },
    { billable: "output_image", unit: "megapixel", cost_usd: 0.06 },
  ]), "image")).toEqual({
    image: { input: { unit: "megapixel", price: 0.06 }, output: { unit: "megapixel", price: 0.06 } },
  });
  // Token prices are per 1M tokens, with text input listed first.
  expect(mediaCost(openRouterImageModel([
    { billable: "input_image", unit: "token", cost_usd: 0.000008 },
    { billable: "input_text", unit: "token", cost_usd: 0.000005 },
    { billable: "output_image", unit: "token", cost_usd: 0.00003 },
  ]), "image")).toEqual({
    text: { input: { price: 5 } },
    image: { input: { price: 8 }, output: { price: 30 } },
  });
});

test("leaves the cost out of OpenRouter image models with unrepresentable prices", () => {
  const cost = (pricing: Parameters<typeof openRouterImageModel>[0], overrides: Partial<OpenRouterModel> = {}) =>
    mediaCost(openRouterImageModel(pricing, overrides), "image");
  const output = { billable: "output_image", unit: "image", cost_usd: 0.035 };

  // No pricing lines (Krea, Muse Image).
  expect(cost([])).toBeUndefined();
  // Per-request style reference fee (Recraft V4 Styles).
  expect(cost([output, { billable: "input_reference", unit: "request", cost_usd: 0.005 }])).toBeUndefined();
  // Font and super-resolution reference fees (Riverflow 2.0).
  expect(cost([output, { billable: "input_font", unit: "image", cost_usd: 0.03 }])).toBeUndefined();
  // An unknown tier name.
  expect(cost([output, { ...output, cost_usd: 0.09, variant: "ultra" }])).toBeUndefined();
  // Per-job pricing where the listed line is only a floor (Sourceful).
  expect(cost([output], { id: "sourceful/riverflow-v2.5-fast" })).toBeUndefined();
  // Hosts with different prices.
  expect(cost([output], {
    image_endpoints: [
      { provider_slug: "a", pricing: [output] },
      { provider_slug: "b", pricing: [{ ...output, cost_usd: 0.04 }] },
    ],
  })).toBeUndefined();
});

test("factors OpenRouter image models onto lab files with the Images API protocol", () => {
  const doc = buildOpenRouterMediaModel(openRouterImageModel(
    [{ billable: "output_image", unit: "megapixel", cost_usd: 0.03 }],
    { id: "black-forest-labs/flux.2-pro", name: "Black Forest Labs: FLUX.2 Pro" },
  ), "image");

  expect(doc).toEqual({
    schema: 2,
    v2_only: true,
    base_model: "black-forest-labs/flux-2-pro",
    api: {
      images: {
        base_url: "https://openrouter.ai/api/v1",
        sdk: { aisdk: "@openrouter/ai-sdk-provider", opencodeai: "@opencode/ai/providers/openrouter/images" },
      },
    },
    cost: { image: { output: { unit: "megapixel", price: 0.03 } } },
  });

  // With no lab file: a full definition, outputs from the endpoint's output_format values.
  const standalone = buildOpenRouterMediaModel(openRouterImageModel([], {
    image_endpoints: [{
      provider_slug: "examplelab",
      supported_parameters: { output_format: { type: "enum", values: ["svg"] } },
      pricing: [],
    }],
  }), "image");
  expect(standalone).toMatchObject({
    type: "image",
    name: "Painter 1",
    description: "Image generation model",
    modalities: { input: ["text", "image/png", "image/jpeg", "image/webp", "image/gif"], output: ["image/svg+xml"] },
    limit: { context: 0, output: 0 },
    api: { images: { base_url: "https://openrouter.ai/api/v1" } },
  });
  expect(standalone).not.toHaveProperty("cost");
});

function openRouterVideoModel(skus: Record<string, string> | undefined, overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return openRouterMediaModel({
    id: "examplelab/director-1",
    name: "Example Lab: Director 1",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["video"] },
    pricing: { prompt: "0", completion: "0" },
    video_pricing_skus: skus,
    ...overrides,
  });
}

const videoCostOf = (skus: Record<string, string>) => mediaCost(openRouterVideoModel(skus), "video");

test("maps OpenRouter video-only models to the video type", () => {
  const output = (value: string[]) =>
    mediaType(openRouterMediaModel({ architecture: { input_modalities: ["text"], output_modalities: value } }));

  expect(output(["video"])).toBe("video");
  expect(output(["video", "text"])).toBeUndefined();
});

test("prices OpenRouter video models per second with resolution overrides", () => {
  // Cents per second, with per-image input; the first SKU is the base.
  expect(videoCostOf({
    cents_per_image_input: "1",
    cents_per_video_output_second_480p: "2",
    cents_per_video_output_second_720p: "3",
  })).toEqual({
    image: { input: { unit: "image", price: 0.01 } },
    video: {
      output: { unit: "second", price: 0.02, overrides: [{ when: { resolution: { equals: "720p" } }, price: 0.03 }] },
    },
  });
  // Dollars per second; a plain SKU is the base and tiers equal to it are left out.
  expect(videoCostOf({ duration_seconds: "0.08", duration_seconds_480p: "0.05", duration_seconds_768p: "0.08" })).toEqual({
    video: {
      output: { unit: "second", price: 0.08, overrides: [{ when: { resolution: { equals: "480p" } }, price: 0.05 }] },
    },
  });
  // Continuation SKUs add input_video, after the plain resolution tiers.
  expect(videoCostOf({
    cents_per_second_output: "17",
    cents_per_second_output_2k: "28",
    cents_per_second_video_continuation_2k: "31",
  })).toEqual({
    video: {
      output: {
        unit: "second",
        price: 0.17,
        overrides: [
          { when: { resolution: { equals: "2K" } }, price: 0.28 },
          { when: { resolution: { equals: "2K" }, input_video: { equals: true } }, price: 0.31 },
        ],
      },
    },
  });
});

test("prices OpenRouter video models with audio and mode overrides", () => {
  // With and without audio, most specific override last.
  expect(videoCostOf({
    duration_seconds_with_audio: "0.40",
    duration_seconds_with_audio_4k: "0.60",
    duration_seconds_without_audio: "0.20",
    duration_seconds_without_audio_4k: "0.40",
  })).toEqual({
    video: {
      output: {
        unit: "second",
        price: 0.4,
        overrides: [
          { when: { generate_audio: { equals: false } }, price: 0.2 },
          { when: { resolution: { equals: "4K" }, generate_audio: { equals: true } }, price: 0.6 },
          { when: { resolution: { equals: "4K" }, generate_audio: { equals: false } }, price: 0.4 },
        ],
      },
    },
  });
  // A plain SKU with an audio surcharge; mode SKUs at the base price add nothing.
  expect(videoCostOf({
    duration_seconds: "0.112",
    duration_seconds_with_audio: "0.168",
    text_to_video_duration_seconds_720p: "0.112",
    image_to_video_duration_seconds_720p: "0.112",
  })).toEqual({
    video: {
      output: { unit: "second", price: 0.112, overrides: [{ when: { generate_audio: { equals: true } }, price: 0.168 }] },
    },
  });
  // Mode tiers and reference-to-video with per-image reference input.
  expect(videoCostOf({
    duration_seconds_480p: "0.02",
    reference_input_images: "0.04",
    reference_duration_seconds_480p: "0.07",
    image_to_video_duration_seconds_720p: "0.10",
  })).toEqual({
    image: { input: { unit: "image", price: 0.04 } },
    video: {
      output: {
        unit: "second",
        price: 0.02,
        overrides: [
          { when: { resolution: { equals: "480p" }, mode: { equals: "reference-to-video" } }, price: 0.07 },
          { when: { resolution: { equals: "720p" }, mode: { equals: "image-to-video" } }, price: 0.1 },
        ],
      },
    },
  });
});

test("prices OpenRouter video token SKUs per 1M tokens", () => {
  expect(videoCostOf({
    video_tokens: "0.000007",
    video_tokens_4k: "0.000004",
    video_tokens_without_audio: "0.000007",
    video_tokens_with_video_input: "0.0000043",
    video_tokens_4k_with_video_input: "0.0000024",
  })).toEqual({
    video: {
      output: {
        price: 7,
        overrides: [
          { when: { resolution: { equals: "4K" } }, price: 4 },
          { when: { input_video: { equals: true } }, price: 4.3 },
          { when: { resolution: { equals: "4K" }, input_video: { equals: true } }, price: 2.4 },
        ],
      },
    },
  });
  expect(videoCostOf({ video_tokens: "0.0000024", video_tokens_without_audio: "0.0000012" })).toEqual({
    video: { output: { price: 2.4, overrides: [{ when: { generate_audio: { equals: false } }, price: 1.2 }] } },
  });
});

test("leaves the cost out of OpenRouter video models with unrepresentable SKUs", () => {
  // Minimum charge per generation (Runway Aleph 2.0).
  expect(videoCostOf({ cents_per_second_output: "28", minimum_cents_per_generation: "56" })).toBeUndefined();
  // Megapixel-seconds (FLUX Video Upscale).
  expect(videoCostOf({ cents_per_megapixel_second_precise: "3.5" })).toBeUndefined();
  // Unknown SKU names, mixed units, or no SKUs.
  expect(videoCostOf({ duration_seconds: "0.1", per_scene_fee: "1" })).toBeUndefined();
  expect(videoCostOf({ duration_seconds: "0.1", video_tokens: "0.000007" })).toBeUndefined();
  expect(mediaCost(openRouterVideoModel(undefined), "video")).toBeUndefined();
});

test("factors OpenRouter video models onto lab files with the videos protocol", () => {
  const doc = buildOpenRouterMediaModel(openRouterVideoModel(
    { duration_seconds_with_audio: "0.40", duration_seconds_without_audio: "0.20" },
    { id: "google/veo-3.1", name: "Google: Veo 3.1" },
  ), "video");

  expect(doc).toEqual({
    schema: 2,
    v2_only: true,
    base_model: "google/veo-3.1-generate-preview",
    name: "Veo 3.1",
    api: { videos: { base_url: "https://openrouter.ai/api/v1", sdk: { aisdk: "@openrouter/ai-sdk-provider", opencodeai: "none" } } },
    cost: {
      video: { output: { unit: "second", price: 0.4, overrides: [{ when: { generate_audio: { equals: false } }, price: 0.2 }] } },
    },
  });

  const standalone = buildOpenRouterMediaModel(openRouterVideoModel({ duration_seconds: "0.1" }), "video");
  expect(standalone).toMatchObject({
    type: "video",
    name: "Director 1",
    description: "Video generation model",
    modalities: { input: ["text", "image/png", "image/jpeg", "image/webp", "image/gif"], output: ["video/mp4"] },
    limit: { context: 0, output: 0 },
    api: { videos: { base_url: "https://openrouter.ai/api/v1" } },
  });
});

test("OpenRouter text models still sync through v1 fields", () => {
  const translated = openrouter.translateModel(openRouterModel(), {
    existing: () => undefined,
    authored: () => undefined,
    v2: () => undefined,
  });

  expect(translated).not.toHaveProperty("v2");
  expect(translated).toHaveProperty("model");
});

test("writes v2 sync entries as is and leaves unchanged files alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-v2-entry-"));
  const modelsDir = path.join(root, "providers", "example", "models");
  await mkdir(modelsDir, { recursive: true });
  let price = 15;
  const provider: SyncProvider<string> = {
    id: "v2-entry-test",
    name: "v2 entry test",
    modelsDir,
    async fetchModels() {
      return ["lab/voice"];
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id) {
      return {
        id,
        header: "# Example header\n",
        v2: buildOpenRouterMediaModel(openRouterMediaModel({
          id,
          pricing: { prompt: String(price / 1_000_000), completion: "0" },
        }), "speech"),
      };
    },
  };

  try {
    expect(await syncProvider(provider)).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const file = path.join(modelsDir, "lab", "voice.toml");
    expect(await readFile(file, "utf8")).toStartWith("# Example header\nschema = 2\nv2_only = true\n");
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    price = 20;
    expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(await readFile(file, "utf8")).toContain("price = 20");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 patches switch tool_call and reasoning between the lab's value and an override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-v2-flags-"));
  const modelsDir = path.join(root, "providers", "example", "models");
  await mkdir(path.join(root, "models", "lab"), { recursive: true });
  await mkdir(path.join(modelsDir, "lab"), { recursive: true });
  await writeFile(path.join(root, "models", "lab", "chat.toml"), [
    "schema = 2",
    'name = "Chat"',
    'description = "Example chat model"',
    "open_weights = false",
    'release_date = "2026-01-01"',
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = false }",
    "temperature = true",
    "top_p = true",
    "top_k = false",
    "",
    "[limit]",
    "context = 100_000",
    "output = 10_000",
    "",
  ].join("\n"));
  const file = path.join(modelsDir, "lab", "chat.toml");
  const write = (capabilities: string[]) => writeFile(file, [
    "schema = 2",
    'base_model = "lab/chat"',
    "",
    "[capabilities]",
    ...capabilities,
    "effort_updates = false",
    "",
    "[cost.text.input]",
    "price = 1",
    "",
    "[cost.text.output]",
    "price = 2",
    "",
  ].join("\n"));
  let synced: SyncedModel = { base_model: "lab/chat", cost: { input: 1, output: 2 } };
  const provider: SyncProvider<string> = {
    id: "v2-flags-test",
    name: "v2 flags test",
    modelsDir,
    async fetchModels() {
      return ["lab/chat"];
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id) {
      return { id, model: synced };
    },
  };

  try {
    // The file inherits tools from the lab; the source now reports none.
    await write([]);
    synced = { base_model: "lab/chat", tool_call: false, cost: { input: 1, output: 2 } };
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    let doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    expect(doc.capabilities).toEqual({ effort_updates: false, tools: { supported: false } });

    // The source reports tools again, which the lab already says: the override goes.
    synced = { base_model: "lab/chat", cost: { input: 1, output: 2 } };
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    expect(doc.capabilities).toEqual({ effort_updates: false });

    // An explicit value equal to the lab's, with v2-only data, is left alone.
    await write(["tools = { supported = true, updates = false }"]);
    expect(await syncProvider(provider)).toMatchObject({ updated: 0, unchanged: 1 });

    // Reasoning switches the same way.
    synced = { base_model: "lab/chat", reasoning: true, reasoning_options: [], cost: { input: 1, output: 2 } };
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    expect(doc.capabilities.reasoning).toEqual({ supported: true });
    expect(doc.capabilities.tools).toEqual({ supported: true, updates: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 sync patches keep legacy_shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-v2-legacy-shape-"));
  const modelsDir = path.join(root, "providers", "example", "models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models"), { recursive: true });
  const file = path.join(modelsDir, "chat.toml");
  await writeFile(file, [
    "schema = 2",
    'name = "Chat"',
    'description = "Example chat model"',
    "open_weights = false",
    'release_date = "2026-01-01"',
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
    "[capabilities]",
    "tools = { supported = true }",
    "reasoning = { supported = false }",
    "",
    "[limit]",
    "context = 100_000",
    "output = 10_000",
    "",
    "[api.responses]",
    'base_url = "https://example.com/v1"',
    'sdk = { aisdk = "@ai-sdk/openai" }',
    'legacy_shape = "responses"',
    "",
    "[cost.text.input]",
    "price = 1",
    "",
    "[cost.text.output]",
    "price = 2",
    "",
  ].join("\n"));
  const { id: _id, ...existing } = modelV2ToV1({ ...(Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, unknown>), id: "chat" });
  let synced = { ...existing, cost: { input: 3, output: 4 } } as SyncedModel;
  const provider: SyncProvider<string> = {
    id: "v2-legacy-shape-test",
    name: "v2 legacy shape test",
    modelsDir,
    async fetchModels() {
      return ["chat"];
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id) {
      return { id, model: synced };
    },
  };

  try {
    expect(existing.provider).toEqual({ npm: "@ai-sdk/openai", api: "https://example.com/v1", shape: "responses" });
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    let doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    expect(doc.cost.text.input.price).toBe(3);
    expect(doc.api.responses.legacy_shape).toBe("responses");

    // A provider change rewrites the API table from v1 and keeps the shape.
    synced = { ...synced, provider: { npm: "@ai-sdk/openai", api: "https://example.com/v2", shape: "responses" } } as SyncedModel;
    expect(await syncProvider(provider)).toMatchObject({ updated: 1 });
    doc = Bun.TOML.parse(await readFile(file, "utf8")) as Record<string, any>;
    expect(doc.api).toEqual({
      responses: { base_url: "https://example.com/v2", sdk: { aisdk: "@ai-sdk/openai" }, legacy_shape: "responses" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs OpenRouter decision models with no supported parameters as decision type", () => {
  const decision = openRouterModel({
    id: "cloudflare/clef-omni",
    name: "Cloudflare: Clef Omni",
    hugging_face_id: "Cloudflare/clef-omni",
    knowledge_cutoff: null,
    context_length: 65_536,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
    pricing: { prompt: "0.00000015", completion: "0" },
    top_provider: { context_length: 65_536, max_completion_tokens: 58_982 },
    supported_parameters: [],
  });
  const translated = openrouter.translateModel(decision, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model).toMatchObject({
    type: "decision",
    name: "Clef Omni",
    description: "Decision model for typed evaluation of shared state",
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0.15, output: 0 },
    limit: { context: 65_536, output: 0 },
  });
  // v1 reads the first API's package (systemone's) as the provider npm.
  expect(translated?.model.provider).toEqual({ npm: "@ai-sdk/typesafe-ai" });
  // /api/alpha/decisions takes the same System One body, so only /api/v1/systemone is listed.
  // OpenRouter reads images as `image_url` items in a `state` list.
  expect(translated?.v2Set?.api).toEqual({
    systemone: {
      sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/openrouter/decisions" },
      compatibility: { media_input: "state" },
    },
  });
  const chat = openrouter.translateModel(openRouterModel(), {
    existing: () => undefined,
    authored: () => undefined,
  });
  expect(chat?.model.type).toBeUndefined();
  expect(chat?.v2Set?.api).toBe(withTextApis);
});

test("lists Responses and Messages after the first API for OpenRouter text-only models", () => {
  const extra = {
    responses: { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } },
    messages: { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } },
  };
  // A file with no table gets the provider's default Chat Completions API first.
  expect(withTextApis(undefined)).toEqual({ "chat-completions": {}, ...extra });
  // The existing first table is kept as is, and a second run changes nothing.
  const first = { "chat-completions": { compatibility: { reasoning_field: "reasoning_details" } } };
  const once = withTextApis(first);
  expect(once).toEqual({ ...first, ...extra });
  expect(Object.keys(once)).toEqual(["chat-completions", "responses", "messages"]);
  expect(withTextApis(once)).toEqual(once);
  // Per-API capabilities on the extra tables survive a sync.
  const flagged = { ...once, messages: { ...extra.messages, capabilities: { tools: { updates: true } } } };
  expect(withTextApis(flagged)).toEqual(flagged);

  // Models that also output images or audio stay on their own APIs.
  const audio = openrouter.translateModel(openRouterModel({
    id: "openai/gpt-audio",
    name: "OpenAI: GPT Audio",
    architecture: { input_modalities: ["text", "audio"], output_modalities: ["text", "audio"] },
  }), translateContext);
  expect(audio?.v2Set).not.toHaveProperty("api");
});

test("OpenRouter and NanoGPT mark System One tables of image models with media_input = state", () => {
  const sdk = { aisdk: "@ai-sdk/typesafe-ai" };
  const once = withSystemOneMediaInput({ systemone: { sdk } }, true);
  expect(once).toEqual({ systemone: { sdk, compatibility: { media_input: "state" } } });
  expect(withSystemOneMediaInput(once, true)).toEqual(once);
  // A text-only model loses the field, and other tables are left alone.
  expect(withSystemOneMediaInput({ ...(once as object), "chat-completions": {} }, false))
    .toEqual({ systemone: { sdk }, "chat-completions": {} });
  expect(withSystemOneMediaInput(undefined, true)).toBeUndefined();
});

test("lists the Images API next to chat for OpenRouter chat models with an image lab", () => {
  const translated = openrouter.translateModel(openRouterModel({
    id: "google/gemini-2.5-flash-image",
    name: "Google: Nano Banana (Gemini 2.5 Flash Image)",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] },
  }), { existing: () => undefined, authored: () => undefined });

  expect(translated?.model.base_model).toBe("google/gemini-2.5-flash-image");
  expect(translated?.v2Set?.api).toEqual({
    "chat-completions": {},
    images: { sdk: { opencodeai: "@opencode/ai/providers/openrouter/images" } },
  });
});

test("factors OpenRouter decision models onto decision lab metadata without a chat description", () => {
  const translated = openrouter.translateModel(openRouterModel({
    id: "liquid/d1",
    name: "LiquidAI: d1",
    knowledge_cutoff: null,
    context_length: 65_536,
    architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
    pricing: { prompt: "0.00000004", completion: "0" },
    top_provider: { context_length: 65_536, max_completion_tokens: 58_982 },
    supported_parameters: [],
  }), {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model).toMatchObject({ base_model: "liquid/d1", cost: { input: 0.04, output: 0 } });
  expect(translated?.model).not.toHaveProperty("type"); // inherited from lab metadata
  expect(translated?.model).not.toHaveProperty("description");
  expect(translated?.model).not.toHaveProperty("limit");
});

test("inherits canonical Drex2 metadata instead of retaining an OpenRouter completion limit", () => {
  for (const existing of [undefined, { limit: { output: 117_964 } }]) {
    const model = buildOpenRouterModel(openRouterModel({
      id: "nace-ai/drex-v2.0",
      name: "Nace AI: Drex v2.0",
      knowledge_cutoff: null,
      context_length: 131_072,
      architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
      pricing: { prompt: "0.00000006", completion: "0" },
      top_provider: { context_length: 131_072, max_completion_tokens: 117_964 },
      supported_parameters: [],
    }), existing);

    expect(model).toMatchObject({ base_model: "nace-ai/drex-v2.0", cost: { input: 0.06, output: 0 } });
    for (const inherited of ["type", "description", "limit", "structured_output", "open_weights"]) {
      expect(model).not.toHaveProperty(inherited);
    }
  }
});

test("parses nullable EmpirioLabs release dates", () => {
  expect(empiriolabs.parseModels({
    data: [{ id: "unknown-text-model", category: "text", model_released_at: null }],
  })).toHaveLength(1);
});

test("syncs EmpirioLabs pricing tiers and reasoning controls", () => {
  const model: EmpiriolabsModel = {
    id: "minimax-m3",
    display_name: "MiniMax M3",
    category: "text",
    context_length: 1_000_000,
    max_output_tokens: null,
    capabilities: { reasoning: true },
    features: ["reasoning", "function_calling"],
    structured_output: "json_object",
    input_modalities: ["text", "image", "video"],
    output_modalities: ["text"],
    supported_parameters: [
      { name: "temperature" },
      { name: "max_completion_tokens", max: 524_288 },
      { name: "enable_thinking" },
      { name: "reasoning_effort", options: ["none", "low", "medium", "high", "max"] },
      { name: "thinking_budget", min: 1_024, max: 32_768 },
    ],
    pricing: [
      { prompt: "0.000000225", completion: "0.0000009", input_cache_read: "0.000000045" },
      {
        prompt: "0.00000045",
        completion: "0.0000018",
        input_cache_read: "0.000000045",
        min_context: 512_000,
      },
    ],
  };

  expect(buildEmpiriolabsModel(model, { base_model: "minimax/MiniMax-M3" })).toMatchObject({
    base_model: "minimax/MiniMax-M3",
    structured_output: true,
    reasoning_options: [
      { type: "effort", values: ["none", "low", "medium", "high", "max"] },
      { type: "budget_tokens", min: 1_024, max: 32_768 },
    ],
    cost: {
      input: 0.225,
      output: 0.9,
      cache_read: 0.045,
      tiers: [{
        tier: { type: "context", size: 512_000 },
        input: 0.45,
        output: 1.8,
        cache_read: 0.045,
      }],
    },
    limit: { context: 1_000_000, output: 524_288 },
  });
});

test("maps EmpirioLabs aliases to canonical model metadata", () => {
  expect(resolveEmpiriolabsBaseModel("fugu-ultra")).toBe("sakana/fugu-ultra");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-code")).toBe("bytedance-seed/seed-2.0-code");
  expect(resolveEmpiriolabsBaseModel("muse-spark-1-1")).toBe("meta/muse-spark-1.1");
  expect(resolveEmpiriolabsBaseModel("step-3-5-flash")).toBe("stepfun/step-3.5-flash");
});

function unavailableStub(): OpenRouterModel {
  return openRouterModel({
    id: "~anthropic/claude-fable-latest",
    name: "Anthropic: Claude Fable Latest",
    supported_parameters: [],
    pricing: { prompt: "-1", completion: "-1" },
    reasoning: { mandatory: true },
    top_provider: { context_length: null, max_completion_tokens: null },
  });
}

function llmGatewayModel(overrides: Partial<LLMGatewayModel> = {}): LLMGatewayModel {
  return {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    created: 1_780_963_200,
    family: "anthropic",
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "10.0e-6",
      completion: "50.0e-6",
      input_cache_read: "1.0e-6",
      input_cache_write: "12.5e-6",
      internal_reasoning: "0",
    },
    providers: [{}],
    context_length: 1_000_000,
    supported_parameters: ["temperature", "max_tokens", "top_p", "effort", "reasoning"],
    structured_outputs: true,
    ...overrides,
  };
}

function llmGatewayMappedModel(overrides: Partial<LLMGatewayModel> = {}): LLMGatewayModel {
  return llmGatewayModel({
    id: "anthropic/claude-fable-5",
    name: "Claude Fable 5 (Anthropic)",
    providers: [{
      providerId: "anthropic",
      vision: true,
      tools: true,
      reasoning: true,
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
    }],
    max_output: 128_000,
    ...overrides,
  });
}

function mergeGatewayVendor(
  overrides: Partial<MergeGatewayModel["vendors"][string]> = {},
): MergeGatewayModel["vendors"][string] {
  return {
    launch_date: "2026-07-09",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    availability_status: "available",
    capabilities: {
      input: ["text", "image", "document"],
      output: ["text", "tool_use"],
      supports_tool_calling: true,
      supports_tool_choice: true,
      supports_structured_outputs: true,
      streaming: true,
    },
    pricing: {
      currency: "USD",
      input_per_million: 5,
      output_per_million: 30,
    },
    ...overrides,
  };
}

function mergeGatewayModel(overrides: Partial<MergeGatewayModel> = {}): MergeGatewayModel {
  return {
    model: "openai/gpt-5.6-sol",
    provider: "openai",
    display_name: "GPT-5.6 Sol",
    vendors: { openai: mergeGatewayVendor() },
    availability_status: "available",
    created_at: "2026-07-09T00:00:00Z",
    updated_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

function edenAIModel(overrides: Partial<EdenAIModel> = {}): EdenAIModel {
  return {
    id: "openai/gpt-5.6-terra",
    owned_by: "openai",
    model_name: "gpt-5.6-terra",
    context_length: 1_050_000,
    capabilities: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supports_function_calling: true,
      supports_response_schema: true,
    },
    list_pricing: {
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000012,
    },
    ...overrides,
  };
}

function hyperModel(overrides: Partial<HyperModel> = {}): HyperModel {
  return {
    id: "deepseek-v4-flash",
    created: 1_780_592_628,
    display_name: "DeepSeek V4 Flash",
    reasoning: {
      effort_levels: [
        { value: "high" },
        { value: "xhigh" },
      ],
    },
    context_window: 1_000_000,
    max_output_tokens: 384_000,
    ...overrides,
  };
}

function openRouterModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    created: 1_782_777_600,
    hugging_face_id: null,
    knowledge_cutoff: "2026-01-31",
    context_length: 1_000_000,
    architecture: {
      input_modalities: ["text", "image", "file"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
    },
    top_provider: {
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
    },
    supported_parameters: ["include_reasoning", "reasoning", "structured_outputs", "tools"],
    ...overrides,
  };
}

function openRouterMediaModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "examplelab/voice-1",
    name: "Example Lab: Voice 1",
    created: 1_791_929_559,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: 0,
    architecture: { input_modalities: ["text"], output_modalities: ["speech"] },
    pricing: { prompt: "0.000015", completion: "0" },
    top_provider: { context_length: 0, max_completion_tokens: 0 },
    supported_parameters: [],
    ...overrides,
  };
}

function caseFoldProvider(modelsDir: string, ids: string[]): SyncProvider<string> {
  return {
    id: "case-fold-test",
    name: "Case fold test",
    modelsDir,
    async fetchModels() {
      return ids;
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id) {
      return {
        id,
        model: {
          name: id,
          description: "Case-fold guard test model.",
          release_date: "2026-08-14",
          last_updated: "2026-08-14",
          attachment: false,
          reasoning: false,
          tool_call: false,
          open_weights: false,
          cost: { input: 1, output: 2 },
          limit: { context: 8_192, output: 4_096 },
          modalities: { input: ["text"], output: ["text"] },
        },
      };
    },
  };
}

test("skips a new model that can't be written as v2 and reports it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-v2-skip-"));
  const modelsDir = path.join(root, "providers", "v2-skip-test", "models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models"));
  const provider = caseFoldProvider(modelsDir, ["alpha"]);
  const translateModel = provider.translateModel;
  provider.translateModel = (id, context) => {
    const translated = translateModel(id, context) as { id: string; model: SyncedModel };
    return { ...translated, model: { ...translated.model, interleaved: true } };
  };

  try {
    const result = await syncProvider(provider);
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(result.notices).toEqual([expect.stringContaining("Could not write v2 model alpha.toml")]);
    expect(await Bun.file(path.join(modelsDir, "alpha.toml")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects synced model paths that differ only in case", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-case-fold-"));
  const modelsDir = path.join(root, "providers", "case-fold-test", "models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models"));

  try {
    await expect(
      syncProvider(caseFoldProvider(modelsDir, ["Alpha", "alpha"])),
    ).rejects.toThrow(/differ only in case/u);

    await expect(
      syncProvider(caseFoldProvider(modelsDir, ["beta", "beta"])),
    ).rejects.toThrow(/Duplicate synced model path/u);

    const clean = await syncProvider(
      caseFoldProvider(modelsDir, ["Gamma", "delta"]),
    );
    expect(clean).toMatchObject({ created: 2, updated: 0, deleted: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Vercel sync keeps exact MIME modalities and leaves model facts to the lab in v2 files", () => {
  const [model] = vercel.parseModels({
    data: [{
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      created: 1_771_286_400,
      context_window: 1_000_000,
      max_tokens: 128_000,
      type: "language",
      tags: ["reasoning", "tool-use", "vision"],
      pricing: { input: "0.000004", output: "0.000015" },
    }],
  });
  // A host override of the lab's MIME list (no PDF, no GIF) next to stale model facts.
  const doc = {
    schema: 2,
    base_model: "anthropic/claude-sonnet-4-6",
    family: "claude",
    open_weights: true,
    knowledge: "2025-09",
    release_date: "2025-01-01",
    last_updated: "2025-02-01",
    modalities: { input: ["text", "image/jpeg", "image/png", "image/webp"], output: ["text"] },
    capabilities: { reasoning: { supported: true, effort: ["low", "high"] } },
    cost: { text: { input: { price: 3 }, output: { price: 15 } } },
  };
  const { id: _id, ...existing } = modelV2ToV1({ ...doc, id: "anthropic/claude-sonnet-4.6" });

  const synced = buildVercelModel(model!, existing as ExistingModel) as Record<string, any>;
  expect(synced.modalities).toEqual({ input: ["text", "image"] });
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(synced).not.toHaveProperty(fact);
  }

  const after = { ...synced, modalities: { input: ["text", "image"], output: ["text"] } };
  const next = patchModelV2(doc, existing, after);
  expect(next.modalities).toEqual(doc.modalities);
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(next).not.toHaveProperty(fact);
  }
  expect(next.cost).toEqual({ text: { input: { price: 4 }, output: { price: 15 } } });
  expect(sameV1Model(modelV2ToV1({ ...next, id: "x" }), { ...after, id: "x" })).toBe(true);

  // A file that inherits the lab's MIME list gets no generic override.
  const inherited = buildVercelModel(
    vercel.parseModels({ data: [{ ...model!, tags: ["reasoning", "tool-use", "vision", "file-input"] }] })[0]!,
    { base_model: "anthropic/claude-sonnet-4-6", reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
  );
  expect(inherited).not.toHaveProperty("modalities");
});

test("Kilo sync keeps v2-only data and leaves model facts to the lab in v2 files", () => {
  const [model] = kilo.parseModels({
    data: [{
      id: "anthropic/claude-opus-5.5",
      name: "Anthropic: Claude Opus 5.5",
      created: 1_790_000_000,
      hugging_face_id: "",
      knowledge_cutoff: "2026-06-30",
      context_length: 1_000_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002", input_cache_write: "0.000005" },
      top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
      supported_parameters: ["reasoning", "include_reasoning", "tools", "tool_choice", "structured_outputs"],
      opencode: {
        variants: {
          max: { reasoning: { enabled: true, effort: "max" } },
          low: { reasoning: { enabled: true, effort: "low" } },
          high: { reasoning: { enabled: true, effort: "high" } },
        },
      },
    }],
  });
  // A host override of the lab's MIME list (no PDF), mid-conversation flags and cache support, next to stale model facts.
  const doc = {
    schema: 2,
    base_model: "anthropic/claude-opus-5-5",
    family: "claude",
    open_weights: true,
    knowledge: "2025-01",
    release_date: "2025-01-01",
    last_updated: "2025-02-01",
    modalities: { input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"], output: ["text"] },
    capabilities: {
      tools: { supported: true, updates: false },
      reasoning: { supported: true, effort: ["low", "high", "max"] },
      structured_output: true,
      effort_updates: false,
      cache: { implicit: true },
    },
    cost: { text: { input: { price: 4, cache: { read: 0.2, write: 5 } }, output: { price: 20 } } },
  };
  const { id: _id, ...existing } = modelV2ToV1({ ...doc, id: "anthropic/claude-opus-5.5" });

  const synced = buildKiloModel(model!, existing as ExistingModel) as Record<string, any>;
  expect(synced.base_model).toBe("anthropic/claude-opus-5-5");
  expect(synced.modalities).toEqual({ input: ["text", "image"] });
  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["low", "high", "max"] }]);
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(synced).not.toHaveProperty(fact);
  }

  // The engine fills the unchanged modality side from the lab before patching.
  const after = { ...synced, modalities: { input: ["text", "image"], output: ["text"] }, cost: { ...synced.cost, input: 5 } };
  const next = patchModelV2(doc, existing, after) as Record<string, any>;
  expect(next.modalities).toEqual(doc.modalities);
  expect(next.capabilities).toMatchObject({
    tools: { supported: true, updates: false },
    effort_updates: false,
    cache: { implicit: true },
  });
  expect(next.cost.text.input.price).toBe(5);
  for (const fact of ["family", "open_weights", "knowledge", "release_date", "last_updated"]) {
    expect(next).not.toHaveProperty(fact);
  }
});

test("Kilo sync keeps the catalog display name on linked files", () => {
  const [model] = kilo.parseModels({
    data: [{
      id: "cognitivecomputations/dolphin-mistral-24b-venice-edition",
      name: "Venice: Uncensored",
      created: 1_750_000_000,
      context_length: 32_768,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000002", completion: "0.0000009" },
      top_provider: { context_length: 32_768, max_completion_tokens: 8_192 },
      supported_parameters: ["temperature", "tools"],
    }],
  });
  const base_model = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
  const named = { base_model, name: "Venice: Uncensored" } as ExistingModel;

  // A linked file with its own display name keeps Kilo's name, and so does a new file.
  expect(buildKiloModel(model!, named, undefined, named)).toMatchObject({ name: "Venice: Uncensored" });
  expect(buildKiloModel(model!, undefined)).toMatchObject({ name: "Venice: Uncensored" });
  // A linked file that inherits the lab's name keeps inheriting it.
  const unnamed = { base_model } as ExistingModel;
  expect(buildKiloModel(model!, unnamed, undefined, unnamed)).not.toHaveProperty("name");
});

test("Ofox sync takes context tiers and audio prices from the catalog and keeps v2-only data", () => {
  const [model] = ofox.parseModels({
    data: [{
      id: "openai/gpt-5.5",
      mode: "chat",
      pricing: {
        input: "0.000005",
        output: "0.00003",
        audio: "0.000002",
        input_cache_read: "0.0000005",
        input_cache_write_5m: "0.00000625",
        context_price_tiers: [{ threshold_tokens: 272_000, input: 0.00001, output: 0.000045, cache_read: 0.000001 }],
      },
    }],
  });
  const doc = {
    schema: 2,
    base_model: "openai/gpt-5.5",
    capabilities: {
      tools: { supported: true, updates: false },
      structured_output: true,
      effort_updates: false,
      cache: { implicit: true },
    },
    api: { responses: { base_url: "https://api.ofox.ai/v1", sdk: { aisdk: "@ai-sdk/openai" } } },
    cost: { text: { input: { price: 4, cache: { read: 0.4, write: { "5m": 5, "1h": 8 } } }, output: { price: 20 } } },
  };
  const { id: _id, ...existing } = modelV2ToV1({ ...doc, id: "openai/gpt-5.5" });

  const synced = buildOfoxModel(model!, existing as ExistingModel) as Record<string, any>;
  expect(synced.base_model).toBe("openai/gpt-5.5");
  expect(synced.cost).toEqual({
    input: 5,
    output: 30,
    cache_read: 0.5,
    cache_write: 6.25,
    input_audio: 2,
    tiers: [{ tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache_read: 1, cache_write: undefined }],
  });

  const next = patchModelV2(doc, existing, synced) as Record<string, any>;
  expect(next.capabilities).toEqual(doc.capabilities);
  expect(next.api).toEqual(doc.api);
  expect(next.cost.text.input).toMatchObject({ price: 5, cache: { read: 0.5, write: { "5m": 6.25, "1h": 10 } } });
  expect(next.cost.text.input.overrides).toEqual([{ when: { context: { gt: 272_000 } }, price: 10, cache: { read: 1 } }]);
  expect(next.cost.audio.input.price).toBe(2);
});

function huggingFaceModel(overrides: Partial<HuggingFaceModel> = {}): HuggingFaceModel {
  return {
    id: "Qwen/Qwen3.5-122B-A10B",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    providers: [
      { provider: "slow", status: "live", context_length: 131_072, pricing: { input: 0.3, output: 2 }, throughput: 10, supports_tools: true },
      { provider: "fast", status: "live", context_length: 262_144, pricing: { input: 0.4, output: 3.2 }, throughput: 90, supports_structured_output: true },
    ],
    ...overrides,
  };
}

test("Hugging Face creates v2 files with host data only and the lab's exact MIME types", () => {
  const doc = buildHuggingFaceModel(huggingFaceModel(), "alibaba/qwen3.5-122b-a10b");
  for (const key of ["name", "description", "family", "release_date", "last_updated", "knowledge", "open_weights"]) {
    expect(doc).not.toHaveProperty(key);
  }
  expect(doc).toMatchObject({
    schema: 2,
    base_model: "alibaba/qwen3.5-122b-a10b",
    // The router lists text + image; the lab also takes video.
    modalities: {
      input: ["text", "image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp", "image/heic"],
      output: ["text"],
    },
    capabilities: {
      tools: { supported: true },
      structured_output: true,
    },
    cost: { text: { input: { price: 0.4 }, output: { price: 3.2 } } },
    api: {
      "chat-completions": { compatibility: { max_tokens_field: "max_tokens" } },
      responses: { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } },
    },
  });
  expect(doc).not.toHaveProperty("limit");

  // Same modality kinds as the lab: inherited.
  const textOnly = buildHuggingFaceModel(huggingFaceModel({
    id: "openai/gpt-oss-20b",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  }), "openai/gpt-oss-20b");
  expect(textOnly).not.toHaveProperty("modalities");

  // No live provider reports tools: tool support is inherited, not copied from the lab.
  const noTools = buildHuggingFaceModel(huggingFaceModel({
    providers: [{ provider: "fast", status: "live", pricing: { input: 0.4, output: 3.2 }, throughput: 90 }],
  }), "alibaba/qwen3.5-122b-a10b");
  expect(noTools.capabilities).not.toHaveProperty("tools");
});

test("Hugging Face skips new reasoning models until their controls are authored", () => {
  const context = { existing: () => undefined, authored: () => undefined, v2: () => undefined };
  expect(() => huggingface.translateModel(huggingFaceModel(), context)).toThrow(MissingReasoningOptionsError);
  // Qwen3 Next Instruct doesn't reason: created.
  expect(huggingface.translateModel(huggingFaceModel({ id: "Qwen/Qwen3-Next-80B-A3B-Instruct" }), context))
    .toMatchObject({ v2: { base_model: "alibaba/qwen3-next-80b-a3b-instruct" } });
  expect(() => buildHuggingFaceModel(huggingFaceModel(), "lab/missing")).toThrow("no lab file");
});

test("Hugging Face writes existing files back unchanged apart from their API tables", () => {
  const v2 = { schema: 2, base_model: "alibaba/qwen3.5-122b-a10b", cost: { text: { input: { price: 9 }, output: { price: 9 } } } };
  const responses = { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } };
  const translate = (doc: Record<string, unknown>) => huggingface.translateModel(huggingFaceModel(), {
    existing: () => ({ base_model: "alibaba/qwen3.5-122b-a10b" }),
    authored: () => ({ base_model: "alibaba/qwen3.5-122b-a10b" }),
    v2: () => doc,
  });
  // A file with no table gets the provider's Chat Completions API (capped by max_tokens) first, then Responses.
  const once = translate(v2);
  expect(once).toEqual({
    id: "Qwen/Qwen3.5-122B-A10B",
    v2: { ...v2, api: { "chat-completions": { compatibility: { max_tokens_field: "max_tokens" } }, responses } },
  });
  // An existing first table keeps its settings and gains max_tokens_field, and a second run changes nothing.
  const first = { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } };
  const kept = translate({ ...v2, api: first }) as { v2: Record<string, unknown> };
  expect(Object.keys(kept.v2.api as object)).toEqual(["chat-completions", "responses"]);
  expect(kept.v2.api).toEqual({
    "chat-completions": { compatibility: { reasoning_field: "reasoning_content", max_tokens_field: "max_tokens" } },
    responses,
  });
  expect(translate(kept.v2)).toEqual(kept);
  expect(huggingface.translateModel(huggingFaceModel({ providers: [] }), {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
});

test("OpenRouter web search prices become v2 prices per 1,000, by search context size where listed", () => {
  const cost = catalogCost(openRouterModel({
    id: "lab/model",
    pricing: {
      prompt: "0.000002",
      completion: "0.000008",
      web_search: "0.0035",
      web_search_per_1000_requests_low: "2.5",
      web_search_per_1000_requests_high: "8",
      overrides: [
        { min_prompt_tokens: 200_000, prompt: "0.000004", web_search: "0.007" },
        { utc_days: ["saturday"], web_search_per_1000_requests_high: "6" },
      ],
    },
  } as Partial<OpenRouterModel>));
  expect(cost.webSearch).toEqual({
    price: 3.5,
    overrides: [
      { when: { search_context_size: { equals: "low" } }, price: 2.5 },
      { when: { search_context_size: { equals: "high" } }, price: 8 },
      { when: { context: { gt: 200_000 } }, price: 7 },
      { when: { utc_days: { in: ["sat"] }, search_context_size: { equals: "high" } }, price: 6 },
    ],
  });
  expect(cost.notices).toEqual([]);

  // Without a flat price, the medium one is the base.
  const sized = catalogCost(openRouterModel({
    id: "lab/model",
    pricing: { prompt: "0.000002", completion: "0.000008", web_search_per_1000_requests_medium: "10" },
  } as Partial<OpenRouterModel>));
  expect(sized.webSearch).toEqual({ price: 10, overrides: [{ when: { search_context_size: { equals: "medium" } }, price: 10 }] });

  // Zero stands for no price; anything else unreadable is reported.
  const free = catalogCost(openRouterModel({ id: "lab/model", pricing: { prompt: "0", completion: "0", web_search: "0" } }));
  expect(free.webSearch).toBeUndefined();
  expect(free.notices).toEqual([]);
  const broken = catalogCost(openRouterModel({ id: "lab/model", pricing: { prompt: "0", completion: "0", web_search: "n/a" } }));
  expect(broken.webSearch).toBeUndefined();
  expect(broken.notices).toEqual(["lab/model: web_search not synced: not a price"]);
});

test("Kilo web search prices go to v2 per 1,000", () => {
  const kiloModel = (web_search?: string) => kilo.parseModels({
    data: [{
      id: "openai/gpt-5.5",
      name: "OpenAI: GPT-5.5",
      created: 1_790_000_000,
      context_length: 400_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000005", completion: "0.00003", ...(web_search === undefined ? {} : { web_search }) },
      top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
      supported_parameters: ["tools"],
    }],
  })[0]!;
  const v2Set = (web_search?: string) =>
    (kilo.translateModel(kiloModel(web_search), translateContext) as { v2Set: Record<string, unknown> }).v2Set;

  expect(v2Set("0.028000000000")["cost.web_search"]).toEqual({ price: 28 });
  // Kilo lists "0" on routes with no web search price.
  expect(v2Set("0")["cost.web_search"]).toBeUndefined();
  expect(v2Set()["cost.web_search"]).toBeUndefined();
});

test("Vercel cache support comes from tags, else from a cache read price", () => {
  const cache = (tags: string[], id = "example/model", pricing?: object) =>
    vercelCache({ id, tags, pricing } as Parameters<typeof vercelCache>[0]);
  expect(cache([])).toBeUndefined();
  expect(cache(["implicit-caching"])!(undefined)).toEqual({ implicit: true });
  expect(cache(["implicit-caching", "explicit-caching"])!({ explicit: { ttl: ["5m", "1h"] } }))
    .toEqual({ implicit: true, explicit: { ttl: ["5m", "1h"] } });
  // Untagged but priced: implicit, or explicit for Anthropic.
  expect(cache([], "mistral/codestral", { input_cache_read: "0.03" })!(undefined)).toEqual({ implicit: true });
  expect(cache([], "anthropic/claude-x", { input_cache_read: "0.3" })!(undefined)).toEqual({ explicit: true });
  expect(cache([], "perplexity/sonar", { input_cache_write: "0.0625" })).toBeUndefined();
});
