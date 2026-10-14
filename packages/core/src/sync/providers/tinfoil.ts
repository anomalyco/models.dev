import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://inference.tinfoil.sh/v1/models";

const TinfoilPricing = z.object({
  inputTokenPricePer1M: z.number().nonnegative(),
  outputTokenPricePer1M: z.number().nonnegative(),
  cachedInputTokenPricePer1M: z.number().nonnegative().optional(),
  requestPrice: z.number().nonnegative().optional(),
}).passthrough();

export const TinfoilModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  owned_by: z.literal("tinfoil"),
  name: z.string().min(1),
  created: z.number().int().nonnegative(),
  context_window: z.number().int().positive().optional(),
  pricing: TinfoilPricing,
  reasoning: z.boolean(),
  tool_calling: z.boolean(),
  multimodal: z.boolean(),
  type: z.string().min(1),
}).passthrough();

export const TinfoilResponse = z.object({
  object: z.literal("list"),
  data: z.array(TinfoilModel),
}).passthrough();

export type TinfoilModel = z.infer<typeof TinfoilModel>;

export const tinfoil = {
  id: "tinfoil",
  name: "Tinfoil",
  modelsDir: "providers/tinfoil/models",
  skipCreates: true,
  sourceID(model) {
    return isRepresentableTokenModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Tinfoil models were not created because the public catalog does not expose enough metadata to author a complete provider model safely.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchTinfoilModels();
  },
  parseModels(raw) {
    return TinfoilResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildTinfoilModel(model, existing),
    };
  },
} satisfies SyncProvider<TinfoilModel>;

export async function fetchTinfoilModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Tinfoil models request failed: ${response.status} ${response.statusText}`);
  }
  return TinfoilResponse.parse(await response.json());
}

function isRepresentableTokenModel(model: TinfoilModel) {
  return model.context_window !== undefined
    && ["chat", "embedding", "safety"].includes(model.type)
    && (
      model.pricing.inputTokenPricePer1M > 0
      || model.pricing.outputTokenPricePer1M > 0
    );
}

export function buildTinfoilModel(
  model: TinfoilModel,
  existing: ExistingModel,
): SyncedModel {
  if (existing.cost === undefined || existing.limit?.context === undefined) {
    throw new Error(`Tinfoil model ${model.id} has incomplete local pricing or limits required for sync`);
  }
  if (model.reasoning && existing.reasoning_options === undefined) {
    throw new Error(`Tinfoil model ${model.id} requires hand-authored reasoning_options; the catalog exposes no reasoning controls`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input: model.pricing.inputTokenPricePer1M,
    output: model.pricing.outputTokenPricePer1M,
    cache_read: model.pricing.cachedInputTokenPricePer1M,
  };
  const limit = {
    ...existing.limit,
    context: model.context_window ?? existing.limit.context,
  };
  const values = {
    ...current,
    reasoning: model.reasoning,
    reasoning_options: model.reasoning ? existing.reasoning_options : undefined,
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
