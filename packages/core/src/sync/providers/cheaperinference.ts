import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.cheaperinference.com/v1/models";

/** Long-context band. The gateway bills prompts above the threshold at these rates. */
const AboveThreshold = z
  .object({
    input_token_price_threshold: z.number().int().positive(),
    input_per_million: z.string().min(1),
    output_per_million: z.string().min(1),
    cache_read_input_per_million: z.string().min(1).nullish(),
    cache_write_input_per_million: z.string().min(1).nullish(),
  })
  .passthrough();

const CheaperInferencePricing = z
  .object({
    currency: z.literal("USD"),
    input_per_million: z.string().min(1),
    output_per_million: z.string().min(1),
    cache_read_input_per_million: z.string().min(1).nullish(),
    cache_write_input_per_million: z.string().min(1).nullish(),
    input_token_price_threshold: z.number().int().positive().nullish(),
    above_threshold: AboveThreshold.nullish(),
  })
  .passthrough();

export const CheaperInferenceModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    type: z.string().min(1),
    endpoint: z.string().min(1),
    context_length: z.number().int().positive().nullish(),
    max_output_tokens: z.number().int().positive().nullish(),
    is_free: z.boolean(),
    pricing: CheaperInferencePricing,
  })
  .passthrough();

export const CheaperInferenceResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(CheaperInferenceModel),
    pricing_version: z.string().min(1),
    pricing_checked_at: z.string().min(1),
  })
  .passthrough();

export type CheaperInferenceModel = z.infer<typeof CheaperInferenceModel>;

export const cheaperinference = {
  id: "cheaperinference",
  name: "CheaperInference",
  modelsDir: "providers/cheaperinference/models",
  // The catalog carries pricing and limits but no reasoning controls, so new
  // models need hand-authored reasoning_options before they can be created.
  skipCreates: true,
  sourceID(model) {
    return isTokenPricedTextModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} CheaperInference models were not created because the catalog exposes no reasoning controls, which this repo requires for reasoning models.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchCheaperInferenceModels();
  },
  parseModels(raw) {
    return CheaperInferenceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildCheaperInferenceModel(model, existing),
    };
  },
} satisfies SyncProvider<CheaperInferenceModel>;

export async function fetchCheaperInferenceModels(fetcher: typeof fetch = fetch) {
  const apiKey = process.env["CHEAPERINFERENCE_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("CHEAPERINFERENCE_API_KEY is required to read the CheaperInference catalog");
  }
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `CheaperInference models request failed: ${response.status} ${response.statusText}`,
    );
  }
  return CheaperInferenceResponse.parse(await response.json());
}

/**
 * Only text models billed per token can be expressed by the catalog schema.
 * Image and video routes price per unit of generated media, and free routes
 * carry no rates worth syncing.
 */
function isTokenPricedTextModel(model: CheaperInferenceModel) {
  return (
    model.type === "text" &&
    model.endpoint === "/v1/chat/completions" &&
    !model.is_free &&
    price(model.pricing.input_per_million) > 0 &&
    price(model.pricing.output_per_million) > 0
  );
}

function price(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`CheaperInference returned an unusable price: ${value}`);
  }
  return parsed;
}

function optionalPrice(value: string | null | undefined) {
  return value === null || value === undefined ? undefined : price(value);
}

export function buildCheaperInferenceModel(
  model: CheaperInferenceModel,
  existing: ExistingModel,
): SyncedModel {
  if (existing.reasoning !== false && existing.reasoning_options === undefined) {
    throw new Error(
      `CheaperInference model ${model.id} requires hand-authored reasoning_options; the catalog exposes no reasoning controls`,
    );
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const pricing = model.pricing;

  const cost = {
    ...existing.cost,
    input: price(pricing.input_per_million),
    output: price(pricing.output_per_million),
    cache_read: optionalPrice(pricing.cache_read_input_per_million),
    cache_write: optionalPrice(pricing.cache_write_input_per_million),
    tiers: buildTiers(pricing.above_threshold),
  };

  // The gateway is authoritative for what it serves, so its limits win when it
  // publishes them. Missing values stay inherited from the lab entry.
  const limit = {
    ...existing.limit,
    ...(model.context_length === null || model.context_length === undefined
      ? {}
      : { context: model.context_length }),
    ...(model.max_output_tokens === null || model.max_output_tokens === undefined
      ? {}
      : { output: model.max_output_tokens }),
  };

  const values = {
    ...current,
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

function buildTiers(above: z.infer<typeof AboveThreshold> | null | undefined) {
  if (above === null || above === undefined) return undefined;
  // The threshold is the last token billed at the base rate, so the band starts
  // one token later. The gateway reports both 271_999 and 272_000 for the same
  // 272k boundary, which normalises to one tier size.
  const size = above.input_token_price_threshold + 1;
  return [
    {
      tier: { type: "context" as const, size: size - (size % 1000) },
      input: price(above.input_per_million),
      output: price(above.output_per_million),
      cache_read: optionalPrice(above.cache_read_input_per_million),
      cache_write: optionalPrice(above.cache_write_input_per_million),
    },
  ];
}
