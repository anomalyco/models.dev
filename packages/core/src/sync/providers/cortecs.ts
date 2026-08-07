import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.cortecs.ai/v1/models";
const CANONICAL_BASE_MODEL_EXCEPTIONS = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4-0",
} as const;
// Cortecs publishes its default catalog prices in EUR per million tokens.
// Exchange rate used by the existing Cortecs entries, as of 2026-07-30.
const EUR_TO_USD = 1.114;

const CortecsModality = z.enum(["text", "audio", "image", "video", "pdf"]);

export const CortecsModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  description: z.string().optional(),
  pricing: z.object({
    currency: z.literal("EUR"),
    input_token: z.number().nonnegative(),
    output_token: z.number().nonnegative(),
    cache_read_cost: z.number().nonnegative().optional(),
    cache_write_cost: z.number().nonnegative().optional(),
  }).passthrough(),
  context_size: z.number().int().positive(),
  input_modalities: z.array(CortecsModality).default(["text"]),
  output_modalities: z.array(CortecsModality).default(["text"]),
  supported_features: z.array(z.string()).default([]),
}).passthrough();

export const CortecsResponse = z.object({
  object: z.literal("list"),
  data: z.array(CortecsModel),
}).passthrough();

export type CortecsModel = z.infer<typeof CortecsModel>;

export const cortecs = {
  id: "cortecs",
  name: "Cortecs",
  modelsDir: "providers/cortecs/models",
  deleteMissing: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Cortecs models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return CortecsResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildCortecsModel(model, context.existing(model.id), context.authored(model.id)),
    };
  },
} satisfies SyncProvider<CortecsModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function usd(value: number | undefined) {
  if (value === undefined) return undefined;
  return Math.round(value * EUR_TO_USD * 1_000) / 1_000;
}

export function buildCortecsModel(
  model: CortecsModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
): SyncedModel {
  const features = new Set(model.supported_features);
  const input = model.input_modalities;
  const output = model.output_modalities;
  const canonical = existing?.base_model ?? resolveCortecsBaseModel(model.id);
  const sourceReasoning = features.has("reasoning");
  const reasoning = canonical === undefined ? sourceReasoning : existing?.reasoning ?? sourceReasoning;
  const reasoningOptions = canonical === undefined
    ? (sourceReasoning ? existing?.reasoning_options ?? [] : undefined)
    : (existing?.reasoning === true ? existing.reasoning_options : undefined);
  const limit = {
    context: model.context_size,
    input: existing?.limit?.input,
    output: authored?.limit?.output ?? model.context_size,
  };
  const cost = {
    input: usd(model.pricing.input_token),
    output: usd(model.pricing.output_token),
    cache_read: usd(model.pricing.cache_read_cost) ?? existing?.cost?.cache_read,
    cache_write: usd(model.pricing.cache_write_cost) ?? existing?.cost?.cache_write,
    reasoning: existing?.cost?.reasoning,
    tiers: existing?.cost?.tiers,
  };
  if (canonical !== undefined) {
    return factorBaseModel(canonical, {
      description: existing?.description,
      attachment: input.some((value) => value !== "text"),
      reasoning: undefined,
      reasoning_options: reasoningOptions,
      temperature: existing?.temperature,
      tool_call: features.has("tools"),
      structured_output: features.has("json_mode"),
      status: existing?.status,
      interleaved: existing?.interleaved,
      limit,
      modalities: { input, output },
      cost,
    }, limit, existing?.base_model_omit);
  }

  const family = existing?.family;
  return {
    name: existing?.name ?? model.id,
    description: existing?.description ?? model.description ?? describeModel({
      id: model.id,
      name: model.id,
      family,
      reasoning,
      tool_call: features.has("tools"),
      structured_output: features.has("json_mode"),
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? false,
    tool_call: features.has("tools"),
    structured_output: features.has("json_mode"),
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function resolveCortecsBaseModel(modelID: string) {
  const exception = CANONICAL_BASE_MODEL_EXCEPTIONS[
    modelID as keyof typeof CANONICAL_BASE_MODEL_EXCEPTIONS
  ];
  if (exception !== undefined) return resolveModelMetadataBaseModel(exception);

  const trailingFamily = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/.exec(modelID);
  if (trailingFamily !== null) {
    const [, major, minor, family] = trailingFamily;
    return resolveModelMetadataBaseModel(`anthropic/claude-${family}-${major}-${minor}`);
  }

  const compactFamily = /^claude-(opus|sonnet|haiku)(\d+)-(\d+)$/.exec(modelID);
  if (compactFamily !== null) {
    const [, family, major, minor] = compactFamily;
    return resolveModelMetadataBaseModel(`anthropic/claude-${family}-${major}-${minor}`);
  }

  return resolveModelMetadataBaseModel(modelID);
}
