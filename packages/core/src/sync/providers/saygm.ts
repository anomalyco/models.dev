import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = process.env.SAYGM_MODELS_URL ?? "https://api.saygm.com/v1/models";
const NDOLLARS_PER_DOLLAR = 1_000_000_000;

const NanoDollars = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const PriceDimensions = z.object({
  input_per_mtok_ndollars: NanoDollars,
  output_per_mtok_ndollars: NanoDollars,
  cache_read_per_mtok_ndollars: NanoDollars.optional(),
  cache_write_5m_per_mtok_ndollars: NanoDollars.optional(),
  cache_write_1h_per_mtok_ndollars: NanoDollars.optional(),
  audio_input_per_mtok_ndollars: NanoDollars.optional(),
  audio_output_per_mtok_ndollars: NanoDollars.optional(),
  long_context_threshold_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  long_context_input_per_mtok_ndollars: NanoDollars.optional(),
  long_context_output_per_mtok_ndollars: NanoDollars.optional(),
}).passthrough().superRefine((dimensions, context) => {
  const longContext = [
    dimensions.long_context_threshold_tokens,
    dimensions.long_context_input_per_mtok_ndollars,
    dimensions.long_context_output_per_mtok_ndollars,
  ];
  const present = longContext.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== longContext.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Long-context pricing requires a threshold plus input and output prices",
    });
  }
});

// `pricing` remains SayGM's optimistic headline (or retail fallback). The sync
// validates it because an unknown basis is still a contract change, but
// `buildSaygmModel` deliberately reads the conservative bound from
// `price_range` instead.
const Pricing = z.object({
  basis: z.enum(["cheapest_eligible_offer", "published_retail"]),
  dimensions: PriceDimensions,
}).passthrough();

const PriceRange = z.object({
  floor: z.object({
    basis: z.literal("cheapest_eligible_offer"),
    dimensions: PriceDimensions,
  }).passthrough().optional(),
  route_ceiling: z.object({
    basis: z.literal("highest_eligible_offer"),
    dimensions: PriceDimensions,
  }).passthrough().optional(),
  ceiling: z.object({
    basis: z.literal("published_retail"),
    dimensions: PriceDimensions,
  }).passthrough(),
}).passthrough();

export const SaygmModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  available: z.boolean(),
  api_shapes: z.array(z.string().min(1)),
  pricing: Pricing.optional(),
  price_range: PriceRange.optional(),
}).passthrough();

export const SaygmResponse = z.object({
  object: z.literal("list"),
  data: z.array(SaygmModel),
}).passthrough();

export type SaygmModel = z.infer<typeof SaygmModel>;

export const saygm = {
  id: "saygm",
  name: "SayGM",
  modelsDir: "providers/saygm/models",
  // SayGM can route one request to any currently eligible miner, so the
  // cheapest offer is not a conservative catalog price. Publish the highest
  // eligible offer from the same live routing snapshot instead: individual
  // requests may settle lower, while retail remains the compatibility fallback
  // for gateways that do not yet expose the live route ceiling. The live
  // inventory can also change with miner supply, so this sync only updates
  // reviewed models and retains them through temporary outages.
  skipCreates: true,
  deleteMissing: false,
  trackMissingModels: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} SayGM models were not created because this sync is update-only until the public API exposes durable miner depth.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} reviewed SayGM models were retained despite being absent from the current live response.`,
      `Retained local models: ${paths.map((item) => `\`${item.replace(/\.toml$/, "")}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchSaygmModels();
  },
  parseModels(raw) {
    return SaygmResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (context.existing(model.id) === undefined) return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) {
      throw new Error(`SayGM model ${model.id} has no authored catalog entry`);
    }
    return {
      id: model.id,
      model: buildSaygmModel(model, authored),
    };
  },
} satisfies SyncProvider<SaygmModel>;

export async function fetchSaygmModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`SayGM models request failed: ${response.status} ${response.statusText}`);
  }
  return SaygmResponse.parse(await response.json());
}

export function buildSaygmModel(model: SaygmModel, existing: ExistingModel): SyncedModel {
  const priceRange = model.price_range;
  if (priceRange === undefined) {
    // A partial or older response with no explicit bounds must not erase the
    // last reviewed price or infer one from the optimistic headline `pricing`.
    return existing as SyncedModel;
  }

  // Prefer the conservative maximum among the routes that were eligible in
  // SayGM's discovery snapshot. When no live route ceiling is available, use
  // the explicit published-retail ceiling; never fall back to the cheapest
  // headline offer, which can understate the route actually selected.
  const dimensions = priceRange.route_ceiling?.dimensions ?? priceRange.ceiling.dimensions;
  // The API has no explicit "no such price" signal, so an omitted optional
  // dimension keeps the authored value (same as the xAI sync) rather than
  // clearing a reviewed one.
  const cost: NonNullable<ExistingModel["cost"]> = {
    ...existing.cost,
    input: usdPerMtok(dimensions.input_per_mtok_ndollars),
    output: usdPerMtok(dimensions.output_per_mtok_ndollars),
    cache_read: optionalUsdPerMtok(dimensions.cache_read_per_mtok_ndollars) ?? existing.cost?.cache_read,
    // models.dev has one cache-write field; its provider catalogs conventionally
    // use Anthropic's standard five-minute write rate.
    cache_write:
      optionalUsdPerMtok(dimensions.cache_write_5m_per_mtok_ndollars) ?? existing.cost?.cache_write,
    input_audio: optionalUsdPerMtok(dimensions.audio_input_per_mtok_ndollars) ?? existing.cost?.input_audio,
    output_audio:
      optionalUsdPerMtok(dimensions.audio_output_per_mtok_ndollars) ?? existing.cost?.output_audio,
  };

  if (dimensions.long_context_threshold_tokens !== undefined) {
    const longInput = dimensions.long_context_input_per_mtok_ndollars;
    const longOutput = dimensions.long_context_output_per_mtok_ndollars;
    if (longInput === undefined || longOutput === undefined) {
      throw new Error(`SayGM model ${model.id} has incomplete long-context pricing`);
    }
    cost.tiers = [{
      tier: { type: "context", size: dimensions.long_context_threshold_tokens },
      input: usdPerMtok(longInput),
      output: usdPerMtok(longOutput),
    }];
  }

  return { ...existing, cost } as SyncedModel;
}

export function usdPerMtok(ndollars: number) {
  return ndollars / NDOLLARS_PER_DOLLAR;
}

function optionalUsdPerMtok(ndollars: number | undefined) {
  return ndollars === undefined ? undefined : usdPerMtok(ndollars);
}
