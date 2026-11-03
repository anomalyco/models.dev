import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.ofox.ai/v2/models/catalog?include=provider_price&limit=500";

const Price = z.union([z.string(), z.number()]);

const ContextPriceTier = z
  .object({
    threshold_tokens: z.number().int().positive(),
    input: Price.optional(),
    output: Price.optional(),
    cache_read: Price.optional(),
    cache_write: Price.optional(),
    cache_write_5m: Price.optional(),
  })
  .passthrough();

const Pricing = z
  .object({
    input: z.string().optional(),
    output: z.string().optional(),
    audio: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    input_cache_write_5m: z.string().optional(),
    input_cache_write_1h: z.string().optional(),
    context_price_tiers: z.array(ContextPriceTier).optional(),
  })
  .passthrough();

const ProviderPrice = z
  .object({
    pricing: Pricing.optional(),
    is_override: z.boolean().optional(),
  })
  .passthrough();

export const OfoxModel = z
  .object({
    id: z.string().min(1),
    display_name: z.string().optional(),
    mode: z.string(),
    context_window: z.number().optional(),
    max_output_tokens: z.number().optional(),
    pricing: Pricing.optional(),
    provider_price: ProviderPrice.nullable().optional(),
    is_deprecated: z.boolean().optional(),
  })
  .passthrough();

export const OfoxResponse = z
  .object({
    data: z.array(OfoxModel),
  })
  .passthrough();

export type OfoxModel = z.infer<typeof OfoxModel>;

/**
 * Ofox lists a curated subset of its catalog here, so this sync only updates
 * existing TOMLs (`skipCreates`) and treats the Ofox catalog API as
 * authoritative for pricing and deprecation status only. Everything else in
 * the authored TOMLs — `base_model` inheritance, `reasoning_options`, and the
 * per-model `[provider]` protocol overrides — is preserved as hand-authored.
 */
export const ofox = {
  id: "ofox",
  name: "Ofox",
  modelsDir: "providers/ofox/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    return model.mode === "chat" ? model.id : undefined;
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `Ofox catalog no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Ofox request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OfoxResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (model.mode !== "chat") return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildOfoxModel(model, authored),
    };
  },
} satisfies SyncProvider<OfoxModel>;

/** Ofox prices are $/token (decimal strings, or numbers in tiers); catalog omits zero-value fields. */
function price(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number * 1_000_000_000_000) / 1_000_000;
}

export function buildOfoxModel(model: OfoxModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  // Effective customer price: when ops set a provider_price override (price
  // cuts / promos), that is what users are billed; the base `pricing` keeps
  // the pre-discount list price.
  const pricing =
    model.provider_price?.is_override === true && model.provider_price.pricing !== undefined
      ? model.provider_price.pricing
      : model.pricing;
  const input = price(pricing?.input);
  const output = price(pricing?.output);
  const cacheRead = price(pricing?.input_cache_read);
  const cacheWrite = price(pricing?.input_cache_write) ?? price(pricing?.input_cache_write_5m);
  // Prompts over `threshold_tokens` bill every token at the tier's prices.
  const tiers = pricing?.context_price_tiers?.map((tier) => ({
    tier: { type: "context" as const, size: tier.threshold_tokens },
    input: price(tier.input) ?? 0,
    output: price(tier.output) ?? 0,
    cache_read: price(tier.cache_read),
    cache_write: price(tier.cache_write) ?? price(tier.cache_write_5m),
  }));
  const cost =
    input !== undefined || output !== undefined
      ? {
          ...authored.cost,
          input: input ?? 0,
          output: output ?? 0,
          cache_read: cacheRead,
          cache_write: cacheWrite,
          input_audio: price(pricing?.audio),
          tiers: tiers?.length ? tiers : undefined,
        }
      : authored.cost;

  const status = model.is_deprecated === true ? ("deprecated" as const) : authored.status;

  return {
    ...preserved,
    cost,
    status,
  } as SyncedModel;
}
