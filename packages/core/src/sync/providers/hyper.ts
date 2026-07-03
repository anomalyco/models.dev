import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";
import { resolveVeniceBaseModel } from "./venice.js";

const API_ENDPOINT = "https://hyper.charm.land/v1/models";
const PROVIDER_ENDPOINT = "https://hyper.charm.land/v1/provider";

const PricingValue = z.union([z.string(), z.number()]);

const Pricing = z.object({
  prompt: PricingValue.optional(),
  completion: PricingValue.optional(),
  input_cache_read: PricingValue.optional(),
  input_cache_reads: PricingValue.optional(),
  internal_reasoning: PricingValue.optional(),
}).passthrough();

const ReasoningEffort = z.enum([
  "default",
  "max",
  "low",
  "high",
  "none",
  "medium",
  "minimal",
  "xhigh",
]);

export const HyperModel = z.object({
  id: z.string(),
  created: z.number(),
  display_name: z.string(),
  supports_reasoning: z.boolean(),
  supports_reasoning_effort: z.boolean(),
  reasoning_effort_levels: z.array(z.string()).optional(),
  supports_attachments: z.boolean(),
  context_window: z.number(),
  max_output_tokens: z.number(),
  pricing: Pricing.optional(),
  cost_per_1m_in: z.number().optional(),
  cost_per_1m_out: z.number().optional(),
  cost_per_1m_in_cached: z.number().optional(),
  cost_per_1m_out_cached: z.number().optional(),
}).passthrough();

export const HyperResponse = z.object({
  data: z.array(HyperModel),
}).passthrough();

const HyperProviderModel = z.object({
  id: z.string(),
  cost_per_1m_in: z.number(),
  cost_per_1m_out: z.number(),
  cost_per_1m_in_cached: z.number().optional(),
  cost_per_1m_out_cached: z.number().optional(),
}).passthrough();

const HyperProviderResponse = z.object({
  models: z.array(HyperProviderModel),
}).passthrough();

export type HyperModel = z.infer<typeof HyperModel>;

const BASE_MODEL_ALIASES: Record<string, string> = {
  "llama-4-maverick-17b-128e-instruct-fp8": "meta/llama-4-maverick-17b-instruct",
  "minimax-m2.7": "minimax/MiniMax-M2.7",
  "qwen3-coder-480b-a35b-instruct-int4-mixed-ar": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3.6-max": "alibaba/qwen3.6-max-preview",
};

export const hyper = {
  id: "hyper",
  name: "Charm Hyper",
  modelsDir: "providers/hyper/models",
  preserveBaseModels: false,
  async fetchModels() {
    const headers = process.env.HYPER_API_KEY !== undefined
      ? { Authorization: `Bearer ${process.env.HYPER_API_KEY}` }
      : undefined;
    const [modelsResponse, providerResponse] = await Promise.all([
      fetch(API_ENDPOINT, { headers }),
      fetch(PROVIDER_ENDPOINT),
    ]);
    if (!modelsResponse.ok) {
      throw new Error(`Hyper models request failed: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }

    const modelsRaw = await modelsResponse.json();
    const parsed = HyperResponse.parse(modelsRaw);
    if (!providerResponse.ok) return modelsRaw;

    const pricingById = new Map(
      HyperProviderResponse.parse(await providerResponse.json()).models.map((model) => [model.id, model]),
    );

    return {
      ...modelsRaw,
      data: parsed.data.map((model) => enrichPricing(model, pricingById.get(model.id))),
    };
  },
  parseModels(raw) {
    return HyperResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model
      ?? BASE_MODEL_ALIASES[model.id]
      ?? resolveVeniceBaseModel(model.id, model.display_name)
      ?? undefined;
    return {
      id: model.id,
      model: buildHyperModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<HyperModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function reasoningOptions(model: HyperModel) {
  if (!model.supports_reasoning) return [];
  if (model.supports_reasoning_effort) {
    const values = model.reasoning_effort_levels?.filter(isReasoningEffort) ?? [];
    if (values.length > 0) return [{ type: "effort" as const, values }];
  }
  return [{ type: "toggle" as const }];
}

function isReasoningEffort(value: string): value is z.infer<typeof ReasoningEffort> {
  return ReasoningEffort.safeParse(value).success;
}

function hasApiPricing(model: HyperModel) {
  return (
    model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined
  ) || (
    model.cost_per_1m_in !== undefined && model.cost_per_1m_out !== undefined
  );
}

function enrichPricing(
  model: HyperModel,
  provider: z.infer<typeof HyperProviderModel> | undefined,
): HyperModel {
  if (hasApiPricing(model) || provider === undefined) return model;
  return {
    ...model,
    cost_per_1m_in: provider.cost_per_1m_in,
    cost_per_1m_out: provider.cost_per_1m_out,
    cost_per_1m_in_cached: provider.cost_per_1m_in_cached,
    cost_per_1m_out_cached: provider.cost_per_1m_out_cached,
  };
}

function parsePrice(value: string | number | undefined) {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function buildCost(model: HyperModel, existing: ExistingModel["cost"] | undefined) {
  const fromProviderFields = model.cost_per_1m_in !== undefined && model.cost_per_1m_out !== undefined
    ? {
        input: model.cost_per_1m_in,
        output: model.cost_per_1m_out,
        cache_read: model.cost_per_1m_in_cached,
        reasoning: undefined as number | undefined,
      }
    : undefined;

  const pricing = model.pricing;
  const fromPricingObject = pricing?.prompt !== undefined && pricing?.completion !== undefined
    ? {
        input: parsePrice(pricing.prompt),
        output: parsePrice(pricing.completion),
        cache_read: parsePrice(pricing.input_cache_read ?? pricing.input_cache_reads),
        reasoning: parsePrice(pricing.internal_reasoning),
      }
    : undefined;

  const resolved = fromProviderFields ?? fromPricingObject;
  if (resolved?.input === undefined || resolved.output === undefined) return existing;

  return {
    input: resolved.input,
    output: resolved.output,
    cache_read: resolved.cache_read !== undefined && resolved.cache_read > 0 ? resolved.cache_read : undefined,
    reasoning: resolved.reasoning !== undefined && resolved.reasoning > 0
      ? resolved.reasoning
      : existing?.reasoning,
  };
}

export function buildHyperModel(
  model: HyperModel,
  existing: ExistingModel | undefined,
  baseModel: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const limit = {
    context: model.context_window,
    input: existing?.limit?.input,
    output: model.max_output_tokens,
  };
  const values: Partial<SyncedFullModel> = {
    attachment: model.supports_attachments,
    reasoning: model.supports_reasoning,
    reasoning_options: reasoningOptions(model),
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? today,
    interleaved: existing?.interleaved,
    cost: buildCost(model, existing?.cost),
    limit,
  };

  if (baseModel === undefined) {
    throw new Error(`Hyper model ${model.id} has no matching base_model metadata`);
  }

  return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}
