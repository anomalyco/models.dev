import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.gradiated.com/api/v1/models";

const TokenMeasure = z.object({ value: z.number().int().positive(), unit: z.literal("token") });
const Pricing = z.array(z.object({
  type: z.enum(["prompt", "cached_prompt", "cache_write", "completion", "internal_reasoning"]),
  unit: z.literal("token"),
  cost: z.number().int().nonnegative(),
})).refine((prices) => new Set(prices.map((price) => price.type)).size === prices.length,
  "Duplicate token pricing types");

export const GradiatedModel = z.object({
  id: z.string().min(1),
  status: z.enum(["available", "unavailable"]),
  properties: z.object({
    schema_version: z.literal(1),
    type: z.enum(["chat", "decision"]).optional(),
    input_modalities: z.array(z.object({
      type: z.literal("text"),
      supported_inputs: z.object({
        max_context_length: TokenMeasure,
        max_prompt_length: TokenMeasure,
      }),
      pricing: Pricing,
    })).length(1),
    output_modalities: z.array(z.object({
      type: z.literal("text"),
      max_length: TokenMeasure,
      supported_parameters: z.record(z.unknown()),
      pricing: Pricing,
    })).length(1),
    pricing_overrides: z.array(z.object({
      min_prompt_tokens: z.number().int().nonnegative(),
      input_pricing: Pricing,
      output_pricing: Pricing,
    })).optional(),
  }),
});

export const GradiatedResponse = z.object({
  data: z.array(GradiatedModel),
  next_cursor: z.null(),
});

export type GradiatedModel = z.infer<typeof GradiatedModel>;

function isChat(model: GradiatedModel) {
  if (model.status !== "available") return false;
  if (model.properties.type !== undefined) return model.properties.type === "chat";
  // Older catalogs predate the type field; only known lab models can be classified.
  const canonical = resolveModelMetadataBaseModel(model.id);
  return canonical !== undefined && (modelMetadata(canonical).type ?? "chat") === "chat";
}

export async function fetchGradiatedModels(
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Gradiated models request failed: ${response.status} ${response.statusText}`);
  }
  const catalog = GradiatedResponse.parse(await response.json());
  if (!catalog.data.some(isChat)) throw new Error("Gradiated returned no available chat models");
  return catalog;
}

export const gradiated = {
  id: "gradiated",
  name: "Gradiated",
  modelsDir: "providers/gradiated/models",
  fetchModels: fetchGradiatedModels,
  parseModels(raw) {
    return GradiatedResponse.parse(raw).data;
  },
  sourceID(model) {
    return isChat(model) ? model.id : undefined;
  },
  missingModelID(model) {
    return isChat(model) ? model.id : undefined;
  },
  translateModel(model, context) {
    if (!isChat(model)) return undefined;
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveModelMetadataBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    const base = modelMetadata(baseModel);
    if (base.type !== undefined && base.type !== "chat") return undefined;
    const reasoning = existing?.reasoning ?? base.reasoning;
    if (reasoning === true && existing?.reasoning_options === undefined
      && effortOptions(model.properties.output_modalities[0]!.supported_parameters) === undefined) {
      throw new MissingReasoningOptionsError(model.id,
        "Gradiated catalog does not enumerate reasoning controls; author this route's reasoning_options");
    }
    return { id: model.id, model: buildGradiatedModel(model, baseModel, context.authored(model.id)) };
  },
} satisfies SyncProvider<GradiatedModel>;

function effortOptions(parameters: Record<string, unknown>) {
  const descriptor = z.object({ type: z.literal("enum"), values: z.array(z.string()).nonempty() })
    .safeParse(parameters.reasoning_effort);
  if (!descriptor.success) return undefined;
  const option = ReasoningOption.safeParse({ type: "effort", values: descriptor.data.values });
  return option.success ? [option.data] : undefined;
}

function price(prices: z.infer<typeof Pricing>, type: string, required = false) {
  const entry = prices.find((price) => price.type === type);
  if (required && entry === undefined) throw new Error(`Gradiated is missing ${type} pricing`);
  // The API uses nano-USD/token; models.dev uses USD/million tokens.
  return entry === undefined ? undefined : entry.cost / 1_000;
}

export function buildGradiatedModel(model: GradiatedModel, baseModel: string, authored?: ExistingModel) {
  const input = model.properties.input_modalities[0]!;
  const output = model.properties.output_modalities[0]!;
  const parameters = output.supported_parameters;
  const reasoning = authored?.reasoning ?? modelMetadata(baseModel).reasoning;
  const limit = {
    context: input.supported_inputs.max_context_length.value,
    input: input.supported_inputs.max_prompt_length.value,
    output: output.max_length.value,
  };
  const cost = {
    input: price(input.pricing, "prompt", true)!,
    output: price(output.pricing, "completion", true)!,
    cache_read: price(input.pricing, "cached_prompt"),
    cache_write: price(input.pricing, "cache_write"),
    reasoning: price(output.pricing, "internal_reasoning"),
  };
  const tiers = model.properties.pricing_overrides?.map((tier) => ({
    tier: { type: "context" as const, size: tier.min_prompt_tokens },
    input: price(tier.input_pricing, "prompt") ?? cost.input,
    output: price(tier.output_pricing, "completion") ?? cost.output,
    cache_read: price(tier.input_pricing, "cached_prompt") ?? cost.cache_read,
    cache_write: price(tier.input_pricing, "cache_write") ?? cost.cache_write,
    reasoning: price(tier.output_pricing, "internal_reasoning") ?? cost.reasoning,
  }));

  return factorBaseModel(baseModel, {
    ...authored,
    reasoning_options: reasoning === true ? effortOptions(parameters) ?? authored?.reasoning_options : undefined,
    cost: { ...cost, tiers },
    limit,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    temperature: "temperature" in parameters,
    tool_call: "tools" in parameters,
    structured_output: "response_format" in parameters,
  }, limit, authored?.base_model_omit);
}
