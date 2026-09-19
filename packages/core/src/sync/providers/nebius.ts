import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://tokenfactory.nebius.com/api/public/models_info";

// The public models_info catalog lists each model with one or more flavors;
// every flavor is a separately served model_id on the Token Factory API, so
// flavors are the sync source models.
const NebiusFlavor = z
  .object({
    model_id: z.string().min(1),
    input_price_per_million_tokens: z.number().nonnegative().optional(),
    output_price_per_million_tokens: z.number().nonnegative().optional(),
    max_model_len: z.number().int().positive().optional(),
  })
  .passthrough();

const NebiusCatalogModel = z
  .object({
    flavors: z.array(NebiusFlavor),
  })
  .passthrough();

export const NebiusResponse = z.array(NebiusCatalogModel);

export type NebiusModel = z.infer<typeof NebiusFlavor>;

export const nebius = {
  id: "nebius",
  name: "Nebius Token Factory",
  modelsDir: "providers/nebius/models",
  // The catalog exposes pricing and the served window but no capability or
  // reasoning-control metadata, so new models are hand-authored through
  // missing-model issues instead of being created from thin data.
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return isPricedFlavor(model) ? model.model_id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} remote model(s) were not created because the public models_info catalog exposes no capability or reasoning-control metadata: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) are not present in the Nebius Token Factory catalog and were retained: ${paths.join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchNebiusModels();
  },
  parseModels(raw) {
    return NebiusResponse.parse(raw).flatMap((model) => model.flavors);
  },
  translateModel(model, context) {
    const existing = context.existing(model.model_id);
    if (existing === undefined) return undefined;
    if (!isPricedFlavor(model)) {
      // Degraded catalog entry (no pricing or served window): keep the
      // authored file untouched instead of writing partial data.
      const authored = context.authored(model.model_id);
      return authored === undefined
        ? undefined
        : { id: model.model_id, model: authored as SyncedModel };
    }
    return { id: model.model_id, model: buildNebiusModel(model, existing) };
  },
} satisfies SyncProvider<NebiusModel>;

export async function fetchNebiusModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Nebius models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isPricedFlavor(model: NebiusModel) {
  return model.input_price_per_million_tokens !== undefined
    && model.output_price_per_million_tokens !== undefined
    && model.max_model_len !== undefined;
}

export function buildNebiusModel(model: NebiusModel, existing: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  // The catalog is authoritative for token pricing and the served window
  // (max_model_len). Cache rates, output caps, reasoning options, interleaved,
  // and capability overrides are hand-researched and preserved.
  const cost = {
    ...existing.cost,
    input: model.input_price_per_million_tokens,
    output: model.output_price_per_million_tokens,
  };
  const limit = {
    ...existing.limit,
    context: model.max_model_len,
  };
  const values = {
    ...current,
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
