import { z } from "zod";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://ai-gateway.vercel.sh/v1/models";

const ModelType = z.enum(["language", "embedding", "image", "video", "reranking"]);

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

export const VercelModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  released: z.number().optional(),
  context_window: z.number(),
  max_tokens: z.number(),
  type: ModelType,
  tags: z.array(z.string()).optional().default([]),
  pricing: Pricing.optional(),
}).passthrough();

const VercelResponse = z.object({
  data: z.array(VercelModel),
}).passthrough();

export type VercelModel = z.infer<typeof VercelModel>;

export const vercel = {
  id: "vercel",
  name: "Vercel AI Gateway",
  modelsDir: "providers/vercel/models",
  deleteMissing: false,
  missingNotice(paths) {
    return paths.map((model) => `Vercel model is no longer returned by the API: ${model}`);
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Vercel AI Gateway request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return VercelResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (model.type === "image" || model.type === "video" || model.type === "reranking") {
      return undefined;
    }
    return {
      id: model.id,
      model: buildVercelModel(model, context.existing(model.id)),
    };
  },
  sameModel(current, desired) {
    return sameVercelModel(current, desired);
  },
} satisfies SyncProvider<VercelModel>;

export function buildVercelModel(model: VercelModel, existing: ExistingModel | undefined): SyncedModel {
  const tags = new Set(model.tags);
  const releaseDate = model.released
    ? dateFromTimestamp(model.released)
    : existing?.release_date ?? new Date().toISOString().slice(0, 10);
  const context = model.context_window > 0
    ? model.context_window
    : existing?.limit?.context ?? 0;
  const output = model.max_tokens > 0
    ? model.max_tokens
    : existing?.limit?.output ?? 0;
  const input = model.id.startsWith("openai/") && context > output
    ? context - output
    : undefined;
  const cost = buildCost(model.pricing, existing?.cost);

  const synced: SyncedFullModel = {
    name: existing?.name ?? model.name,
    family: existing?.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: new Date().toISOString().slice(0, 10),
    attachment: existing?.attachment ?? (tags.has("vision") || tags.has("file-input")),
    reasoning: existing?.reasoning ?? tags.has("reasoning"),
    reasoning_options: existing?.reasoning_options,
    temperature: true,
    tool_call: existing?.tool_call ?? tags.has("tool-use"),
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    experimental: existing?.experimental,
    provider: existing?.provider,
    cost,
    limit: { context, input, output },
    modalities: {
      input: ["text", tags.has("vision") ? "image" : undefined, tags.has("file-input") ? "pdf" : undefined]
        .filter((value): value is "text" | "image" | "pdf" => value !== undefined),
      output: tags.has("image-generation") ? ["text", "image"] : ["text"],
    },
  };

  return existing?.base_model === undefined
    ? synced
    : factorBaseModel(existing.base_model, synced, synced.limit, existing.base_model_omit);
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function buildCost(pricing: VercelModel["pricing"], existing?: ExistingModel["cost"]) {
  const input = price(pricing?.input_tiers?.[0]?.cost ?? pricing?.input);
  const output = price(pricing?.output_tiers?.[0]?.cost ?? pricing?.output);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    reasoning: existing?.reasoning,
    cache_read: price(pricing?.input_cache_read_tiers?.[0]?.cost ?? pricing?.input_cache_read),
    cache_write: price(pricing?.input_cache_write_tiers?.[0]?.cost ?? pricing?.input_cache_write),
    tiers: existing?.tiers,
  };
}

function inferFamily(modelID: string, name: string) {
  const targets = [modelID, name].map((value) => value.toLowerCase());
  const families = [...ModelFamilyValues].sort((a, b) => b.length - a.length);
  return families.find((family) => targets.some((target) => target.includes(family.toLowerCase())))
    ?? families.find((family) => targets.some((target) => isSubsequence(target, family.toLowerCase())));
}

function isSubsequence(target: string, value: string) {
  let index = 0;
  for (const character of target) {
    if (character === value[index]) index++;
  }
  return index === value.length;
}

function sameVercelModel(current: ExistingModel, desired: SyncedModel) {
  const desiredModel = desired as ExistingModel;
  const fields: Array<[unknown, unknown, boolean?]> = [
    [current.base_model, desiredModel.base_model],
    [current.base_model_omit, desiredModel.base_model_omit],
    [current.name, desiredModel.name],
    [current.family, desiredModel.family],
    [current.attachment, desiredModel.attachment],
    [current.reasoning, desiredModel.reasoning],
    [current.tool_call, desiredModel.tool_call],
    [current.structured_output, desiredModel.structured_output],
    [current.open_weights, desiredModel.open_weights],
    [current.release_date, desiredModel.release_date],
    [current.cost?.input, desiredModel.cost?.input, true],
    [current.cost?.output, desiredModel.cost?.output, true],
    [current.cost?.cache_read, desiredModel.cost?.cache_read, true],
    [current.cost?.cache_write, desiredModel.cost?.cache_write, true],
    [current.limit?.context, desiredModel.limit?.context],
    [current.limit?.input, desiredModel.limit?.input],
    [current.limit?.output, desiredModel.limit?.output],
    [current.modalities?.input, desiredModel.modalities?.input],
  ];

  return fields.every(([currentValue, desiredValue, cost]) => {
    if (cost && currentValue === 0 && desiredValue === undefined) return true;
    if (cost && typeof currentValue === "number" && typeof desiredValue === "number") {
      return Math.abs(currentValue - desiredValue) <= 0.001;
    }
    if (
      (currentValue === 0 || desiredValue === 0)
      && (typeof currentValue === "number" || typeof desiredValue === "number")
    ) {
      return true;
    }
    return JSON.stringify(currentValue) === JSON.stringify(desiredValue);
  });
}
