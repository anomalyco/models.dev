import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Alibaba Cloud Model Studio (international): the console's catalog API, GET
// https://dashscope-intl.aliyuncs.com/api/v1/models (DASHSCOPE_API_KEY). It isn't documented, but the model list and
// pricing pages are built from it. It syncs input, output and cache prices, flat or per context band (a band only
// updates when the file already has one at the same threshold), peak prices where the file already models the off-peak
// discount as a utc_hours multiplier, and deprecated status from the catalog's offline date. The implicit cache read is
// only written to files that declare implicit caching. Limits are only reported.
// alibaba-cn isn't synced: dashscope.aliyuncs.com needs a China key.
const ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const PAGE_SIZE = 200;

const Price = z.object({
  type: z.string(),
  price: z.string().regex(/^\d+(?:\.\d+)?$/),
  price_unit: z.string(),
  time_band: z.string().nullable(),
}).passthrough();

const Limit = z.number().int().nonnegative().nullable().optional();

export const AlibabaModel = z.object({
  model: z.string().min(1),
  prices: z.array(z.object({ range_name: z.string(), prices: z.array(Price) }).passthrough()).nullable(),
  model_info: z.object({
    context_window: Limit,
    max_input_tokens: Limit,
    max_output_tokens: Limit,
    reasoning_max_output_tokens: Limit,
  }).passthrough().nullable().optional(),
  inference_offline_info: z.object({ offline_time: z.string().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough();
export type AlibabaModel = z.infer<typeof AlibabaModel>;

const AlibabaPage = z.object({
  success: z.literal(true),
  output: z.object({ total: z.number().int().nonnegative(), models: z.array(AlibabaModel) }).passthrough(),
}).passthrough();

export interface AlibabaBandPrice {
  input: number;
  output: number;
  // Implicit cache hits (input_token_cache).
  cacheRead?: number;
  // Explicit cache: hits (input_token_cache_read) and creation per TTL (input_token_cache_creation_5m / _1h).
  explicitRead?: number;
  explicitWrite?: { "5m"?: number; "1h"?: number };
}

export interface AlibabaPrice extends AlibabaBandPrice {
  // Context bands after the first: prices for prompts above `above` tokens.
  bands: (AlibabaBandPrice & { above: number })[];
}

// "Default" and "Input<=256k" start at 0; "256k<Input<=1m" starts above 256,000 tokens.
function bandStart(name: string): number | undefined {
  if (name === "Default" || /^Input<=\d+[km]$/.test(name)) return 0;
  const match = /^(\d+)([km])<Input<=\d+[km]$/.exec(name);
  if (match === null) return undefined;
  return Number(match[1]) * (match[2] === "k" ? 1_000 : 1_000_000);
}

type PriceRow = z.infer<typeof Price>;

function readBand(rows: PriceRow[]): AlibabaBandPrice | undefined {
  const pick = (type: string) => {
    const matches = rows.filter((row) => row.type === type);
    if (matches.length === 0) return undefined;
    if (matches.length !== 1 || matches[0]!.price_unit !== "Per 1M tokens") return null;
    return Number(matches[0]!.price);
  };
  const input = pick("input_token");
  const output = pick("output_token");
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const optional = (value: number | null | undefined) => (typeof value === "number" ? value : undefined);
  const write5m = optional(pick("input_token_cache_creation_5m"));
  const write1h = optional(pick("input_token_cache_creation_1h"));
  return {
    input,
    output,
    ...(optional(pick("input_token_cache")) === undefined ? {} : { cacheRead: optional(pick("input_token_cache")) }),
    ...(optional(pick("input_token_cache_read")) === undefined ? {} : { explicitRead: optional(pick("input_token_cache_read")) }),
    ...(write5m === undefined && write1h === undefined ? {} : {
      explicitWrite: { ...(write5m === undefined ? {} : { "5m": write5m }), ...(write1h === undefined ? {} : { "1h": write1h }) },
    }),
  };
}

// The rows to price from: standard rows, or peak rows when the file already models the off-peak discount (offPeak is
// its multiplier factor). Off-peak rows must be the peak price times that factor, or the band is skipped with a reason.
function bandRows(rows: PriceRow[], offPeak: number | undefined): { rows: PriceRow[] } | { skip: string } {
  const bands = new Set(rows.map((row) => row.time_band ?? "standard"));
  if (bands.size === 1 && bands.has("standard")) return { rows };
  if (bands.size !== 2 || !bands.has("peak") || !bands.has("offpeak")) return { skip: "time bands" };
  if (offPeak === undefined) return { skip: "peak/off-peak prices without an off-peak multiplier in the file" };
  const peak = rows.filter((row) => row.time_band === "peak");
  for (const row of rows.filter((item) => item.time_band === "offpeak")) {
    const match = peak.find((item) => item.type === row.type);
    if (match === undefined || Math.abs(Number(match.price) * offPeak - Number(row.price)) > 1e-9 + Number(row.price) * 0.01) {
      return { skip: `off-peak ${row.type} ${row.price} isn't the peak price times the file's multiplier ${offPeak}` };
    }
  }
  return { rows: peak };
}

/** Prices per 1M tokens per context band, or a reason it can't be read (other units, odd ranges, time bands). */
export function readPrice(model: AlibabaModel, offPeak?: number): AlibabaPrice | { skip: string } {
  const ranges = (model.prices ?? []).map((range) => ({ start: bandStart(range.range_name), rows: range.prices }));
  if (ranges.length === 0 || ranges.some((range) => range.start === undefined)) return { skip: "no token price ranges" };
  ranges.sort((a, b) => a.start! - b.start!);
  if (ranges[0]!.start !== 0 || new Set(ranges.map((range) => range.start)).size !== ranges.length) {
    return { skip: "overlapping price ranges" };
  }
  const prices: AlibabaBandPrice[] = [];
  for (const range of ranges) {
    const rows = bandRows(range.rows, offPeak);
    if ("skip" in rows) return rows;
    const price = readBand(rows.rows);
    if (price === undefined) return { skip: "no per-token input and output price" };
    prices.push(price);
  }
  return {
    ...prices[0]!,
    bands: ranges.slice(1).map((range, index) => ({ above: range.start!, ...prices[index + 1]! })),
  };
}

/** Standard input and output prices per context band, or undefined for time bands, other units or odd ranges. */
export function flatPrice(model: AlibabaModel): AlibabaPrice | undefined {
  const price = readPrice(model);
  return "skip" in price ? undefined : price;
}

// The API rounds to three decimals (0.0625 -> 0.063), so a file price within that rounding of the listed one is kept.
// The tolerance is fixed: the listed string drops trailing zeros ("3" is 3.000), so its digits don't show the rounding.
const keepPrecise = (listed: number, file: number | undefined) =>
  file !== undefined && Math.abs(file - listed) <= 0.0005 + 1e-12 ? file : listed;

const withCacheRead = <T extends { cache_read?: number }>(target: T, listed: number | undefined) =>
  listed === undefined ? target : { ...target, cache_read: keepPrecise(listed, target.cache_read) };

// A band updates only when the file already has a band at the same threshold; otherwise the model is left alone, since
// adding or moving bands changes the file's structure.
export function buildAlibabaModel(price: AlibabaPrice, authored: ExistingModel): SyncedModel | undefined {
  const tiers = authored.cost?.tiers ?? [];
  const sizes = tiers.map((tier) => tier.tier.size).sort((a, b) => a - b);
  const above = price.bands.map((band) => band.above);
  if (JSON.stringify(sizes) !== JSON.stringify(above)) return undefined;
  const cost = withCacheRead({
    ...authored.cost,
    input: keepPrecise(price.input, authored.cost?.input),
    output: keepPrecise(price.output, authored.cost?.output),
    ...(tiers.length === 0 ? {} : {
      tiers: tiers.map((tier) => {
        const band = price.bands.find((item) => item.above === tier.tier.size)!;
        return withCacheRead({ ...tier, input: keepPrecise(band.input, tier.input), output: keepPrecise(band.output, tier.output) }, band.cacheRead);
      }),
    }),
  }, price.cacheRead);
  return { ...authored, cost } as SyncedModel;
}

type Doc = Record<string, any>;

// Explicit cache prices patch the keys the file already has (a read price, a write price or a write per TTL), so a
// file that leaves explicit cache out, or prices it under the implicit fields, keeps its layout.
function patchExplicit(current: Doc | undefined, band: AlibabaBandPrice): Doc | undefined {
  if (current === undefined || current === null || typeof current !== "object") return current;
  const next = { ...current };
  if (typeof next.read === "number" && band.explicitRead !== undefined) next.read = keepPrecise(band.explicitRead, next.read);
  const write = band.explicitWrite;
  if (write !== undefined) {
    if (typeof next.write === "number" && write["5m"] !== undefined) next.write = keepPrecise(write["5m"], next.write);
    else if (next.write !== null && typeof next.write === "object") {
      next.write = Object.fromEntries(Object.entries<number>(next.write).map(([ttl, value]) => {
        const listed = write[ttl as "5m" | "1h"];
        return [ttl, listed === undefined ? value : keepPrecise(listed, value)];
      }));
    }
  }
  return next;
}

/**
 * v2 values for explicit cache prices, at the base price and in each context override the file already has. Given the
 * file's input cost, they start from it: the runner's v1 patch puts v1's single cache write at the top level of each
 * cache, so the file's own top-level write (usually none) is put back.
 */
export function explicitCacheV2Set(price: AlibabaPrice, original?: Doc): Record<string, unknown> {
  const contextSize = (when: Doc | undefined) => when?.context?.gt ?? when?.context?.gte;
  const from = <T>(current: T, path: (input: Doc) => T) => (original === undefined ? current : path(original));
  const restoreWrite = (cache: Doc | undefined, before: Doc | undefined) => {
    if (cache === undefined || original === undefined) return cache;
    const { write: _write, ...rest } = cache;
    return before?.write === undefined ? rest : { ...rest, write: before.write };
  };
  return {
    ...(original === undefined ? {} : { "cost.text.input.cache.write": original.cache?.write }),
    "cost.text.input.cache.explicit": (current: Doc | undefined) => patchExplicit(from(current, (input) => input.cache?.explicit), price),
    "cost.text.input.overrides": (current: Doc[] | undefined) => current?.map((override) => {
      const before = (original?.overrides as Doc[] | undefined)?.find((item) => contextSize(item.when) === contextSize(override.when));
      override = { ...override, ...(override.cache === undefined ? {} : { cache: restoreWrite(override.cache, before?.cache) }) };
      if (before?.cache?.explicit !== undefined) override = { ...override, cache: { ...override.cache, explicit: before.cache.explicit } };
      const band = price.bands.find((item) => item.above === contextSize(override.when));
      if (band === undefined || override.cache?.explicit === undefined) return override;
      return { ...override, cache: { ...override.cache, explicit: patchExplicit(override.cache.explicit, band) } };
    }),
  };
}

// v1 has one cache write price: the top-level write, else the explicit write, first TTL listed (translate.ts cacheWrite).
function v1CacheWrite(cache: Doc | undefined): number | undefined {
  const first = (write: unknown) => (typeof write === "number" ? write : write !== null && typeof write === "object" ? Object.values(write as Record<string, number>)[0] : undefined);
  return first(cache?.write) ?? first(cache?.explicit?.write);
}

/**
 * The v1 cache write prices that match the explicit prices the v2Set writes, so the written file reproduces the synced
 * model: the base price and each tier, from the file's cache after patching.
 */
export function withExplicitCacheWrite(model: SyncedModel, price: AlibabaPrice, v2: Doc | undefined): SyncedModel {
  const input = v2?.cost?.text?.input;
  if (input === undefined) return model;
  const set = explicitCacheV2Set(price);
  const patch = (cache: Doc | undefined, band: AlibabaBandPrice) =>
    cache === undefined ? undefined : { ...cache, explicit: patchExplicit(cache.explicit, band) };
  const cost = (model as ExistingModel).cost;
  if (cost === undefined) return model;
  const contextSize = (when: Doc | undefined) => when?.context?.gt ?? when?.context?.gte;
  const overrides = ((set["cost.text.input.overrides"] as (value: unknown) => Doc[] | undefined)(input.overrides) ?? []);
  const write = v1CacheWrite(patch(input.cache, price));
  const next = {
    ...cost,
    ...(write === undefined ? {} : { cache_write: write }),
    ...(cost.tiers === undefined ? {} : {
      tiers: cost.tiers.map((tier) => {
        const override = overrides.find((item) => contextSize(item.when) === tier.tier.size);
        const tierWrite = v1CacheWrite(override?.cache);
        return tierWrite === undefined ? tier : { ...tier, cache_write: tierWrite };
      }),
    }),
  };
  return { ...model, cost: next } as SyncedModel;
}

/** The file's off-peak discount: the factor of a utc_hours multiplier, plain or on text prices. */
export function offPeakFactor(v2: Doc | undefined): number | undefined {
  for (const multiplier of (v2?.cost?.multipliers ?? []) as Doc[]) {
    const keys = Object.keys(multiplier.when ?? {});
    if (keys.length !== 1 || keys[0] !== "utc_hours") continue;
    if (typeof multiplier.factor === "number") return multiplier.factor;
    if (typeof multiplier.factor?.text === "number" && Object.keys(multiplier.factor).length === 1) return multiplier.factor.text;
  }
  return undefined;
}

/** Whether the file declares implicit caching, the only kind the top-level cache read prices. */
export function declaresImplicitCache(v2: Doc | undefined): boolean {
  const implicit = v2?.capabilities?.cache?.implicit;
  return implicit !== undefined && implicit !== false;
}

// Drops the implicit cache read when the file doesn't declare implicit caching: some files price explicit hits under the
// top-level read, which an implicit price would overwrite.
export function withoutImplicitRead(price: AlibabaPrice): AlibabaPrice {
  const strip = <T extends AlibabaBandPrice>({ cacheRead: _cacheRead, ...rest }: T) => rest;
  return { ...strip(price), bands: price.bands.map((band) => strip(band)) };
}

/** Notices for catalog limits that differ from the resolved file. The output limit may match either mode's cap. */
export function limitNotices(model: AlibabaModel, resolved: ExistingModel | undefined): string[] {
  const info = model.model_info;
  const limit = resolved?.limit;
  if (!info || !limit) return [];
  const notices: string[] = [];
  const context = info.context_window;
  if (typeof context === "number" && context > 0 && limit.context !== context && limit.context !== info.max_input_tokens) {
    notices.push(`Alibaba ${model.model}: catalog context_window ${context}, file limit.context ${limit.context}`);
  }
  const outputs = [...new Set([info.max_output_tokens, info.reasoning_max_output_tokens])]
    .filter((value): value is number => typeof value === "number" && value > 0);
  if (outputs.length > 0 && !outputs.includes(limit.output)) {
    notices.push(`Alibaba ${model.model}: catalog max_output_tokens ${outputs.join(" / ")}, file limit.output ${limit.output}`);
  }
  return notices;
}

export function translateAlibabaModel(
  model: AlibabaModel,
  context: { authored(id: string): ExistingModel | undefined; existing(id: string): ExistingModel | undefined; v2?(id: string): Doc | undefined },
) {
  const authored = context.authored(model.model);
  if (authored === undefined) return undefined;
  const notices = limitNotices(model, context.existing(model.model));
  const v2 = context.v2?.(model.model);
  const read = readPrice(model, offPeakFactor(v2));
  let price = read;
  if (!("skip" in read) && !declaresImplicitCache(v2) && [read, ...read.bands].some((band) => band.cacheRead !== undefined)) {
    price = withoutImplicitRead(read);
    notices.push(`Alibaba ${model.model}: catalog lists an implicit cache price but the file doesn't declare implicit caching; left unchanged`);
  }
  const built0 = "skip" in price ? undefined : buildAlibabaModel(price, authored);
  const priced = built0 === undefined || "skip" in price ? built0 : withExplicitCacheWrite(built0, price, v2);
  const offline = model.inference_offline_info?.offline_time ?? undefined;
  const deprecate = offline !== undefined && authored.status !== "deprecated";
  if (deprecate) notices.push(`Alibaba ${model.model}: catalog offline_time ${offline}; marked deprecated`);
  if (priced === undefined && !deprecate) return notices.length === 0 ? undefined : { id: model.model, model: authored as SyncedModel, notices };
  const built = { ...(priced ?? authored), ...(deprecate ? { status: "deprecated" as const } : {}) } as SyncedModel;
  return {
    id: model.model,
    model: built,
    ...(priced === undefined || "skip" in price ? {} : { v2Set: explicitCacheV2Set(price, v2?.cost?.text?.input) }),
    ...(notices.length === 0 ? {} : { notices }),
  };
}

export const alibaba = {
  id: "alibaba",
  name: "Alibaba",
  modelsDir: "providers/alibaba/models",
  // New models need controls, APIs and limits written by hand. The list also leaves out models that still work, so
  // nothing is deleted and missing models aren't reported.
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.model;
  },
  skippedNotice() {
    return [];
  },
  missingNotice() {
    return [];
  },
  async fetchModels() {
    const key = process.env.DASHSCOPE_API_KEY ?? process.env.ALIBABA_API_KEY;
    if (!key) throw new Error("Alibaba sync requires DASHSCOPE_API_KEY");
    const models: AlibabaModel[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await fetch(`${ENDPOINT}?page_size=${PAGE_SIZE}&page_no=${page}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) throw new Error(`Alibaba models request failed: ${response.status} ${response.statusText}`);
      const { output } = AlibabaPage.parse(await response.json());
      models.push(...output.models);
      if (output.models.length === 0 || models.length >= output.total) {
        if (models.length !== output.total) throw new Error(`Alibaba listed ${models.length} of ${output.total} models`);
        return models;
      }
    }
    throw new Error("Alibaba models: too many pages");
  },
  parseModels(raw) {
    const models = z.array(AlibabaModel).parse(raw);
    if (models.length === 0) throw new Error("Alibaba returned no models; refusing to sync an empty catalog");
    return models;
  },
  translateModel(model, context) {
    return translateAlibabaModel(model, context);
  },
} satisfies SyncProvider<AlibabaModel>;
