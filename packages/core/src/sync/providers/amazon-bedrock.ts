import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { modelMetadata } from "./openrouter.js";

// AWS's public price list, no key. Foundation models sold through Bedrock (Anthropic, OpenAI, Cohere, ...) are in
// AmazonBedrockFoundationModels; Amazon's own and open-weight models are in AmazonBedrock.
// https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-ppslong.html
const OFFERS = ["AmazonBedrockFoundationModels", "AmazonBedrock"];
const REGION = "us-east-1";
const offerURL = (offer: string) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/${REGION}/index.json`;
const MODELS_DIR = path.resolve(import.meta.dir, "../../../../../providers/amazon-bedrock/models");

const Offer = z.object({
  products: z.record(z.object({
    sku: z.string(),
    attributes: z.record(z.string()).default({}),
  }).passthrough()),
  terms: z.object({
    OnDemand: z.record(z.record(z.object({
      priceDimensions: z.record(z.object({
        unit: z.string(),
        pricePerUnit: z.object({ USD: z.string() }).passthrough(),
      }).passthrough()),
    }).passthrough())).default({}),
  }).passthrough(),
}).passthrough();

// One price row, read from a usage type such as `USE1-MP:USE1_cache_write_tokens_1h_long_ctx_global_standard-Units`.
export interface BedrockPrice {
  kind: "input" | "output" | "cache_read" | "cache_write";
  ttl?: string;
  longContext: boolean;
  global: boolean;
  tier: string;
  usd: number;
}

export interface BedrockModel {
  // A local file this model's prices apply to, e.g. `global.openai.gpt-6.1-sol`.
  id: string;
  name: string;
  global: boolean;
  prices: BedrockPrice[];
}

const USAGE = /_(input|output|cache_read|cache_write)_tokens(?:_(\d+[mh]))?(_long_ctx)?(_global)?_([a-z]+)-Units$/;

export function parseUsageType(usageType: string): Omit<BedrockPrice, "usd"> | undefined {
  const match = USAGE.exec(usageType);
  if (match === null) return undefined;
  return {
    kind: match[1] as BedrockPrice["kind"],
    ...(match[2] === undefined ? {} : { ttl: match[2] }),
    longContext: match[3] !== undefined,
    global: match[4] !== undefined,
    tier: match[5]!,
  };
}

/** Rows per AWS model name, from one offer file. Only per-1M-token rows are kept. */
export function offerPrices(raw: unknown) {
  const offer = Offer.parse(raw);
  const byModel = new Map<string, BedrockPrice[]>();
  for (const product of Object.values(offer.products)) {
    const model = product.attributes.model;
    const usageType = product.attributes.usagetype;
    if (model === undefined || usageType === undefined) continue;
    const parsed = parseUsageType(usageType);
    if (parsed === undefined) continue;
    for (const term of Object.values(offer.terms.OnDemand[product.sku] ?? {})) {
      for (const dimension of Object.values(term.priceDimensions)) {
        if (dimension.unit !== "1M tokens") continue;
        const usd = Number(dimension.pricePerUnit.USD);
        if (!Number.isFinite(usd)) continue;
        const rows = byModel.get(model) ?? [];
        rows.push({ ...parsed, usd: Number(usd.toFixed(6)) });
        byModel.set(model, rows);
      }
    }
  }
  return byModel;
}

// A local file's routing prefix. The us-east-1 offer prices in-region and US cross-region (`us.`) routes the same,
// and global (`global.`) routes with its own rows. Other geographies (`eu.`, `apac.`, ...) aren't in this offer.
function route(id: string): "regional" | "global" | undefined {
  if (id.startsWith("global.")) return "global";
  if (id.startsWith("us.")) return "regional";
  if (/^(eu|apac|jp|au|ca|us-gov)\./.test(id)) return undefined;
  return "regional";
}

const normalize = (name: string) => name.toLowerCase().replace(/^(openai|anthropic|amazon|meta|mistral|cohere)\s+/, "").trim();

/** Local files by the normalized name of their lab model, read from `base_model`. */
export async function localFilesByName(dir = MODELS_DIR) {
  const byName = new Map<string, string[]>();
  for await (const file of new Bun.Glob("*.toml").scan(dir)) {
    const id = file.slice(0, -".toml".length);
    if (route(id) === undefined) continue;
    const parsed = Bun.TOML.parse(await Bun.file(path.join(dir, file)).text()) as { base_model?: string };
    if (parsed.base_model === undefined) continue;
    const name = (modelMetadata(parsed.base_model) as { name?: string }).name;
    if (name === undefined) continue;
    const key = normalize(name);
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  return byName;
}

/** One entry per local file an AWS model name matches exactly. */
export function matchModels(prices: Map<string, BedrockPrice[]>, files: Map<string, string[]>): BedrockModel[] {
  const models: BedrockModel[] = [];
  for (const [name, rows] of prices) {
    for (const id of files.get(normalize(name)) ?? []) {
      models.push({ id, name, global: route(id) === "global", prices: rows });
    }
  }
  return models;
}

// Standard-tier token prices only. Service-tier multipliers, modes and limits stay hand-written. A cache write
// without a TTL in the usage type is the default TTL (5m on Anthropic, 30m on OpenAI); a second TTL such as
// Anthropic's 1h write is left as authored.
export function buildBedrockModel(model: BedrockModel, authored: ExistingModel): SyncedModel | undefined {
  const pick = (kind: BedrockPrice["kind"], longContext: boolean) => {
    const rows = model.prices.filter((row) => row.kind === kind && row.tier === "standard"
      && row.global === model.global && row.longContext === longContext
      && (kind !== "cache_write" || row.ttl === undefined || row.ttl === "30m" || row.ttl === "5m"));
    const values = [...new Set(rows.map((row) => row.usd))];
    return values.length === 1 ? values[0] : undefined;
  };
  const input = pick("input", false);
  const output = pick("output", false);
  if (input === undefined || output === undefined) return undefined;
  const cost = authored.cost ?? ({} as NonNullable<ExistingModel["cost"]>);
  const cacheRead = pick("cache_read", false);
  const cacheWrite = pick("cache_write", false);
  const next = {
    ...cost,
    input,
    output,
    ...(cost.cache_read === undefined || cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cost.cache_write === undefined || cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  } as Record<string, unknown>;
  // A long-context band only updates when the file already has one; its threshold stays as authored.
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

export const amazonBedrock = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  modelsDir: "providers/amazon-bedrock/models",
  // Prices only, for files that exist. New models and removals stay manual: the price list has no model IDs.
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
    const offers = await Promise.all(OFFERS.map(async (offer) => {
      const response = await fetch(offerURL(offer));
      if (!response.ok) throw new Error(`Bedrock price list ${offer} failed: ${response.status} ${response.statusText}`);
      return response.json();
    }));
    return { offers, files: Object.fromEntries(await localFilesByName()) };
  },
  parseModels(raw) {
    const { offers, files } = raw as { offers: unknown[]; files: Record<string, string[]> };
    const prices = new Map<string, BedrockPrice[]>();
    for (const offer of offers) for (const [name, rows] of offerPrices(offer)) prices.set(name, [...(prices.get(name) ?? []), ...rows]);
    if (prices.size === 0) throw new Error("Bedrock price list had no token prices; refusing to sync");
    return matchModels(prices, new Map(Object.entries(files)));
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    const built = buildBedrockModel(model, authored);
    return built === undefined ? undefined : { id: model.id, model: built };
  },
} satisfies SyncProvider<BedrockModel>;
