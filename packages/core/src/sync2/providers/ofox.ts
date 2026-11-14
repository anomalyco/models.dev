// Ofox: https://api.ofox.ai/v2/models/catalog?include=provider_price (public).
// The catalog lists a curated subset, so this only updates existing chat
// files. Authoritative for token, cache and audio input prices, context bands
// and deprecation; everything else is hand-authored. A provider price marked
// as an override (a price cut or promo) is what users pay, so it wins over the
// list price. New models and dropped files are reported, not written.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.ofox.ai/v2/models/catalog?include=provider_price&limit=500";

const Price = z.union([z.string(), z.number()]);

const ContextPriceTier = z.object({
  threshold_tokens: z.number().int().positive(),
  input: Price.optional(),
  output: Price.optional(),
  cache_read: Price.optional(),
  cache_write: Price.optional(),
  cache_write_5m: Price.optional(),
}).passthrough();

const Pricing = z.object({
  input: z.string().optional(),
  output: z.string().optional(),
  audio: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_cache_write_5m: z.string().optional(),
  input_cache_write_1h: z.string().optional(),
  context_price_tiers: z.array(ContextPriceTier).optional(),
}).passthrough();
type Pricing = z.infer<typeof Pricing>;

const OfoxModel = z.object({
  id: z.string().min(1),
  mode: z.string(),
  pricing: Pricing.optional(),
  provider_price: z.object({ pricing: Pricing.optional(), is_override: z.boolean().optional() }).passthrough().nullable().optional(),
  is_deprecated: z.boolean().optional(),
}).passthrough();
type OfoxModel = z.infer<typeof OfoxModel>;

const OfoxResponse = z.object({ data: z.array(OfoxModel) }).passthrough();

export const ofox: SyncModule<unknown> = {
  id: "ofox",
  name: "Ofox",
  policy: {
    owns: [
      { path: "status", merge: "deprecated" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands" },
      "cost.audio.input.price",
    ],
    creates: "gap",
    removals: "keep",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Ofox models" }),
  observe: (raw) => OfoxResponse.parse(raw).data.filter((model) => model.mode === "chat").map(observe),
};

function observe(model: OfoxModel): Observation {
  const pricing = model.provider_price?.is_override === true && model.provider_price.pricing !== undefined
    ? model.provider_price.pricing
    : model.pricing;
  const input = price(pricing?.input);
  const output = price(pricing?.output);
  return {
    id: model.id,
    ...(model.is_deprecated === true ? { status: "deprecated" as const } : {}),
    ...(input === undefined && output === undefined ? {} : { cost: cost(pricing!, input ?? 0, output ?? 0) }),
  };
}

// Prompts over `threshold_tokens` bill every token at the band's prices.
function cost(pricing: Pricing, input: number, output: number) {
  const bands = [...pricing.context_price_tiers ?? []].sort((a, b) => a.threshold_tokens - b.threshold_tokens);
  const when = (band: (typeof bands)[number]) => ({ context: { gt: band.threshold_tokens } });
  const cache = (read: number | undefined, write: number | undefined) =>
    read === undefined && write === undefined ? {} : { cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) } };
  const audio = price(pricing.audio);
  return {
    text: {
      input: {
        price: input,
        cache: { read: price(pricing.input_cache_read) ?? null, write: write(pricing) ?? null },
        overrides: bands.length === 0 ? null : bands.map((band) => ({
          when: when(band),
          price: price(band.input) ?? 0,
          ...cache(price(band.cache_read), price(band.cache_write) ?? price(band.cache_write_5m)),
        })),
      },
      output: {
        price: output,
        overrides: bands.length === 0 ? null : bands.map((band) => ({ when: when(band), price: price(band.output) ?? 0 })),
      },
    },
    audio: { input: { price: audio ?? null } },
  };
}

// The cache write price, or the 5m and 1h prices when the catalog lists both.
function write(pricing: Pricing) {
  const fiveMinutes = price(pricing.input_cache_write_5m);
  const hour = price(pricing.input_cache_write_1h);
  if (price(pricing.input_cache_write) === undefined && fiveMinutes !== undefined && hour !== undefined) return { "5m": fiveMinutes, "1h": hour };
  return price(pricing.input_cache_write) ?? fiveMinutes;
}

// USD per token (a decimal string, or a number in bands) as USD per 1M. The
// catalog leaves out zero prices, so zero is no price.
function price(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number * 1_000_000_000_000) / 1_000_000;
}
