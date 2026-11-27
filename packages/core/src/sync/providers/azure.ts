import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Azure Retail Prices API, no key: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
const API_BASE = "https://prices.azure.com/api/retail/prices";
// GPT-5.6 and later share one meter format. Other recent models are listed in PARTNER_MODELS below.
const PRODUCTS = ["Azure OpenAI GPT6", "Azure OpenAI GPT5", "Azure Grok Models", "Azure Kimi", "Azure Deepseek Models"];

// Partner models name their meters by a display label (`4.7 Inp glbl L`, `K2.7 Code cached DZ`, `V4.1 Flash Output Glbl`)
// with no model ID, so each local file lists the labels its meters use. Only models from the last few months are here;
// older ones keep hand-written prices.
export const PARTNER_MODELS: Record<string, { product: string; labels: string[] }> = {
  "grok-4-20-reasoning": { product: "Azure Grok Models", labels: ["Grok 4.2"] },
  "grok-4-20-non-reasoning": { product: "Azure Grok Models", labels: ["Grok 4.2"] },
  "grok-4.6": { product: "Azure Grok Models", labels: ["4.6"] },
  "grok-4.7": { product: "Azure Grok Models", labels: ["4.7"] },
  "kimi-k2.5": { product: "Azure Kimi", labels: ["K2.5 Thinking", "K2.5"] },
  "kimi-k2.6": { product: "Azure Kimi", labels: ["K2.6 Thinking", "K2.6"] },
  "kimi-k2.7-code": { product: "Azure Kimi", labels: ["K2.7 Code"] },
  // Its cached-input meter drops "Pro": "Kimi 3.1 Cached Inp Glbl".
  "kimi-k3.1-pro": { product: "Azure Kimi", labels: ["Kimi 3.1 Pro", "Kimi 3.1"] },
  "deepseek-v4-flash": { product: "Azure Deepseek Models", labels: ["V4 Flash"] },
  "deepseek-v4-pro": { product: "Azure Deepseek Models", labels: ["V4 Pro"] },
  "deepseek-v4.1-flash": { product: "Azure Deepseek Models", labels: ["V4.1 Flash"] },
};
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

// `6.1-sol LongCo Cd Inp Std Gl`, `61 terra ShortCo Opt std Gl`, `5.6 luna ShortCo Cd Wr PP DZ`; GPT-6.2 shortens the band to
// ShCo/LoCo (`6.2-sol LoCo Cd Inp Std Gl`).
const METER = /^(.+?) (ShortCo|LongCo|ShCo|LoCo) (Cd Inp|Cd Wr|Inp|Opt) (Std|Flex|PP) (Gl|DZ)$/i;
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
    longContext: ["longco", "loco"].includes(match[2]!.toLowerCase()),
    tier: TIERS[match[4]!.toLowerCase()]!,
    global: match[5]!.toLowerCase() === "gl",
  };
}

// `<label> <kind> <route>[ L]`, where L marks the long-context rate.
const PARTNER_METER = /^(.+?) (cached inp|cached|inp|input|in|outp|output|opt) (glbl|dz)( l)?$/i;
const PARTNER_KINDS: Record<string, AzurePrice["kind"]> = {
  "cached inp": "cache_read", cached: "cache_read", inp: "input", input: "input", in: "input", outp: "output", output: "output", opt: "output",
};

export function parsePartnerMeter(skuName: string): ({ label: string } & Omit<AzurePrice, "usd">) | undefined {
  const match = PARTNER_METER.exec(skuName.trim());
  if (match === null) return undefined;
  return {
    label: match[1]!.toLowerCase(),
    kind: PARTNER_KINDS[match[2]!.toLowerCase()]!,
    longContext: match[4] !== undefined,
    tier: "standard",
    global: match[3]!.toLowerCase() === "glbl",
  };
}

const perMillion = (item: z.infer<typeof PriceItem>) =>
  item.unitOfMeasure === "1M" ? item.unitPrice : item.unitOfMeasure === "1K" ? Number((item.unitPrice * 1000).toFixed(6)) : undefined;

/** Rows per GPT model key. */
export function priceRows(items: z.infer<typeof PriceItem>[]) {
  const byKey = new Map<string, AzurePrice[]>();
  for (const item of items) {
    const usd = item.type === "Consumption" ? perMillion(item) : undefined;
    if (usd === undefined) continue;
    const meter = parseMeter(item.skuName);
    if (meter === undefined) continue;
    const { key, ...row } = meter;
    byKey.set(key, [...(byKey.get(key) ?? []), { ...row, usd }]);
  }
  return byKey;
}

/** Rows for each PARTNER_MODELS file. */
export function partnerRows(items: z.infer<typeof PriceItem>[]) {
  const byID = new Map<string, AzurePrice[]>();
  for (const [id, { product, labels }] of Object.entries(PARTNER_MODELS)) {
    const wanted = new Set(labels.map((label) => label.toLowerCase()));
    const rows: AzurePrice[] = [];
    for (const item of items) {
      if (item.productName !== product || item.type !== "Consumption") continue;
      const usd = perMillion(item);
      const meter = usd === undefined ? undefined : parsePartnerMeter(item.skuName);
      if (meter === undefined || !wanted.has(meter.label)) continue;
      const { label: _label, ...row } = meter;
      rows.push({ ...row, usd: usd! });
    }
    if (rows.length > 0) byID.set(id, rows);
  }
  return byID;
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
    // A listed cache read is a real price, so it's added when the file has none.
    ...(read === undefined ? {} : { cache_read: read }),
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

// The price API rate-limits bursts (429), so requests run one at a time and a 429 waits for Retry-After (or backs off)
// up to four times.
async function fetchWithRetry(url: string, attempts = 5): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.status !== 429 || attempt >= attempts) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2 ** attempt * 1000);
  }
}

async function fetchProduct(product: string) {
  const items: z.infer<typeof PriceItem>[] = [];
  let url: string | null | undefined =
    `${API_BASE}?$filter=${encodeURIComponent(`serviceName eq 'Foundry Models' and productName eq '${product}' and armRegionName eq '${REGION}'`)}`;
  for (let page = 0; url && page < 50; page++) {
    const response = await fetchWithRetry(url);
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
    const items: z.infer<typeof PriceItem>[] = [];
    for (const product of PRODUCTS) items.push(...await fetchProduct(product));
    const files: string[] = [];
    for await (const file of new Bun.Glob("*.toml").scan(MODELS_DIR)) files.push(file.slice(0, -".toml".length));
    return { items, files };
  },
  parseModels(raw) {
    const { items, files } = raw as { items: z.infer<typeof PriceItem>[]; files: string[] };
    const rows = priceRows(items);
    if (rows.size === 0) throw new Error("Azure prices had no GPT token meters; refusing to sync");
    const partners = partnerRows(items);
    return files.flatMap((id) => {
      const prices = partners.get(id) ?? (id.startsWith("gpt-") ? rows.get(modelKey(id)) : undefined);
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
