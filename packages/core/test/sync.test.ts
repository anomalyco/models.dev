import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatToml, preserveReasoningOptions, syncProvider, type ExistingModel, type SyncProvider } from "../src/sync/index.js";
import {
  anthropic,
  buildAnthropicModel,
  parseAnthropicPricing,
  type AnthropicModel,
} from "../src/sync/providers/anthropic.js";
import {
  buildCrossModel,
  type CrossModelModel,
} from "../src/sync/providers/crossmodel.js";
import { buildDeepInfraModel, type DeepInfraModel } from "../src/sync/providers/deepinfra.js";
import {
  buildDigitalOceanModel,
  digitalocean,
  fetchDigitalOceanModels,
  parseDigitalOceanModels,
  resolveDigitalOceanBaseModel,
  type DigitalOceanSourceModel,
} from "../src/sync/providers/digitalocean.js";
import { buildHyperModel, type HyperModel } from "../src/sync/providers/hyper.js";
import {
  buildEmpiriolabsModel,
  empiriolabs,
  resolveEmpiriolabsBaseModel,
  type EmpiriolabsModel,
} from "../src/sync/providers/empiriolabs.js";
import {
  buildOpenRouterModel,
  openrouter,
  resolveCanonicalBaseModel,
  type OpenRouterModel,
} from "../src/sync/providers/openrouter.js";
import { buildLLMGatewayModel, type LLMGatewayModel } from "../src/sync/providers/llmgateway.js";
import {
  buildMergeGatewayModel,
  fetchMergeGatewayModels,
  mergeGateway,
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
import { pioneer } from "../src/sync/providers/pioneer.js";
import { google, shouldTrackGoogleModel } from "../src/sync/providers/google.js";
import { buildTinfoilModel, tinfoil, type TinfoilModel } from "../src/sync/providers/tinfoil.js";
import { resolveVeniceBaseModel } from "../src/sync/providers/venice.js";
import { buildVercelModel, vercel } from "../src/sync/providers/vercel.js";
import { buildWandbModel, type WandbModel } from "../src/sync/providers/wandb.js";
import { buildXAIModel } from "../src/sync/providers/xai.js";

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
    'description = "Stale provider description"',
    "reasoning = false",
    "structured_output = true",
    "",
    "[limit]",
    "context = 1_000_000",
    "input = 1_000_000",
    "output = 128_000",
    "",
  ].join("\n"));
  await Bun.write(metadataPath, [
    'description = "Canonical description"',
    "reasoning = true",
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
    expect(content).toContain("reasoning = false");
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
    'name = "Existing GPT"',
    'release_date = "2026-01-01"',
    'last_updated = "2026-01-01"',
    "attachment = false",
    "reasoning = false",
    "tool_call = true",
    "open_weights = false",
    "",
    "[cost]",
    "input = 1",
    "output = 2",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
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

test("does not track unreliable remote-only models", () => {
  expect(google.skipCreates).toBe(true);
  expect(google.trackMissingModels).toBe(false);
  expect(openai.skipCreates).toBe(true);
  expect(openai.trackMissingModels).toBe(false);
  expect(pioneer.skipCreates).toBe(true);
  expect(pioneer.trackMissingModels).toBe(false);
});

test("tracks public Google model families but not opaque internal IDs", () => {
  expect(shouldTrackGoogleModel("gemini-3.1-flash-live-preview")).toBe(true);
  expect(shouldTrackGoogleModel("imagen-4.0-generate-001")).toBe(true);
  expect(shouldTrackGoogleModel("veo-3.1-generate-preview")).toBe(true);
  expect(shouldTrackGoogleModel("ajax")).toBe(false);
  expect(shouldTrackGoogleModel("perseus-2")).toBe(false);
  expect(shouldTrackGoogleModel("thorin")).toBe(false);
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
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max", "xhigh"] }],
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

test("resolves DigitalOcean IDs to canonical model metadata", () => {
  expect(resolveDigitalOceanBaseModel("openai-gpt-5.5")).toBe("openai/gpt-5.5");
  expect(resolveDigitalOceanBaseModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  expect(resolveDigitalOceanBaseModel("mimo-v2.5-pro")).toBe("xiaomi/mimo-v2.5-pro");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-5-sonnet")).toBe("anthropic/claude-sonnet-5");
  expect(resolveDigitalOceanBaseModel("anthropic-claude-opus-5")).toBe("anthropic/claude-opus-5");
  expect(resolveDigitalOceanBaseModel("openai-gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
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

test("formats interleaved as a root field before reasoning option tables", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("formats empty reasoning options outside the interleaved table", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: { field: "reasoning_content" },
    reasoning_options: [],
  });
});

test("formats provider overrides and experimental modes", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: false,
    tool_call: true,
    open_weights: false,
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
    provider: { body: { custom_flag: true } },
    experimental: {
      modes: {
        fast: {
          cost: { input: 2, output: 4 },
          provider: {
            body: { speed: "fast" },
            headers: { "anthropic-beta": "fast-mode-2026-02-01" },
          },
        },
      },
    },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    provider: { body: { custom_flag: true } },
    experimental: {
      modes: {
        fast: {
          cost: { input: 2, output: 4 },
          provider: {
            body: { speed: "fast" },
            headers: { "anthropic-beta": "fast-mode-2026-02-01" },
          },
        },
      },
    },
  });
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

test("formats reasoning efforts from lowest to highest", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    description: "Example model for sync formatting regression tests",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{
      type: "effort",
      values: ["max", "xhigh", "high", "medium", "low", "minimal", "none", "default"],
    }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(content).toContain(
    'values = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]',
  );
});

test("defaults new reasoning models to empty reasoning options", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined)).toEqual({
    reasoning: true,
    reasoning_options: [],
  });
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
      { type: "effort", values: ["max", "xhigh", "high", "medium", "low"] },
    ],
  });
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

// Ensures Merge Gateway namespaces reuse the matching canonical model metadata.
test("resolves Merge Gateway provider aliases to canonical metadata", () => {
  expect([
    resolveCanonicalBaseModel("moonshot/kimi-k2.5"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.6"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.7-code"),
    resolveCanonicalBaseModel("moonshot/kimi-k2.7-code-highspeed"),
    resolveCanonicalBaseModel("sakana/fugu-ultra"),
  ]).toEqual([
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.7-code",
    "moonshotai/kimi-k2.7-code-highspeed",
    "sakana/fugu-ultra",
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
      { type: "effort", values: ["max", "xhigh", "high", "medium", "low"] },
    ],
  });
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
      { type: "effort", values: ["high", "medium", "low"] },
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

test("parses Vercel pricing tiers with an implicit zero minimum", () => {
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
      },
    }],
  });

  expect(model).toBeDefined();
  expect(buildVercelModel(model!, undefined)).toMatchObject({
    cost: { input: 1, output: 6, cache_read: 0.1 },
  });
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

  expect(buildVercelModel(model!, undefined)).toMatchObject({
    base_model: "anthropic/claude-opus-5",
    name: "Claude Opus 5 (Fast)",
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  });
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
  await Bun.write(path.join(modelsDir, "example-model.toml"), [
    "# Documented quirk: this route needs a manual note.",
    "# https://example.com/docs (accessed 2026-06-25)",
    'name = "Example Model"',
    'release_date = "2026-01-01"',
    'last_updated = "2026-01-01"',
    "attachment = false",
    "reasoning = false",
    "tool_call = true",
    "open_weights = false",
    "",
    "[cost]",
    "input = 1",
    "output = 2",
    "",
    "[limit]",
    "context = 1_000",
    "output = 100",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
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
    expect(written).toContain("input = 3");
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
      { type: "toggle" },
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
    context_length: 1_000_000,
    supported_parameters: ["temperature", "max_tokens", "top_p", "effort", "reasoning"],
    structured_outputs: true,
    ...overrides,
  };
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
