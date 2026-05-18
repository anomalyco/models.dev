import { z } from "zod";

import { ModelFamilyValues } from "../../src/family.js";
import type { ExistingModel, SyncProvider } from "../sync-models.js";

const API_ENDPOINT = "https://ai-gateway.vercel.sh/v1/models";

enum ModelType {
  Language = "language",
  Embedding = "embedding",
  Image = "image",
  Video = "video",
  Reranking = "reranking",
}

const PricingTier = z.object({
  cost: z.string(),
  min: z.number(),
  max: z.number().optional(),
});

const Pricing = z.object({
  input: z.string().optional(),
  output: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_tiers: z.array(PricingTier).optional(),
  output_tiers: z.array(PricingTier).optional(),
  input_cache_read_tiers: z.array(PricingTier).optional(),
  input_cache_write_tiers: z.array(PricingTier).optional(),
}).passthrough();

const VercelModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  released: z.number().optional(),
  context_window: z.number(),
  max_tokens: z.number(),
  type: z.nativeEnum(ModelType),
  tags: z.array(z.string()).optional().default([]),
  pricing: Pricing.optional(),
}).passthrough();

const VercelResponse = z.object({
  data: z.array(VercelModel),
}).passthrough();

type VercelModel = z.infer<typeof VercelModel>;
type PricingTier = z.infer<typeof PricingTier>;

export const vercel = {
  id: "vercel",
  name: "Vercel AI Gateway",
  modelsDir: "providers/vercel/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Vercel request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return VercelResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (
      model.type === ModelType.Image ||
      model.type === ModelType.Video ||
      model.type === ModelType.Reranking
    ) {
      return undefined;
    }

    return {
      id: model.id,
      model: buildModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<VercelModel>;

function timestampToDate(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function baseTier(tiers: PricingTier[] | undefined) {
  return tiers?.find((tier) => tier.min === 0) ?? tiers?.[0];
}

function tierAt(tiers: PricingTier[] | undefined, min: number) {
  return tiers?.find((tier) => tier.min === min);
}

function contextTierSize(min: number) {
  return min > 0 && min % 1_000 === 1 ? min - 1 : min;
}

function buildCost(model: VercelModel, existing: ExistingModel | undefined) {
  const pricing = model.pricing;
  if (pricing === undefined) return existing?.cost;

  const inputPrice = price(baseTier(pricing.input_tiers)?.cost ?? pricing.input);
  const outputPrice = price(baseTier(pricing.output_tiers)?.cost ?? pricing.output)
    ?? (model.type === ModelType.Embedding ? 0 : undefined);
  const cacheRead = price(baseTier(pricing.input_cache_read_tiers)?.cost ?? pricing.input_cache_read);
  const cacheWrite = price(baseTier(pricing.input_cache_write_tiers)?.cost ?? pricing.input_cache_write);

  if (inputPrice === undefined || outputPrice === undefined) return existing?.cost;

  const tierMins = new Set<number>();
  for (const tiers of [
    pricing.input_tiers,
    pricing.output_tiers,
    pricing.input_cache_read_tiers,
    pricing.input_cache_write_tiers,
  ]) {
    for (const tier of tiers ?? []) {
      if (tier.min > 0) tierMins.add(tier.min);
    }
  }

  const tiers = [...tierMins]
    .sort((a, b) => a - b)
    .map((min) => {
      const tierInput = price(tierAt(pricing.input_tiers, min)?.cost) ?? inputPrice;
      const tierOutput = price(tierAt(pricing.output_tiers, min)?.cost) ?? outputPrice;
      const tierCacheRead = price(tierAt(pricing.input_cache_read_tiers, min)?.cost) ?? cacheRead;
      const tierCacheWrite = price(tierAt(pricing.input_cache_write_tiers, min)?.cost) ?? cacheWrite;

      return {
        tier: { size: contextTierSize(min) },
        input: tierInput,
        output: tierOutput,
        cache_read: tierCacheRead,
        cache_write: tierCacheWrite,
      };
    });

  return {
    input: inputPrice,
    output: outputPrice,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

function inferFamily(modelId: string, modelName: string) {
  const target = `${modelId} ${modelName}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function inputModalities(tags: string[]) {
  const tagSet = new Set(tags);
  return ["text", ...(tagSet.has("vision") ? ["image"] : []), ...(tagSet.has("file-input") ? ["pdf"] : [])];
}

function outputModalities(type: ModelType, tags: string[]) {
  const tagSet = new Set(tags);
  if (type === ModelType.Image || tagSet.has("image-generation")) return ["text", "image"];
  if (type === ModelType.Video) return ["text", "video"];
  return ["text"];
}

function buildModel(model: VercelModel, existing: ExistingModel | undefined) {
  const tags = new Set(model.tags);
  const releaseDate = model.released !== undefined
    ? timestampToDate(model.released)
    : (existing?.release_date ?? timestampToDate(model.created));
  const context = model.context_window > 0
    ? model.context_window
    : (existing?.limit?.context ?? 0);
  const output = model.max_tokens > 0
    ? model.max_tokens
    : (existing?.limit?.output ?? 0);
  const cost = buildCost(model, existing);

  return {
    name: existing?.name ?? model.name,
    family: existing?.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: existing?.attachment ?? (tags.has("vision") || tags.has("file-input")),
    reasoning: existing?.reasoning ?? tags.has("reasoning"),
    temperature: true,
    tool_call: existing?.tool_call ?? tags.has("tool-use"),
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit: {
      context,
      input: model.id.startsWith("openai/") && context > output ? context - output : existing?.limit?.input,
      output,
    },
    modalities: {
      input: inputModalities(model.tags),
      output: outputModalities(model.type, model.tags),
    },
  };
}
