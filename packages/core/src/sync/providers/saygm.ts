import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.saygm.com/v1/models";
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

// `pricing.basis` is one of two things: the cheapest currently routable
// miner offer, or (when nothing is routable) gm's published retail cap as a
// fallback. Both are valid API responses, so both must parse — but only the
// first is a price to publish; see `buildSaygmModel`. Anything outside these
// two literals is a schema change models.dev has not reviewed and must fail
// the sync loudly rather than silently publish an unknown basis.
const Pricing = z.object({
  basis: z.enum(["cheapest_eligible_offer", "published_retail"]),
  dimensions: PriceDimensions,
}).passthrough();

export const SaygmModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  available: z.boolean(),
  api_shapes: z.array(z.string().min(1)),
  pricing: Pricing.optional(),
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
  // SayGM's discount over each lab's own price is the whole reason to route
  // through it, so this catalog publishes the current cheapest eligible
  // miner offer rather than gm's published retail cap. That number moves
  // with live miner supply and can be a cent or two stale between hourly
  // syncs — accepted, because a number that is usually right beats a stable
  // one that is permanently uncompetitive. The live inventory can also change
  // with miner supply for other reasons (a model can stop being served
  // entirely), so this sync only ever updates models that were reviewed into
  // the catalog and retains them through temporary outages.
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
  const pricing = model.pricing;
  if (pricing === undefined || pricing.basis !== "cheapest_eligible_offer") {
    // No live miner offer right now: either the field is absent from a
    // partial response, or the API itself fell back to publishing the
    // retail cap because nothing is currently routable. Neither is a
    // cheapest-eligible price, so this must not adopt the retail number
    // under a stale "current price" label, write a zero, or block the
    // hourly update — keep the last reviewed price instead.
    return existing as SyncedModel;
  }

  const dimensions = pricing.dimensions;
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
