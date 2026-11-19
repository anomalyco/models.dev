import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Azure Retail Prices API, no key: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
const API_BASE = "https://prices.azure.com/api/retail/prices";
// GPT-5.6 and later price with one regular meter format; older families use irregular, one-off meter names.
const PRODUCTS = ["Azure OpenAI GPT6", "Azure OpenAI GPT5"];
const REGION = "eastus2";
const MODELS_DIR = path.resolve(import.meta.dir, "../../../../../providers/azure/models");

const PriceItem = z.object({
  productName: z.string(),
  skuName: z.string(),
  unitPrice: z.number(),
  unitOfMeasure: z.string(),
  type: z.string(),
}).passthrough();

const PricePage = z.object({
  Items: z.array(PriceItem),
  NextPageLink: z.string().nullable().optional(),
}).passthrough();

export interface AzurePrice {
  kind: "input" | "output" | "cache_read" | "cache_write";
  longContext: boolean;
  tier: "standard" | "flex" | "priority";
  global: boolean;
  usd: number;
}

export interface AzureModel {
  // The local file ID, e.g. `gpt-6.1-sol`.
  id: string;
  prices: AzurePrice[];
}

// `6.1-sol LongCo Cd Inp Std Gl`, `61 terra ShortCo Opt std Gl`, `5.6 luna ShortCo Cd Wr PP DZ`.
const METER = /^(.+?) (ShortCo|LongCo) (Cd Inp|Cd Wr|Inp|Opt) (Std|Flex|PP) (Gl|DZ)$/i;
const KINDS: Record<string, AzurePrice["kind"]> = { "cd inp": "cache_read", "cd wr": "cache_write", inp: "input", opt: "output" };
const TIERS: Record<string, AzurePrice["tier"]> = { std: "standard", flex: "flex", pp: "priority" };

/** The model key both meters and files reduce to: `6.1-sol`, `61 terra` and `gpt-6.1-sol` become `61sol`, `61terra`, `61sol`. */
export const modelKey = (value: string) => value.toLowerCase().replace(/^gpt-/, "").replace(/[^a-z0-9]/g, "");

export function parseMeter(skuName: string): ({ key: string } & Omit<AzurePrice, "usd">) | undefined {
  const match = METER.exec(skuName.trim());
  if (match === null) return undefined;
  return {
    key: modelKey(match[1]!),
    kind: KINDS[match[3]!.toLowerCase()]!,
    longContext: match[2]!.toLowerCase() === "longco",
    tier: TIERS[match[4]!.toLowerCase()]!,
    global: match[5]!.toLowerCase() === "gl",
  };
}

/** Rows per model key. Only per-1M consumption meters are kept. */
export function priceRows(items: z.infer<typeof PriceItem>[]) {
  const byKey = new Map<string, AzurePrice[]>();
  for (const item of items) {
    if (item.type !== "Consumption" || item.unitOfMeasure !== "1M") continue;
    const meter = parseMeter(item.skuName);
    if (meter === undefined) continue;
    const { key, ...row } = meter;
    byKey.set(key, [...(byKey.get(key) ?? []), { ...row, usd: item.unitPrice }]);
  }
  return byKey;
}

// Global standard-tier prices, which the files publish as their base rate. Flex, priority and the data-zone uplift
// stay as hand-written multipliers, and the 12h cache write (its own meter) isn't read.
export function buildAzureModel(model: AzureModel, authored: ExistingModel): SyncedModel | undefined {
  const pick = (kind: AzurePrice["kind"], longContext: boolean) => {
    const values = [...new Set(model.prices
      .filter((row) => row.kind === kind && row.longContext === longContext && row.tier === "standard" && row.global)
      .map((row) => row.usd))];
    return values.length === 1 ? values[0] : undefined;
  };
  const input = pick("input", false);
  const output = pick("output", false);
  if (input === undefined || output === undefined) return undefined;
  const cost = authored.cost ?? ({} as NonNullable<ExistingModel["cost"]>);
  const read = pick("cache_read", false);
  const write = pick("cache_write", false);
  const next = {
    ...cost,
    input,
    output,
    ...(cost.cache_read === undefined || read === undefined ? {} : { cache_read: read }),
    ...(cost.cache_write === undefined || write === undefined ? {} : { cache_write: write }),
  } as Record<string, unknown>;
  if (cost.tiers !== undefined && cost.tiers.length === 1) {
    const tier = cost.tiers[0]!;
    const longInput = pick("input", true);
    const longOutput = pick("output", true);
    if (longInput !== undefined && longOutput !== undefined) {
      const longRead = pick("cache_read", true);
      const longWrite = pick("cache_write", true);
      next.tiers = [{
        ...tier,
        input: longInput,
        output: longOutput,
        ...(tier.cache_read === undefined || longRead === undefined ? {} : { cache_read: longRead }),
        ...(tier.cache_write === undefined || longWrite === undefined ? {} : { cache_write: longWrite }),
      }];
    }
  }
  return { ...authored, cost: next } as SyncedModel;
}

async function fetchProduct(product: string) {
  const items: z.infer<typeof PriceItem>[] = [];
  let url: string | null | undefined =
    `${API_BASE}?$filter=${encodeURIComponent(`serviceName eq 'Foundry Models' and productName eq '${product}' and armRegionName eq '${REGION}'`)}`;
  for (let page = 0; url && page < 50; page++) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Azure prices request failed: ${response.status} ${response.statusText}`);
    const parsed = PricePage.parse(await response.json());
    items.push(...parsed.Items);
    url = parsed.NextPageLink;
  }
  return items;
}

export const azure = {
  id: "azure",
  name: "Azure",
  modelsDir: "providers/azure/models",
  // Prices only, for files that exist. The price list has no model IDs to create or retire models from.
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice() {
    return [];
  },
  missingNotice() {
    return [];
  },
  async fetchModels() {
    const items = (await Promise.all(PRODUCTS.map(fetchProduct))).flat();
    const files: string[] = [];
    for await (const file of new Bun.Glob("gpt-*.toml").scan(MODELS_DIR)) files.push(file.slice(0, -".toml".length));
    return { items, files };
  },
  parseModels(raw) {
    const { items, files } = raw as { items: z.infer<typeof PriceItem>[]; files: string[] };
    const rows = priceRows(items);
    if (rows.size === 0) throw new Error("Azure prices had no GPT token meters; refusing to sync");
    return files.flatMap((id) => {
      const prices = rows.get(modelKey(id));
      return prices === undefined ? [] : [{ id, prices }];
    });
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    const built = buildAzureModel(model, authored);
    return built === undefined ? undefined : { id: model.id, model: built };
  },
} satisfies SyncProvider<AzureModel>;
