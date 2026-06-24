import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";
import { assertValidNearAISource, cachePrice, requiredOutputLimit } from "./nearai-validation.js";

const API_ENDPOINT = "https://cloud-api.near.ai/v1/models";

const Price = z.union([z.string(), z.number()]);

const Pricing = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  prompt: Price.optional(),
  completion: Price.optional(),
  input_cache_read: Price.optional(),
  input_cache_write: Price.optional(),
}).passthrough();

const TopProvider = z.object({
  context_length: z.number().int().nonnegative().nullable().optional(),
  max_completion_tokens: z.number().int().nonnegative().nullable().optional(),
  is_moderated: z.boolean().optional(),
}).passthrough();

export const NearAIModel = z.object({
  id: z.string().min(1),
  object: z.string().optional(),
  created: z.number().int().nonnegative(),
  owned_by: z.string().min(1),
  name: z.string().min(1),
  pricing: Pricing,
  context_length: z.number().int().nonnegative(),
  max_output_length: z.number().int().nonnegative().nullable().optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
  supported_features: z.array(z.string()),
  is_ready: z.boolean().nullable().optional(),
  top_provider: TopProvider.optional(),
}).passthrough();

const NearAIResponse = z.object({
  data: z.array(NearAIModel),
}).passthrough();

export type NearAIModel = z.infer<typeof NearAIModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

const BASE_MODEL_ALIASES: Record<string, string> = {
  "Qwen/Qwen3.5-122B-A10B": "alibaba/qwen3.5-122b-a10b",
  "Qwen/Qwen3.6-27B-FP8": "alibaba/qwen3.6-27b",
  "Qwen/Qwen3.6-35B-A3B-FP8": "alibaba/qwen3.6-35b-a3b",
  "deepseek-ai/DeepSeek-V4-Flash": "deepseek/deepseek-v4-flash",
  "z-ai/glm-5.2": "zhipuai/glm-5.2",
};

const REASONING_OPTIONS: Record<string, ReasoningOptions> = {
  "Qwen/Qwen3.5-122B-A10B": [{ type: "toggle" }],
  "Qwen/Qwen3.6-27B-FP8": [{ type: "toggle" }],
  "Qwen/Qwen3.6-35B-A3B-FP8": [{ type: "toggle" }],
  "anthropic/claude-haiku-4-5": [{ type: "budget_tokens", min: 1_024, max: 63_999 }],
  "anthropic/claude-opus-4-6": [
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high", "max"] },
    { type: "budget_tokens", min: 1_024, max: 127_999 },
  ],
  "anthropic/claude-opus-4-7": [
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ],
  "anthropic/claude-sonnet-4-5": [{ type: "budget_tokens", min: 1_024, max: 63_999 }],
  "anthropic/claude-sonnet-4-6": [
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high", "max"] },
    { type: "budget_tokens", min: 1_024, max: 63_999 },
  ],
  "deepseek-ai/DeepSeek-V4-Flash": [{ type: "toggle" }],
  "google/gemini-2.5-flash": [],
  "google/gemini-2.5-flash-lite": [],
  "google/gemini-2.5-pro": [],
  "google/gemini-3.1-flash-lite": [],
  "google/gemini-3.5-flash": [],
  "google/gemma-4-31B-it": [{ type: "toggle" }],
  "moonshotai/kimi-k2.6": [],
  "openai/gpt-5": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5-mini": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5-nano": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "openai/gpt-5.1": [{ type: "effort", values: ["none", "low", "medium", "high"] }],
  "openai/gpt-5.2": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4-mini": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.4-nano": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-5.5": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "openai/gpt-oss-120b": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o3": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o3-mini": [{ type: "effort", values: ["low", "medium", "high"] }],
  "openai/o4-mini": [{ type: "effort", values: ["low", "medium", "high"] }],
  "qwen/qwen3.7-max": [],
  "z-ai/glm-5.2": [{ type: "toggle" }],
  "zai-org/GLM-5.1-FP8": [{ type: "toggle" }],
};

export const nearai = {
  id: "nearai",
  name: "NEAR AI Cloud",
  modelsDir: "providers/nearai/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`NEAR AI Cloud models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = NearAIResponse.parse(raw).data;
    assertValidNearAISource(models);
    return models;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const synced = buildNearAIModel(model, existing);
    return { id: model.id, model: synced };
  },
} satisfies SyncProvider<NearAIModel>;

export function buildNearAIModel(
  model: NearAIModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const outputLimit = requiredOutputLimit(model);

  const features = new Set(model.supported_features);
  const samplingParameters = new Set(model.supported_sampling_parameters);
  const input = modalities(model.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing?.modalities?.output ?? ["text"]);
  const limit = {
    context: model.top_provider?.context_length ?? model.context_length,
    input: existing?.limit?.input,
    output: outputLimit,
  };
  const values: Partial<SyncedFullModel> = {
    name: model.name,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment: input.some((value) => value !== "text"),
    reasoning: features.has("reasoning"),
    reasoning_options: reasoningOptions(model, existing),
    temperature: samplingParameters.has("temperature"),
    tool_call: features.has("tools"),
    structured_output: features.has("structured_outputs"),
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost: {
      input: perMillionPrice(model.pricing.input),
      output: perMillionPrice(model.pricing.output),
      reasoning: existing?.cost?.reasoning,
      cache_read: cachePrice(model.pricing.input_cache_read) ?? existing?.cost?.cache_read,
      cache_write: cachePrice(model.pricing.input_cache_write) ?? existing?.cost?.cache_write,
      input_audio: existing?.cost?.input_audio,
      output_audio: existing?.cost?.output_audio,
      tiers: existing?.cost?.tiers,
    },
    limit,
    modalities: { input, output },
  };
  const baseModel = existing?.base_model ?? resolveNearAIBaseModel(model.id);
  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  return {
    ...values,
    name: model.name,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: values.attachment ?? false,
    reasoning: values.reasoning ?? false,
    temperature: values.temperature,
    tool_call: values.tool_call ?? false,
    structured_output: values.structured_output,
    open_weights: existing?.open_weights ?? model.owned_by === "nearai",
    cost: values.cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function resolveNearAIBaseModel(id: string) {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) return alias;
  const canonical = resolveCanonicalBaseModel(id);
  if (canonical !== undefined) return canonical;
  return resolveCanonicalBaseModel(normalizedCanonicalID(id));
}

function reasoningOptions(model: NearAIModel, existing: ExistingModel | undefined): ReasoningOptions | undefined {
  if (existing?.reasoning_options !== undefined) return existing.reasoning_options;
  if (!model.supported_features.includes("reasoning")) return undefined;
  return REASONING_OPTIONS[model.id] ?? [];
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function perMillionPrice(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizedCanonicalID(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return id;
  const modelID = parts.join("/").replace(/-FP8$/i, "").toLowerCase();
  const canonicalPrefix = {
    Qwen: "qwen",
    "deepseek-ai": "deepseek",
    "z-ai": "zai",
    "zai-org": "zai",
  }[prefix];
  return canonicalPrefix === undefined ? id : `${canonicalPrefix}/${modelID}`;
}

function modalities(values: readonly string[], fallback: readonly Modality[]): Modality[] {
  const normalized = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "embedding" ? "text" : value)
    .filter(isModality);
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function isModality(value: string): value is Modality {
  return value === "text" || value === "audio" || value === "image" || value === "video" || value === "pdf";
}
