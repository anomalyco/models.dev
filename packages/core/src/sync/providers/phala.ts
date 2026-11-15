import { z } from "zod";

import { AuthoredModelShape } from "../../schema.js";
import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://inference.phala.com/v1/models";

const TokenPrice = z.string().trim().min(1).refine(
  (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
  "Expected a finite nonnegative token price",
);

export const PhalaModel = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive(),
  output_modalities: z.array(z.string()),
  pricing: z.object({
    prompt: TokenPrice,
    completion: TokenPrice,
    input_cache_read: TokenPrice.optional(),
  }).passthrough(),
}).passthrough();

export const PhalaResponse = z.object({
  data: z.array(PhalaModel).min(1).refine(
    (models) => new Set(models.map((model) => model.id)).size === models.length,
    "Duplicate Phala model IDs",
  ),
}).passthrough();

export type PhalaModel = z.infer<typeof PhalaModel>;

export const phala = {
  id: "phala",
  name: "Phala",
  modelsDir: "providers/phala/models",
  skipCreates: true,
  sourceID(model) {
    return model.output_modalities.includes("text") ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Phala models were not created because new entries require hand-authored lab metadata and provider controls.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchPhalaModels();
  },
  parseModels(raw) {
    return PhalaResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildPhalaModel(model, existing),
    };
  },
} satisfies SyncProvider<PhalaModel>;

export async function fetchPhalaModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Phala models request failed: ${response.status} ${response.statusText}`);
  }
  return PhalaResponse.parse(await response.json());
}

// The public catalog prices are USD per token; round conversion artifacts.
function perMillion(value: string): number {
  return Number((Number(value) * 1_000_000).toFixed(9));
}

export function buildPhalaModel(model: PhalaModel, existing: ExistingModel): SyncedModel {
  if (existing.cost === undefined || existing.limit?.context === undefined) {
    throw new Error(`Phala model ${model.id} has incomplete local pricing or limits required for sync`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input: perMillion(model.pricing.prompt),
    output: perMillion(model.pricing.completion),
    cache_read: model.pricing.input_cache_read === undefined
      ? undefined
      : perMillion(model.pricing.input_cache_read),
  };
  const limit = { ...existing.limit, context: model.context_length };
  // Feature lists can be empty or omit reasoning on reasoning-capable routes.
  // Keep controls, precise modalities, output limits and API metadata authored.
  const values = { ...current, cost, limit };

  return baseModel === undefined
    ? AuthoredModelShape.omit({ id: true }).parse(values)
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
