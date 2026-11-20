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
  // The model ID some usage types carry (`moonshotai.kimi-k3` in `USE1-moonshotai.kimi-k3-mantle-input-tokens-standard`).
  usageID?: string;
  mantle?: boolean;
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

// Marketplace models: `USE1-MP:USE1_cache_write_tokens_1h_long_ctx_global_standard-Units`.
const MARKETPLACE = /_(input|output|cache_read|cache_write)_tokens(?:_(\d+[mh]))?(_long_ctx)?(_global)?_([a-z]+)-Units$/;
// Amazon-sold models: `USE1-<name>[-mantle]-<kind>-tokens[-<modifier>...]`, where name is a display slug
// (`Llama3-3-70B`) or a model ID (`deepseek.v3.2`), and modifiers come in any order.
const FIRST_PARTY = /^[A-Z0-9]+-(.+?)-(mantle-)?(input|output|cache-read|cache-write)(?:-input)?-tokens?(?:-count)?((?:-[a-z0-9]+)*)$/;
const TIERS = new Set(["standard", "flex", "priority", "batch", "ultrafast"]);

// Older marketplace models (Claude 4.x, Palmyra): `USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units`.
const MARKETPLACE_COUNT = /_(input|output|cacheread|cachewrite(1h)?)(?:input)?tokencount((?:_[a-z]+)*)-units$/i;

export function parseUsageType(usageType: string): Omit<BedrockPrice, "usd"> | undefined {
  const count = MARKETPLACE_COUNT.exec(usageType);
  if (count !== null) {
    const kinds: Record<string, BedrockPrice["kind"]> = { input: "input", output: "output", cacheread: "cache_read", cachewrite: "cache_write", cachewrite1h: "cache_write" };
    const modifiers = count[3]!.split("_").filter((part) => part !== "").map((part) => part.toLowerCase());
    // Only on-demand standard and global rows; batch, latency-optimized and anything else are other products.
    if (modifiers.some((part) => part !== "global")) return undefined;
    return {
      kind: kinds[count[1]!.toLowerCase()]!,
      ...(count[2] === undefined ? {} : { ttl: "1h" }),
      longContext: false,
      global: modifiers.includes("global"),
      tier: "standard",
    };
  }
  const marketplace = MARKETPLACE.exec(usageType);
  if (marketplace !== null) {
    return {
      kind: marketplace[1] as BedrockPrice["kind"],
      ...(marketplace[2] === undefined ? {} : { ttl: marketplace[2] }),
      longContext: marketplace[3] !== undefined,
      global: marketplace[4] !== undefined,
      tier: marketplace[5]!,
    };
  }
  const firstParty = FIRST_PARTY.exec(usageType);
  if (firstParty === null) return undefined;
  const modifiers = firstParty[4]!
    .replace("-long-ctx", "-longctx")
    .replace("-cross-region-global", "-global")
    .split("-")
    .filter((part) => part !== "");
  let ttl: string | undefined;
  let longContext = false;
  let global = false;
  let tier = "standard";
  for (const part of modifiers) {
    if (/^\d+[mh]$/.test(part)) ttl = part;
    else if (part === "longctx") longContext = true;
    else if (part === "global") global = true;
    else if (TIERS.has(part)) tier = part;
    // custom-model, latency-optimized and anything unknown aren't on-demand token prices for a catalog model.
    else return undefined;
  }
  const name = firstParty[1]!;
  return {
    ...(name.includes(".") ? { usageID: name } : {}),
    mantle: firstParty[2] !== undefined,
    kind: firstParty[3]!.replace("-", "_") as BedrockPrice["kind"],
    ...(ttl === undefined ? {} : { ttl }),
    longContext,
    global,
    tier,
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
        const scale = dimension.unit === "1M tokens" ? 1 : dimension.unit === "1K tokens" ? 1000 : undefined;
        if (scale === undefined) continue;
        const usd = Number(dimension.pricePerUnit.USD) * scale;
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
  if (/^(eu|apac|jp|au|ca|in|us-gov)\./.test(id)) return undefined;
  return "regional";
}

// Names compare without punctuation, the word "instruct", a ".0" minor version or a vendor prefix, so AWS's
// "Qwen3 Coder 30B A3B", "Nova 2.0 Lite" and "R1" match the labs' "Qwen3-Coder 30B-A3B Instruct", "Nova 2 Lite" and
// "DeepSeek-R1".
export const normalize = (name: string) => name
  .toLowerCase()
  .replace(/[-_()]/g, " ")
  .replace(/\binstruct\b/g, " ")
  .replace(/(\d)\.0\b/g, "$1")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/^(openai|anthropic|amazon|meta|mistral|cohere|writer|deepseek)\s+/, "");

export interface LocalFile {
  id: string;
  // The normalized lab name, or undefined when the file has no `base_model`.
  name?: string;
}

/** Local files this offer can price, with their lab model's normalized name. */
export async function localFiles(dir = MODELS_DIR): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for await (const file of new Bun.Glob("*.toml").scan(dir)) {
    const id = file.slice(0, -".toml".length);
    if (route(id) === undefined) continue;
    const parsed = Bun.TOML.parse(await Bun.file(path.join(dir, file)).text()) as { base_model?: string; name?: string };
    const name = parsed.base_model === undefined ? parsed.name : (modelMetadata(parsed.base_model) as { name?: string }).name;
    files.push({ id, ...(name === undefined ? {} : { name: normalize(name) }) });
  }
  return files;
}

const stem = (id: string) => id.replace(/^(global|us)\./, "");

/**
 * Price rows per local file: rows whose usage type names the file's model ID, otherwise rows of the AWS model whose
 * name matches the file's lab name (leaving out Mantle rows, which carry their own IDs).
 */
export function matchModels(prices: Map<string, BedrockPrice[]>, files: LocalFile[]): BedrockModel[] {
  const all = [...prices].flatMap(([name, rows]) => rows.map((row) => ({ name, row })));
  const models: BedrockModel[] = [];
  for (const file of files) {
    const byID = all.filter(({ row }) => row.usageID === stem(file.id));
    const byName = byID.length > 0 || file.name === undefined
      ? []
      : all.filter(({ name, row }) => normalize(name) === file.name && row.mantle !== true);
    const rows = byID.length > 0 ? byID : byName;
    if (rows.length === 0) continue;
    models.push({ id: file.id, name: rows[0]!.name, global: route(file.id) === "global", prices: rows.map(({ row }) => row) });
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
    return { offers, files: await localFiles() };
  },
  parseModels(raw) {
    const { offers, files } = raw as { offers: unknown[]; files: LocalFile[] };
    const prices = new Map<string, BedrockPrice[]>();
    for (const offer of offers) for (const [name, rows] of offerPrices(offer)) prices.set(name, [...(prices.get(name) ?? []), ...rows]);
    if (prices.size === 0) throw new Error("Bedrock price list had no token prices; refusing to sync");
    return matchModels(prices, files);
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    const built = buildBedrockModel(model, authored);
    return built === undefined ? undefined : { id: model.id, model: built };
  },
} satisfies SyncProvider<BedrockModel>;
