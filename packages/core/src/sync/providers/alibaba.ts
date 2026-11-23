import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Alibaba Cloud Model Studio (international): the console's catalog API, GET
// https://dashscope-intl.aliyuncs.com/api/v1/models (DASHSCOPE_API_KEY). It isn't documented, but the model list and
// pricing pages are built from it. This first version syncs input and output prices, flat or per context band (a band
// only updates when the file already has one at the same threshold). Peak/off-peak bands, cache prices and limits stay
// hand-written until each is checked against the files. alibaba-cn isn't synced: dashscope.aliyuncs.com needs a China key.
const ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const PAGE_SIZE = 200;

const Price = z.object({
  type: z.string(),
  price: z.string().regex(/^\d+(?:\.\d+)?$/),
  price_unit: z.string(),
  time_band: z.string().nullable(),
}).passthrough();

export const AlibabaModel = z.object({
  model: z.string().min(1),
  prices: z.array(z.object({ range_name: z.string(), prices: z.array(Price) }).passthrough()).nullable(),
}).passthrough();
export type AlibabaModel = z.infer<typeof AlibabaModel>;

const AlibabaPage = z.object({
  success: z.literal(true),
  output: z.object({ total: z.number().int().nonnegative(), models: z.array(AlibabaModel) }).passthrough(),
}).passthrough();

export interface AlibabaPrice {
  input: number;
  output: number;
  // Context bands after the first: prices for prompts above `above` tokens.
  bands: { above: number; input: number; output: number }[];
}

// "Default" and "Input<=256k" start at 0; "256k<Input<=1m" starts above 256,000 tokens.
function bandStart(name: string): number | undefined {
  if (name === "Default" || /^Input<=\d+[km]$/.test(name)) return 0;
  const match = /^(\d+)([km])<Input<=\d+[km]$/.exec(name);
  if (match === null) return undefined;
  return Number(match[1]) * (match[2] === "k" ? 1_000 : 1_000_000);
}

/** Input and output prices per 1M tokens per context band, or undefined for time bands, other units or odd ranges. */
export function flatPrice(model: AlibabaModel): AlibabaPrice | undefined {
  const ranges = (model.prices ?? []).map((range) => ({ start: bandStart(range.range_name), rows: range.prices }));
  if (ranges.length === 0 || ranges.some((range) => range.start === undefined)) return undefined;
  ranges.sort((a, b) => a.start! - b.start!);
  if (ranges[0]!.start !== 0 || new Set(ranges.map((range) => range.start)).size !== ranges.length) return undefined;
  const read = (rows: z.infer<typeof Price>[]) => {
    if (rows.some((row) => row.time_band !== null && row.time_band !== "standard")) return undefined;
    const pick = (type: string) => {
      const matches = rows.filter((row) => row.type === type);
      if (matches.length !== 1 || matches[0]!.price_unit !== "Per 1M tokens") return undefined;
      return Number(matches[0]!.price);
    };
    const input = pick("input_token");
    const output = pick("output_token");
    return input === undefined || output === undefined ? undefined : { input, output };
  };
  const prices = ranges.map((range) => read(range.rows));
  if (prices.some((price) => price === undefined)) return undefined;
  return {
    ...prices[0]!,
    bands: ranges.slice(1).map((range, index) => ({ above: range.start!, ...prices[index + 1]! })),
  };
}

// The API rounds to three decimals (0.0625 -> 0.063), so a file price that rounds to the listed one is kept.
const keepPrecise = (listed: number, file: number | undefined) => {
  const places = String(listed).split(".")[1]?.length ?? 0;
  return file !== undefined && Math.abs(file - listed) <= 0.5 * 10 ** -places + 1e-12 ? file : listed;
};

// A band updates only when the file already has a band at the same threshold; otherwise the model is left alone, since
// adding or moving bands changes the file's structure.
export function buildAlibabaModel(price: AlibabaPrice, authored: ExistingModel): SyncedModel | undefined {
  const tiers = authored.cost?.tiers ?? [];
  const sizes = tiers.map((tier) => tier.tier.size).sort((a, b) => a - b);
  const above = price.bands.map((band) => band.above);
  if (JSON.stringify(sizes) !== JSON.stringify(above)) return undefined;
  const cost = {
    ...authored.cost,
    input: keepPrecise(price.input, authored.cost?.input),
    output: keepPrecise(price.output, authored.cost?.output),
    ...(tiers.length === 0 ? {} : {
      tiers: tiers.map((tier) => {
        const band = price.bands.find((item) => item.above === tier.tier.size)!;
        return { ...tier, input: keepPrecise(band.input, tier.input), output: keepPrecise(band.output, tier.output) };
      }),
    }),
  };
  return { ...authored, cost } as SyncedModel;
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
    const authored = context.authored(model.model);
    const price = flatPrice(model);
    if (authored === undefined || price === undefined) return undefined;
    const built = buildAlibabaModel(price, authored);
    return built === undefined ? undefined : { id: model.model, model: built };
  },
} satisfies SyncProvider<AlibabaModel>;
