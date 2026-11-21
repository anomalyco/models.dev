import { z } from "zod";

import type { SyncProvider, SyncedV2Model } from "../index.js";

// Public Hostlinku catalog (unauthenticated; USD per 1M tokens for text/cache, per 1k queries for web search).
const API_ENDPOINT = "https://api.hostlinku.com/api/public/pricing";
const MIN_EXPECTED_MODELS = 10;

const HostlinkuPrices = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().nullable().optional(),
  cacheWrite5m: z.number().nonnegative().nullable().optional(),
  cacheWrite1h: z.number().nonnegative().nullable().optional(),
  webSearchPer1k: z.number().nonnegative().nullable().optional(),
}).passthrough();

const HostlinkuTier = z.object({
  minTokens: z.number().int().positive(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().nullable().optional(),
  cacheWrite5m: z.number().nonnegative().nullable().optional(),
  cacheWrite1h: z.number().nonnegative().nullable().optional(),
}).passthrough();

const HostlinkuMode = z.object({
  mode: z.string().min(1),
  prices: HostlinkuPrices,
  tiers: z.array(HostlinkuTier).optional().default([]),
}).passthrough();

export const HostlinkuModel = z.object({
  modelId: z.string().min(1),
  slug: z.string().min(1).optional(),
  defaultMode: z.enum(["performance", "economy", "dedicated"]),
  modes: z.object({
    performance: HostlinkuMode.nullable().optional(),
    economy: HostlinkuMode.nullable().optional(),
    dedicated: HostlinkuMode.nullable().optional(),
  }).passthrough(),
}).passthrough();

export const HostlinkuResponse = z.object({
  status: z.literal("success").optional(),
  data: z.object({
    currency: z.literal("USD").optional(),
    unit: z.string().optional(),
    items: z.array(HostlinkuModel),
    total: z.number().int().nonnegative().optional(),
  }).passthrough(),
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
    const models = HostlinkuResponse.parse(raw).data.items;
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

function buildCacheEntry(
  prices: HostlinkuPriceFields | HostlinkuTierFields,
  includeWrite: boolean,
  existingCache?: Record<string, unknown>,
) {
  const { read: _existingRead, write: existingWriteRaw, ...restCache } = existingCache ?? {};
  const existingWrite = isRecord(existingWriteRaw) ? existingWriteRaw : undefined;
  const { "5m": _w5m, "1h": _w1h, ...restWrite } = existingWrite ?? {};

  const read = prices.cacheRead ?? undefined;
  const write5m = includeWrite ? (prices.cacheWrite5m ?? undefined) : undefined;
  const write1h = includeWrite ? (prices.cacheWrite1h ?? undefined) : undefined;
  const hasWrite = write5m !== undefined || write1h !== undefined || (includeWrite && Object.keys(restWrite).length > 0);
  const write = hasWrite
    ? {
        ...restWrite,
        ...(write5m !== undefined ? { "5m": write5m } : {}),
        ...(write1h !== undefined ? { "1h": write1h } : {}),
      }
    : undefined;

  if (read === undefined && write === undefined && Object.keys(restCache).length === 0) return undefined;
  return {
    ...restCache,
    ...(read !== undefined ? { read } : {}),
    ...(write !== undefined ? { write } : {}),
  };
}

function isCatalogOwnedOverride(entry: unknown): boolean {
  if (!isRecord(entry) || !isRecord(entry.when)) return false;
  const keys = Object.keys(entry.when);
  if (keys.length === 0 || keys.some((key) => key !== "context" && key !== "mode")) {
    return false;
  }
  if ("mode" in entry.when) {
    if (
      !isRecord(entry.when.mode)
      || entry.when.mode.equals !== "economy"
      || Object.keys(entry.when.mode).length !== 1
    ) {
      return false;
    }
  }
  if ("context" in entry.when) {
    if (
      !isRecord(entry.when.context)
      || typeof entry.when.context.gte !== "number"
      || Object.keys(entry.when.context).length !== 1
    ) {
      return false;
    }
  }
  return true;
}

function preservedOverrides(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => isRecord(entry) && !isCatalogOwnedOverride(entry));
}

function findMatchingOverride(
  value: unknown,
  when: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const target = JSON.stringify(when);
  return value.find((entry): entry is Record<string, unknown> => isRecord(entry) && JSON.stringify(entry.when) === target);
}

function buildInputOverride(
  existingList: unknown,
  when: Record<string, unknown>,
  prices: HostlinkuPriceFields | HostlinkuTierFields,
  includeWrite: boolean,
): Record<string, unknown> {
  const existing = findMatchingOverride(existingList, when);
  const { when: _w, price: _p, cache: existingCacheRaw, ...rest } = existing ?? {};
  const cache = buildCacheEntry(
    prices,
    includeWrite,
    isRecord(existingCacheRaw) ? existingCacheRaw : undefined,
  );
  return {
    ...rest,
    when,
    price: prices.input,
    ...(cache !== undefined ? { cache } : {}),
  };
}

function buildOutputOverride(
  existingList: unknown,
  when: Record<string, unknown>,
  output: number,
): Record<string, unknown> {
  const existing = findMatchingOverride(existingList, when);
  const { when: _w, price: _p, ...rest } = existing ?? {};
  return {
    ...rest,
    when,
    price: output,
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
  const currentOutput = isRecord(currentText?.output) ? currentText.output : undefined;
  const currentWebSearch = isRecord(currentCost?.web_search) ? currentCost.web_search : undefined;
  const currentCache = isRecord(currentInput?.cache) ? currentInput.cache : undefined;
  const includeWrite = currentCache?.write !== undefined;

  const sortedTiers = (tiers: readonly HostlinkuTierFields[]) =>
    [...tiers].sort((a, b) => a.minTokens - b.minTokens);

  const inputOverrides: Array<Record<string, unknown>> = [];
  const outputOverrides: Array<Record<string, unknown>> = [];

  for (const tier of sortedTiers(baseMode.tiers)) {
    const when = { context: { gte: tier.minTokens } };
    inputOverrides.push(buildInputOverride(currentInput?.overrides, when, tier, includeWrite));
    outputOverrides.push(buildOutputOverride(currentOutput?.overrides, when, tier.output));
  }

  const economy = model.defaultMode !== "economy" ? (model.modes.economy ?? undefined) : undefined;
  if (economy !== undefined) {
    const modeWhen = { mode: { equals: "economy" } };
    inputOverrides.push(buildInputOverride(currentInput?.overrides, modeWhen, economy.prices, includeWrite));
    outputOverrides.push(buildOutputOverride(currentOutput?.overrides, modeWhen, economy.prices.output));

    for (const tier of sortedTiers(economy.tiers)) {
      const tierModeWhen = { context: { gte: tier.minTokens }, mode: { equals: "economy" } };
      inputOverrides.push(buildInputOverride(currentInput?.overrides, tierModeWhen, tier, includeWrite));
      outputOverrides.push(buildOutputOverride(currentOutput?.overrides, tierModeWhen, tier.output));
    }
  }

  const allInputOverrides = [...inputOverrides, ...preservedOverrides(currentInput?.overrides)];
  const allOutputOverrides = [...outputOverrides, ...preservedOverrides(currentOutput?.overrides)];

  const { price: _inPrice, cache: _inCache, overrides: _inOverrides, ...restInput } = currentInput ?? {};
  const { price: _outPrice, overrides: _outOverrides, ...restOutput } = currentOutput ?? {};
  const { input: _textIn, output: _textOut, ...restText } = currentText ?? {};
  const { text: _costText, web_search: _costWeb, ...restCost } = currentCost ?? {};

  const baseCache = buildCacheEntry(baseMode.prices, includeWrite, currentCache);
  const textInput = {
    ...restInput,
    price: baseMode.prices.input,
    ...(baseCache !== undefined ? { cache: baseCache } : {}),
    ...(allInputOverrides.length > 0 ? { overrides: allInputOverrides } : {}),
  };
  const textOutput = {
    ...restOutput,
    price: baseMode.prices.output,
    ...(allOutputOverrides.length > 0 ? { overrides: allOutputOverrides } : {}),
  };

  const baseWeb = baseMode.prices.webSearchPer1k ?? undefined;
  const webOverrides: Array<Record<string, unknown>> = [];
  if (economy?.prices.webSearchPer1k != null) {
    webOverrides.push({
      when: { mode: { equals: "economy" } },
      price: economy.prices.webSearchPer1k,
    });
  }
  const allWebOverrides = [...webOverrides, ...preservedOverrides(currentWebSearch?.overrides)];
  const { price: _webPrice, overrides: _webOverrides, ...restWebSearch } = currentWebSearch ?? {};
  const webSearch = baseWeb !== undefined
    ? {
        ...restWebSearch,
        price: baseWeb,
        ...(allWebOverrides.length > 0 ? { overrides: allWebOverrides } : {}),
      }
    : undefined;

  return {
    ...restCost,
    text: {
      ...restText,
      input: textInput,
      output: textOutput,
    },
    ...(webSearch !== undefined ? { web_search: webSearch } : {}),
  };
}
