import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Public model catalog behind https://docs.modular.com/models (no auth).
const API_ENDPOINT = process.env.MODULAR_CATALOG_URL ?? "https://console.modular.com/api/v1/docs/models";

const TokenPrice = z.string().regex(/^\d+(?:\.\d+)?$/);

export const ModularModel = z.object({
  model_id: z.string().min(1),
  // The ID the API serves (GET https://api.modular.com/v1/models). Empty for
  // models without a public route.
  gateway_model_id: z.string(),
  shared_endpoint: z.boolean(),
  billing_type: z.string().min(1),
  // Per-token prices. Models that are not sold on the shared endpoint carry "0".
  pricing: z.object({
    input: TokenPrice.optional(),
    output: TokenPrice.optional(),
    cached_input: TokenPrice.optional(),
  }).passthrough(),
}).passthrough();

export const ModularResponse = z.object({
  models: z.array(ModularModel),
}).passthrough();

export type ModularModel = z.infer<typeof ModularModel>;

export const modular = {
  id: "modular",
  name: "Modular",
  modelsDir: "providers/modular/models",
  // Context limits and reasoning controls are measured against the API, not
  // published in the catalog, so new models are added by hand.
  skipCreates: true,
  trackMissingModels: false,
  // A model can drop out of the catalog's public set while it is still served
  // (catalog edits lag deployments), so absence is not treated as retirement.
  deleteMissing: false,
  sourceID(model) {
    return isPublic(model) ? model.gateway_model_id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Modular models were not created because the public catalog does not publish exact context limits or reasoning controls.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchModularModels();
  },
  parseModels(raw) {
    const models = ModularResponse.parse(raw).models;
    if (!models.some(isPublic)) throw new Error("Modular returned no public models; refusing to sync an empty model catalog");
    return models;
  },
  translateModel(model, context) {
    if (!isPublic(model)) return undefined;
    const existing = context.existing(model.gateway_model_id);
    if (existing === undefined) return undefined;
    return {
      id: model.gateway_model_id,
      model: buildModularModel(model, existing),
    };
  },
} satisfies SyncProvider<ModularModel>;

export async function fetchModularModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Modular models request failed: ${response.status} ${response.statusText}`);
  }
  return ModularResponse.parse(await response.json());
}

// Public: sold on the shared pay-as-you-go endpoint, with a served ID and a
// non-zero token price.
export function isPublic(model: ModularModel) {
  return model.shared_endpoint
    && model.gateway_model_id !== ""
    && model.billing_type === "token"
    && (perMillion(model.pricing.input) ?? 0) > 0
    && (perMillion(model.pricing.output) ?? 0) > 0;
}

function perMillion(value: string | undefined) {
  return value === undefined ? undefined : Math.round(Number(value) * 1_000_000_000_000) / 1_000_000;
}

export function buildModularModel(
  model: ModularModel,
  existing: ExistingModel,
): SyncedModel {
  if (existing.cost === undefined || existing.limit === undefined) {
    throw new Error(`Modular model ${model.gateway_model_id} has incomplete local pricing or limits required for sync`);
  }

  // Only prices are authoritative here. The catalog's context window is
  // rounded display text ("1M"), and its modalities are incomplete.
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input: perMillion(model.pricing.input)!,
    output: perMillion(model.pricing.output)!,
    cache_read: perMillion(model.pricing.cached_input),
  };
  const values = { ...current, cost } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, existing.limit, baseModelOmit);
}
