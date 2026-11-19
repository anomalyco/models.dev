import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://aki.io/api/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

// AKI.IO publishes its catalog prices in EUR per million tokens. The catalog is
// USD, so convert at the ECB reference rate used by the hand-authored entries
// (1.0989 USD/EUR, 2026-11-17). Update this constant when the rate is refreshed.
const EUR_TO_USD = 1.0989;

const AkiPricing = z
  .object({
    in_token_unit: z.coerce.number().positive().optional(),
    in_token_price: z.coerce.number().nonnegative().optional(),
    out_token_unit: z.coerce.number().positive().optional(),
    out_token_price: z.coerce.number().nonnegative().optional(),
    cached_token_unit: z.coerce.number().positive().optional(),
    cached_token_price: z.coerce.number().nonnegative().optional(),
  })
  .passthrough();

export const AkiModel = z
  .object({
    id: z.string().min(1),
    openai: z
      .object({ id: z.string().min(1) })
      .passthrough(),
    pricing: AkiPricing,
  })
  .passthrough();

export const AkiResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(AkiModel),
  })
  .passthrough();

export type AkiModel = z.infer<typeof AkiModel>;

/**
 * AKI.IO's public `/api/models` lists every catalog entry, including the
 * trust-level variants the provider TOMLs are named after. Only existing TOMLs
 * are updated (`skipCreates`) and no missing-model issues are opened
 * (`trackMissingModels: false`), because a new entry would need hand-authored
 * reasoning controls and lab metadata. The list is scoped to the public catalog
 * and can omit retired routes, so local files missing from a response are
 * retained (`deleteMissing: false`).
 */
export const akiIo = {
  id: "aki-io",
  name: "AKI.IO",
  modelsDir: "providers/aki-io/models",
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  async fetchModels() {
    return fetchAkiModels();
  },
  parseModels(raw) {
    return AkiResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.openai.id);
    if (authored === undefined) return undefined;
    return {
      id: model.openai.id,
      model: buildAkiModel(model, authored),
    };
  },
} satisfies SyncProvider<AkiModel>;

export async function fetchAkiModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`AKI.IO models request failed: ${response.status} ${response.statusText}`);
  }
  return AkiResponse.parse(await response.json());
}

// Prices are EUR per `*_token_unit` tokens (1M today), scaled to USD per 1M.
// Round because the conversion carries float artifacts such as 0.08241749999999999.
function usd(price: number, unit: number | undefined): number {
  return Number((price * (TOKENS_PER_PRICING_UNIT / (unit ?? TOKENS_PER_PRICING_UNIT)) * EUR_TO_USD).toFixed(7));
}

export function buildAkiModel(model: AkiModel, authored: ExistingModel): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  const prompt = model.pricing.in_token_price;
  const completion = model.pricing.out_token_price;
  if (prompt === undefined || completion === undefined) {
    throw new Error(`AKI.IO model ${model.openai.id} has no input/output token prices`);
  }

  // The endpoint reports 0 for routes that do not cache, which is not a free
  // cache read, so only a positive reported price replaces the authored value.
  const cacheRead = authored.cost?.cache_read;
  const apiCacheRead = model.pricing.cached_token_price;
  const cache_read = apiCacheRead === undefined || apiCacheRead === 0
    ? cacheRead
    : usd(apiCacheRead, model.pricing.cached_token_unit);

  return {
    ...preserved,
    cost: {
      ...authored.cost,
      input: usd(prompt, model.pricing.in_token_unit),
      output: usd(completion, model.pricing.out_token_unit),
      cache_read,
    },
  } as SyncedModel;
}