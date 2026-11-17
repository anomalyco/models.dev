import { z } from "zod";

import type { SyncProvider, SyncedV2Model } from "../index.js";

// Public Hostlinku catalog (unauthenticated; USD per 1M tokens for text/cache, per 1k queries for web search).
const API_ENDPOINT = "https://api.hostlinku.com/api/public/models";
const MIN_EXPECTED_MODELS = 10;

const HostlinkuPrices = z.object({
  inputCredits: z.number().nonnegative(),
  outputCredits: z.number().nonnegative(),
  cacheReadCredits: z.number().nonnegative().nullable().optional(),
  cacheWrite5mCredits: z.number().nonnegative().nullable().optional(),
  cacheWrite1hCredits: z.number().nonnegative().nullable().optional(),
  webSearchPer1kCredits: z.number().nonnegative().nullable().optional(),
}).passthrough();

const HostlinkuTier = z.object({
  minTokens: z.number().int().positive(),
  inputCredits: z.number().nonnegative(),
  outputCredits: z.number().nonnegative(),
  cacheReadCredits: z.number().nonnegative().nullable().optional(),
  cacheWrite5mCredits: z.number().nonnegative().nullable().optional(),
  cacheWrite1hCredits: z.number().nonnegative().nullable().optional(),
}).passthrough();

const HostlinkuMode = z.object({
  mode: z.string().min(1),
  prices: HostlinkuPrices,
  tiers: z.array(HostlinkuTier).optional().default([]),
}).passthrough();

export const HostlinkuModel = z.object({
  modelId: z.string().min(1),
  slug: z.string().min(1),
  defaultMode: z.enum(["performance", "economy", "dedicated"]),
  modes: z.object({
    performance: HostlinkuMode.nullable().optional(),
    economy: HostlinkuMode.nullable().optional(),
    dedicated: HostlinkuMode.nullable().optional(),
  }).passthrough(),
}).passthrough();

export const HostlinkuResponse = z.object({
  status: z.literal("success").optional(),
  models: z.array(HostlinkuModel),
}).passthrough();

export type HostlinkuModel = z.infer<typeof HostlinkuModel>;
type HostlinkuPriceFields = z.infer<typeof HostlinkuPrices>;
type HostlinkuTierFields = z.infer<typeof HostlinkuTier>;

/**
 * Syncs per-mode USD pricing from Hostlinku's unauthenticated public catalog
 * and removes local files that leave the catalog. Lab `base_model` pointers,
 * API surface blocks, and live-probed reasoning controls stay hand-authored.
 */
export const hostlinku = {
  id: "hostlinku",
  name: "Hostlinku",
  modelsDir: "providers/hostlinku/models",
  skipCreates: true,
  trackMissingModels: false,
  async fetchModels() {
    return fetchHostlinkuModels();
  },
  parseModels(raw) {
    const models = HostlinkuResponse.parse(raw).models;
    if (models.length < MIN_EXPECTED_MODELS) {
      throw new Error(`Hostlinku returned too few models (${models.length}); refusing to sync a truncated catalog`);
    }
    return models;
  },
  translateModel(model, context) {
    const current = context.v2?.(model.modelId);
    if (current === undefined) return undefined;

    const cost = buildHostlinkuCost(model, current);
    if (cost === undefined) {
      // Keep the existing TOML intact if a listed model temporarily lacks usable mode pricing.
      return {
        id: model.modelId,
        v2: current,
        notices: [`Retained ${model.modelId}: public catalog row has no priceable mode.`],
      } satisfies SyncedV2Model;
    }

    return {
      id: model.modelId,
      v2: { ...current, cost },
    } satisfies SyncedV2Model;
  },
} satisfies SyncProvider<HostlinkuModel>;

export async function fetchHostlinkuModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Hostlinku models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildCacheEntry(prices: HostlinkuPriceFields | HostlinkuTierFields, includeWrite: boolean) {
  const read = prices.cacheReadCredits ?? undefined;
  const write5m = includeWrite ? (prices.cacheWrite5mCredits ?? undefined) : undefined;
  const write1h = includeWrite ? (prices.cacheWrite1hCredits ?? undefined) : undefined;
  const write = write5m !== undefined || write1h !== undefined
    ? {
        ...(write5m !== undefined ? { "5m": write5m } : {}),
        ...(write1h !== undefined ? { "1h": write1h } : {}),
      }
    : undefined;

  if (read === undefined && write === undefined) return undefined;
  return {
    ...(read !== undefined ? { read } : {}),
    ...(write !== undefined ? { write } : {}),
  };
}

export function buildHostlinkuCost(model: HostlinkuModel, current: Record<string, unknown>) {
  const baseMode =
    model.modes[model.defaultMode]
    ?? model.modes.performance
    ?? model.modes.dedicated
    ?? model.modes.economy;
  if (!baseMode) return undefined;

  const currentCost = isRecord(current.cost) ? current.cost : undefined;
  const currentText = isRecord(currentCost?.text) ? currentCost.text : undefined;
  const currentInput = isRecord(currentText?.input) ? currentText.input : undefined;
  const currentCache = isRecord(currentInput?.cache) ? currentInput.cache : undefined;
  const includeWrite = currentCache?.write !== undefined;

  const sortedTiers = (tiers: readonly HostlinkuTierFields[]) =>
    [...tiers].sort((a, b) => a.minTokens - b.minTokens);

  const inputOverrides: Array<Record<string, unknown>> = [];
  const outputOverrides: Array<Record<string, unknown>> = [];

  for (const tier of sortedTiers(baseMode.tiers)) {
    const cache = buildCacheEntry(tier, includeWrite);
    inputOverrides.push({
      when: { context: { gte: tier.minTokens } },
      price: tier.inputCredits,
      ...(cache !== undefined ? { cache } : {}),
    });
    outputOverrides.push({
      when: { context: { gte: tier.minTokens } },
      price: tier.outputCredits,
    });
  }

  const economy = model.defaultMode !== "economy" ? (model.modes.economy ?? undefined) : undefined;
  if (economy !== undefined) {
    const econCache = buildCacheEntry(economy.prices, includeWrite);
    inputOverrides.push({
      when: { mode: { equals: "economy" } },
      price: economy.prices.inputCredits,
      ...(econCache !== undefined ? { cache: econCache } : {}),
    });
    outputOverrides.push({
      when: { mode: { equals: "economy" } },
      price: economy.prices.outputCredits,
    });

    for (const tier of sortedTiers(economy.tiers)) {
      const cache = buildCacheEntry(tier, includeWrite);
      inputOverrides.push({
        when: { context: { gte: tier.minTokens }, mode: { equals: "economy" } },
        price: tier.inputCredits,
        ...(cache !== undefined ? { cache } : {}),
      });
      outputOverrides.push({
        when: { context: { gte: tier.minTokens }, mode: { equals: "economy" } },
        price: tier.outputCredits,
      });
    }
  }

  const baseCache = buildCacheEntry(baseMode.prices, includeWrite);
  const textInput = {
    price: baseMode.prices.inputCredits,
    ...(baseCache !== undefined ? { cache: baseCache } : {}),
    ...(inputOverrides.length > 0 ? { overrides: inputOverrides } : {}),
  };
  const textOutput = {
    price: baseMode.prices.outputCredits,
    ...(outputOverrides.length > 0 ? { overrides: outputOverrides } : {}),
  };

  const baseWeb = baseMode.prices.webSearchPer1kCredits ?? undefined;
  const webOverrides: Array<Record<string, unknown>> = [];
  if (economy?.prices.webSearchPer1kCredits != null) {
    webOverrides.push({
      when: { mode: { equals: "economy" } },
      price: economy.prices.webSearchPer1kCredits,
    });
  }
  const webSearch = baseWeb !== undefined
    ? {
        price: baseWeb,
        ...(webOverrides.length > 0 ? { overrides: webOverrides } : {}),
      }
    : undefined;

  return {
    text: {
      input: textInput,
      output: textOutput,
    },
    ...(webSearch !== undefined ? { web_search: webSearch } : {}),
  };
}
