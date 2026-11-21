import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Public catalog, no key: https://inference-docs.cerebras.ai/api-reference/models
const API_ENDPOINT = process.env.CEREBRAS_MODELS_URL ?? "https://api.cerebras.ai/public/v1/models";

// Per-token USD prices as decimal strings.
const TokenPrice = z.string().regex(/^\d+(?:\.\d+)?(?:e-?\d+)?$/i);

export const CerebrasModel = z.object({
  id: z.string().min(1),
  pricing: z.object({ prompt: TokenPrice, completion: TokenPrice }).passthrough(),
  deprecated: z.boolean().default(false),
}).passthrough();

export const CerebrasResponse = z.object({
  object: z.literal("list"),
  data: z.array(CerebrasModel),
}).passthrough();

export type CerebrasModel = z.infer<typeof CerebrasModel>;

const perMillion = (value: string) => Number((Number(value) * 1_000_000).toFixed(6));

// Only token prices are synced. The public catalog reports free-tier limits (Qwen 3.8 27B: 65,536 context where paid
// tiers get 131,072), so limits, controls and capabilities stay hand-written. Cached input is billed at the input
// rate (https://inference-docs.cerebras.ai/capabilities/prompt-caching), so a listed cache read follows the input price.
export function buildCerebrasModel(model: CerebrasModel, authored: ExistingModel): SyncedModel {
  const input = perMillion(model.pricing.prompt);
  const output = perMillion(model.pricing.completion);
  const cost = {
    ...authored.cost,
    input,
    output,
    ...(authored.cost?.cache_read === undefined ? {} : { cache_read: input }),
  };
  return { ...authored, cost } as SyncedModel;
}

export const cerebras = {
  id: "cerebras",
  name: "Cerebras",
  modelsDir: "providers/cerebras/models",
  // New models need hand-written limits and reasoning controls, so they're reported instead of created.
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.deprecated ? undefined : model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} Cerebras catalog models have no local file: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [`${paths.length} local Cerebras models are missing from the public catalog and were retained: ${paths.map((path) => `\`${path}\``).join(", ")}`];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Cerebras models request failed: ${response.status} ${response.statusText}`);
    return response.json();
  },
  parseModels(raw) {
    const models = CerebrasResponse.parse(raw).data;
    if (models.length === 0) throw new Error("Cerebras returned no models; refusing to sync an empty catalog");
    return models;
  },
  translateModel(model, context) {
    if (model.deprecated) return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: buildCerebrasModel(model, authored) };
  },
} satisfies SyncProvider<CerebrasModel>;
