import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.sambanova.ai/v1/models";

// Prices are per-token strings, e.g. "0.00000280" for 2.80 USD/MTok.
const Pricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
}).passthrough();

export const SambaNovaModel = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  pricing: Pricing.optional(),
}).passthrough();

const SambaNovaResponse = z.object({
  data: z.array(SambaNovaModel).min(1),
}).passthrough();

export type SambaNovaModel = z.infer<typeof SambaNovaModel>;

// A price the feed states, in USD per million tokens. Zero is a real price
// (free), so only an absent or unparseable value returns undefined.
function perMillion(price: string | undefined) {
  if (price === undefined) return undefined;
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000 * 100) / 100;
}

export function parseSambaNovaModels(raw: unknown) {
  return SambaNovaResponse.parse(raw).data;
}

export async function fetchSambaNovaModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`SambaNova models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// The sync owns served-set membership, limits, and per-token pricing from
// /v1/models, including clearing a cached-input rate the feed stops listing.
// Reasoning controls, modalities, structured output, cache, status, and header
// evidence comments stay hand-authored (see sync.md).
export function buildSambaNovaModel(
  model: SambaNovaModel,
  existing: ExistingModel,
): SyncedModel {
  const pricing = model.pricing;
  const input = perMillion(pricing?.prompt);
  const output = perMillion(pricing?.completion);
  const cost = input !== undefined && output !== undefined
    ? {
      ...existing.cost,
      input,
      output,
      cache_read: perMillion(pricing?.input_cache_read),
    }
    : existing.cost;
  const limit = {
    context: model.context_length,
    input: existing.limit?.input,
    output: model.max_completion_tokens,
  };

  const base = existing.base_model;
  if (base === undefined) return { ...existing, cost, limit } as SyncedModel;
  const { base_model: _base, base_model_omit: _omit, ...values } = existing;
  return factorBaseModel(base, { ...values, cost, limit }, limit, existing.base_model_omit);
}

export const sambaNova = {
  id: "sambanova",
  name: "SambaNova",
  modelsDir: "providers/sambanova/models",
  deleteMissing: true,
  async fetchModels() {
    return fetchSambaNovaModels();
  },
  parseModels: parseSambaNovaModels,
  // A remote-only ID needs hand-authored metadata (canonical model, reasoning
  // controls, modalities), so it is reported as a missing model instead of
  // created from the inventory alone.
  missingModelID(model) {
    return model.id;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return { id: model.id, model: buildSambaNovaModel(model, existing) };
  },
} satisfies SyncProvider<SambaNovaModel>;