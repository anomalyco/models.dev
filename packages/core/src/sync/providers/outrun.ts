import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const PRICING_ENDPOINT = "https://api.outrun.to/pricing";

// Only token-priced text models map onto catalog token rates; image, video and
// audio rows are priced per image, second, request or character.
const TEXT_UNIT = "1M tokens";

const Price = z.number().nonnegative();

export const OutrunPricingTier = z.object({
  prices: z.object({
    input: Price.optional(),
    output: Price.optional(),
    cache_read: Price.optional(),
    cache_write: Price.optional(),
    cache_write_1h: Price.optional(),
  }).passthrough(),
  max_context_tokens: z.number().int().positive().optional(),
  min_context_tokens: z.number().int().positive().optional(),
}).passthrough();

export type OutrunPricingTier = z.infer<typeof OutrunPricingTier>;

export const OutrunPricingModel = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  unit: z.string().optional(),
  tiers: z.array(OutrunPricingTier).min(1),
}).passthrough();

export type OutrunPricingModel = z.infer<typeof OutrunPricingModel>;

export const OutrunPricing = z.object({
  currency: z.literal("USD"),
  models: z.array(OutrunPricingModel),
}).passthrough();

export function parseOutrunPricing(raw: unknown): OutrunPricingModel[] {
  return OutrunPricing.parse(raw).models.filter((model) => model.kind === "text" && model.unit === TEXT_UNIT);
}

// The base tier has no lower bound; each higher tier starts at
// `min_context_tokens`, which the feed states as the first token above the
// previous band (e.g. 200,001), so the catalog threshold is `context > min - 1`.
function splitTiers(model: OutrunPricingModel) {
  const base = model.tiers.filter((tier) => tier.min_context_tokens === undefined);
  if (base.length !== 1) {
    throw new Error(`Expected exactly one base pricing tier for ${model.id}, found ${base.length}`);
  }
  const higher = model.tiers
    .filter((tier) => tier.min_context_tokens !== undefined)
    .map((tier) => ({ size: tier.min_context_tokens! - 1, tier }))
    .sort((a, b) => a.size - b.size);
  return { base: base[0]!, higher };
}

function tierCost(model: OutrunPricingModel, tier: OutrunPricingTier) {
  const { input, output, cache_read, cache_write } = tier.prices;
  if (input === undefined || output === undefined) {
    throw new Error(`Outrun pricing tier for ${model.id} is missing an input or output price`);
  }
  return { input, output, cache_read, cache_write };
}

export function buildOutrunCost(model: OutrunPricingModel) {
  const { base, higher } = splitTiers(model);
  const tiers = higher.map(({ size, tier }) => ({
    tier: { type: "context" as const, size },
    ...tierCost(model, tier),
  }));
  return { ...tierCost(model, base), tiers: tiers.length > 0 ? tiers : undefined };
}

// v1 `cache_write` carries one price (the 5-minute write). When the feed also
// publishes a 1-hour write price, set both TTLs on files that already declare a
// per-TTL write record, instead of scaling the 1h price by the 5m change.
function ttlWrite(tier: OutrunPricingTier, current: unknown) {
  const { cache_write, cache_write_1h } = tier.prices;
  if (cache_write === undefined || cache_write_1h === undefined) return current;
  if (current === null || typeof current !== "object") return current;
  return { ...(current as Record<string, number>), "5m": cache_write, "1h": cache_write_1h };
}

export function outrunV2Set(model: OutrunPricingModel): Record<string, unknown> | undefined {
  const { base, higher } = splitTiers(model);
  const hasTtlPrices = model.tiers.some((tier) => tier.prices.cache_write_1h !== undefined);
  if (!hasTtlPrices) return undefined;
  return {
    "cost.text.input.cache.write": (current: unknown) => ttlWrite(base, current),
    "cost.text.input.overrides": (current: unknown) => {
      if (!Array.isArray(current)) return current;
      return current.map((override: any) => {
        const size = override?.when?.context?.gt ?? override?.when?.context?.gte;
        const match = higher.find((item) => item.size === size);
        if (match === undefined || override.cache === undefined) return override;
        return { ...override, cache: { ...override.cache, write: ttlWrite(match.tier, override.cache.write) } };
      });
    },
  };
}

export function buildOutrunModel(model: OutrunPricingModel, authored: ExistingModel): SyncedModel {
  // Price-only sync: update token rates and context tiers, keep every other
  // hand-authored field (capabilities, limits, APIs, evidence headers).
  const cost = { ...authored.cost, ...buildOutrunCost(model) };
  return { ...authored, cost } as SyncedModel;
}

export const outrun = {
  id: "outrun",
  name: "Outrun",
  modelsDir: "providers/outrun/models",
  // The feed lists every routed model; catalog entries are curated by hand, so
  // only existing files are priced and nothing is created or reported missing.
  skipCreates: true,
  deleteMissing: false,
  sourceID() {
    return undefined;
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Outrun models are missing from the price feed and were retained: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(PRICING_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Outrun pricing request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels: parseOutrunPricing,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return {
      id: model.id,
      model: buildOutrunModel(model, authored),
      v2Set: outrunV2Set(model),
    };
  },
} satisfies SyncProvider<OutrunPricingModel>;
