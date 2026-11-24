import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel, SyncedV2Model } from "../index.js";
import { modelMetadata } from "./openrouter.js";

// AWS's public price list, no key. Foundation models sold through Bedrock (Anthropic, OpenAI, Cohere, ...) are in
// AmazonBedrockFoundationModels; Amazon's own and open-weight models are in AmazonBedrock.
// https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-ppslong.html
const OFFERS = ["AmazonBedrockFoundationModels", "AmazonBedrock"];
const REGION = "us-east-1";
const offerURL = (offer: string, region = REGION) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offer}/current/${region}/index.json`;
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


// Embedding, speech and video models, priced per token, image or second. The price list names them in its own words
// (some Titan rows have no model at all), so each file lists the usage types of its prices, with the AWS model name
// where a marketplace usage type is shared between models. The prices replace the file's v2 cost at each path;
// everything else stays hand-written, and files for other geographies (eu., ...) aren't in these offers.
// Usage types are written without their region prefix: `USE1-MP:USE1_InputTokenCount-Units` is `MP:InputTokenCount-Units`.
export interface MediaPrice {
  usage: string;
  // The price list's unit, compared case-insensitively, and what one unit costs as a multiple of the catalog price.
  unit: string;
  scale: number;
}

export interface MediaFile {
  offer: "AmazonBedrock" | "AmazonBedrockFoundationModels";
  region: "us-east-1" | "us-west-2";
  model?: string;
  prices: Record<string, MediaPrice>;
}

const perK = (usage: string): MediaPrice => ({ usage, unit: "1K tokens", scale: 1000 });
const perM = (usage: string): MediaPrice => ({ usage, unit: "1M tokens", scale: 1 });
const each = (usage: string, unit: string): MediaPrice => ({ usage, unit, scale: 1 });

const sonic = (name: string): MediaFile["prices"] => ({
  "cost.text.input.price": perK(`${name}-text-input-tokens`),
  "cost.text.output.price": perK(`${name}-text-output-tokens`),
  "cost.audio.input.price": perK(`${name}-speech-input-tokens`),
  "cost.audio.output.price": perK(`${name}-speech-output-tokens`),
});
const embedV4: MediaFile = { offer: "AmazonBedrockFoundationModels", region: "us-east-1", model: "Embed v4", prices: { "cost.text.input.price": perM("MP:InputTokenCount-Units") } };
const marengoImage = { "cost.image.input.price": each("MP:InputImageCount-Units", "Input Images") };

export const MEDIA_FILES: Record<string, MediaFile> = {
  "amazon.titan-embed-text-v1": { offer: "AmazonBedrock", region: "us-east-1", prices: { "cost.text.input.price": perK("TitanEmbeddingsG1-Text-input-tokens") } },
  "amazon.titan-embed-text-v2:0": { offer: "AmazonBedrock", region: "us-east-1", prices: { "cost.text.input.price": perK("TitanEmbeddingV2-Text-input-tokens") } },
  "amazon.titan-embed-image-v1": {
    offer: "AmazonBedrock",
    region: "us-east-1",
    prices: {
      "cost.text.input.price": perK("TitanEmbeddingsG1-Image-input-tokens"),
      "cost.image.input.price": each("TitanEmbeddingsG1-Image-input-image", "Images Processed"),
    },
  },
  "amazon.nova-2-multimodal-embeddings-v1:0": {
    offer: "AmazonBedrock",
    region: "us-east-1",
    prices: {
      "cost.text.input.price": perK("NovaMultiModalEmbeddings-input-tokens"),
      "cost.image.input.price": each("NovaMultiModalEmbeddings-input-standard-image", "Images Processed"),
      "cost.video.input.price": each("NovaMultiModalEmbeddings-input-video-second", "seconds"),
      "cost.audio.input.price": each("NovaMultiModalEmbeddings-input-audio-second", "seconds"),
    },
  },
  "amazon.nova-2-sonic-v1:0": { offer: "AmazonBedrock", region: "us-east-1", prices: sonic("NovaSonic2.0") },
  "amazon.nova-2-5-sonic": { offer: "AmazonBedrock", region: "us-east-1", prices: sonic("NovaSonic2.5") },
  ...Object.fromEntries(["Embed English", "Embed Multilingual"].map((model) => [
    `cohere.${model.toLowerCase().replace(" ", "-")}-v3`,
    {
      offer: "AmazonBedrockFoundationModels",
      region: "us-east-1",
      model,
      prices: { "cost.text.input.price": perM("MP:InputTokenCount-Units"), "cost.image.input.price": each("MP:InputImageCount-Units", "Input Images") },
    } satisfies MediaFile,
  ])),
  "cohere.embed-v4:0": embedV4,
  "us.cohere.embed-v4:0": embedV4,
  "twelvelabs.marengo-embed-3-0-v1:0": {
    offer: "AmazonBedrockFoundationModels",
    region: "us-east-1",
    model: "Marengo Embed 3.0",
    prices: {
      ...marengoImage,
      "cost.video.input.price": each("MP:inputVideoSecond-Units", "seconds"),
      "cost.audio.input.price": each("MP:inputAudioSecond-Units", "seconds"),
    },
  },
  "us.twelvelabs.marengo-embed-3-0-v1:0": { offer: "AmazonBedrockFoundationModels", region: "us-east-1", model: "Marengo Embed 3.0", prices: marengoImage },
  "luma.ray-v2:0": {
    offer: "AmazonBedrockFoundationModels",
    region: "us-west-2",
    model: "Ray v2",
    prices: {
      // 720p, the base price; the file's first override is 540p.
      "cost.video.output.price": each("MP:videoMediumFpsHdRes-Units", "seconds"),
      "cost.video.output.overrides.0.price": each("MP:videoMediumFpsStandardRes-Units", "seconds"),
    },
  },
};

const MEDIA_OFFERS = [...new Set(Object.values(MEDIA_FILES).map((file) => `${file.offer}/${file.region}`))];

export interface OfferRow {
  model?: string;
  usage: string;
  unit: string;
  usd: number;
}

/** Every on-demand price row of an offer file, with its usage type's region prefix removed. */
export function offerRows(raw: unknown): OfferRow[] {
  const offer = Offer.parse(raw);
  const rows: OfferRow[] = [];
  for (const product of Object.values(offer.products)) {
    const usageType = product.attributes.usagetype;
    if (usageType === undefined) continue;
    const usage = usageType.replace(/^[A-Z0-9]+-/, "").replace(/^MP:[A-Z0-9]+_/, "MP:");
    for (const term of Object.values(offer.terms.OnDemand[product.sku] ?? {})) {
      for (const dimension of Object.values(term.priceDimensions)) {
        rows.push({ model: product.attributes.model, usage, unit: dimension.unit, usd: Number(dimension.pricePerUnit.USD) });
      }
    }
  }
  return rows;
}

export interface BedrockMediaModel {
  id: string;
  media: true;
  // Catalog prices by v2 path, or what's missing when a row isn't in the price list exactly once.
  prices: Record<string, number>;
  missing: string[];
}

/** Catalog prices for each media file, from the rows of the offer it's priced in. */
export function mediaModels(rows: Map<string, OfferRow[]>, files: Record<string, MediaFile> = MEDIA_FILES): BedrockMediaModel[] {
  return Object.entries(files).map(([id, file]) => {
    const offerRows = rows.get(`${file.offer}/${file.region}`) ?? [];
    const prices: Record<string, number> = {};
    const missing: string[] = [];
    for (const [pricePath, price] of Object.entries(file.prices)) {
      const matches = offerRows.filter((row) => row.usage === price.usage
        && (file.model === undefined || row.model === file.model)
        && row.unit.toLowerCase() === price.unit.toLowerCase());
      const values = [...new Set(matches.map((row) => Number((row.usd * price.scale).toFixed(6))))];
      if (values.length === 1 && Number.isFinite(values[0])) prices[pricePath] = values[0]!;
      else missing.push(`${pricePath} (${file.offer} ${file.region} ${file.model ?? ""} ${price.usage}: ${values.length} prices)`);
    }
    return { id, media: true as const, prices, missing };
  });
}

function setPath(target: Record<string, unknown>, dotted: string, value: number) {
  const keys = dotted.split(".");
  let node: Record<string, unknown> = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) return false;
    node = next as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
  return true;
}

/** The file's v2 body with its media prices replaced, or undefined when a price or its place in the file is missing. */
export function buildMediaModel(model: BedrockMediaModel, file: Record<string, unknown> | undefined): SyncedV2Model | undefined {
  if (file === undefined || model.missing.length > 0) return undefined;
  const v2 = structuredClone(file);
  for (const [pricePath, price] of Object.entries(model.prices)) if (!setPath(v2, pricePath, price)) return undefined;
  return { id: model.id, v2 };
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
  sourceNotices(models) {
    return models.flatMap((model) => "media" in model && model.missing.length > 0
      ? [`Bedrock price list is missing prices for ${model.id}, so its file is unchanged: ${model.missing.join("; ")}`]
      : []);
  },
  skippedNotice() {
    return [];
  },
  missingNotice() {
    return [];
  },
  async fetchModels() {
    const keys = [...new Set([...OFFERS.map((offer) => `${offer}/${REGION}`), ...MEDIA_OFFERS])];
    const offers = Object.fromEntries(await Promise.all(keys.map(async (key) => {
      const [offer, region] = key.split("/") as [string, string];
      const response = await fetch(offerURL(offer, region));
      if (!response.ok) throw new Error(`Bedrock price list ${key} failed: ${response.status} ${response.statusText}`);
      return [key, await response.json()] as const;
    })));
    return { offers, files: await localFiles() };
  },
  parseModels(raw) {
    const { offers, files } = raw as { offers: Record<string, unknown>; files: LocalFile[] };
    const prices = new Map<string, BedrockPrice[]>();
    for (const offer of OFFERS) {
      for (const [name, rows] of offerPrices(offers[`${offer}/${REGION}`])) prices.set(name, [...(prices.get(name) ?? []), ...rows]);
    }
    if (prices.size === 0) throw new Error("Bedrock price list had no token prices; refusing to sync");
    const rows = new Map(Object.entries(offers).map(([key, offer]) => [key, offerRows(offer)]));
    return [...matchModels(prices, files.filter((file) => MEDIA_FILES[file.id] === undefined)), ...mediaModels(rows)];
  },
  translateModel(model, context) {
    if ("media" in model) return buildMediaModel(model, context.v2?.(model.id));
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    const built = buildBedrockModel(model, authored);
    return built === undefined ? undefined : { id: model.id, model: built };
  },
} satisfies SyncProvider<BedrockModel | BedrockMediaModel>;
