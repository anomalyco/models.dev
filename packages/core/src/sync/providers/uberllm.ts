import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel, modelMetadata } from "./openrouter.js";

const API_ENDPOINT = "https://api.uberllm.dev/v1/models";

// Absence removes a file, so a truncated list that still parses must not read
// as a mass retirement. The catalog lists a few hundred chat models.
const MIN_LIVE_MODELS = 50;

// `*_usd` prices are USD in the stated unit; the unit is pinned so a change of
// unit fails the run instead of being written as a price.
const Pricing = z.object({
  unit: z.literal("1M tokens"),
  input_usd: z.number().nonnegative(),
  output_usd: z.number().nonnegative().optional(),
  cache_read_usd: z.number().nonnegative().optional(),
}).passthrough();

export const UberLLMModel = z.object({
  id: z.string().min(1),
  available: z.boolean().optional(),
  context_length: z.number().int().positive().optional(),
  pricing: Pricing,
}).passthrough();

export const UberLLMResponse = z.object({
  object: z.literal("list"),
  data: z.array(UberLLMModel),
}).passthrough();

export type UberLLMModel = z.infer<typeof UberLLMModel>;

export const uberllm = {
  id: "uberllm",
  name: "UberLLM",
  modelsDir: "providers/uberllm/models",
  // The catalog cannot express how a route controls reasoning, whether it
  // caches, or the output cap it enforces; those are probed live and
  // hand-authored, so the sync only maintains files that already exist.
  skipCreates: true,
  // The catalog lists a few hundred routes; the provider directory is a curated
  // subset, so remote-only IDs are not missing models.
  trackMissingModels: false,
  async fetchModels() {
    return fetchUberLLMModels();
  },
  parseModels(raw) {
    return UberLLMResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    // `available: false` means no seller is serving the model right now, which
    // can pass within minutes: the file is republished unchanged, neither
    // repriced nor removed. A model taken off the host leaves the list.
    if (model.available === false) {
      const authored = context.authored(model.id);
      if (authored !== undefined) return { id: model.id, model: authored as SyncedModel };
    }
    return { id: model.id, model: buildUberLLMModel(model, existing) };
  },
} satisfies SyncProvider<UberLLMModel>;

export async function fetchUberLLMModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`UberLLM models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = UberLLMResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `UberLLM returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

// The catalog owns the input and output price, the cached-input price of a
// model whose file already has one, and the context window. Everything else in
// the file is hand-authored from live probes and kept.
export function buildUberLLMModel(model: UberLLMModel, existing: ExistingModel): SyncedModel {
  if (model.pricing.output_usd === undefined) {
    throw new Error(`UberLLM model ${model.id} has no output price in the catalog`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;

  const cost = {
    ...existing.cost,
    input: price(model.pricing.input_usd),
    output: price(model.pricing.output_usd),
    // A cached-input price is only published where caching was confirmed live
    // (the file records the probe), so the catalog never adds one.
    cache_read: existing.cost?.cache_read === undefined
      ? undefined
      : price(model.pricing.cache_read_usd ?? existing.cost.cache_read),
  };

  // The served window is the catalog's, capped at the lab's: an aggregated
  // figure above what the lab documents is not published. `max_output_tokens`
  // is not enforced (65,536 is accepted where the catalog says 65,535), so the
  // output limit stays hand-authored.
  const labContext = baseModel === undefined ? undefined : labLimit(baseModel);
  const context = model.context_length === undefined
    ? existing.limit?.context
    : Math.min(model.context_length, labContext ?? model.context_length);
  const limit = { ...existing.limit, context };

  const values = { ...current, cost, limit } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

function labLimit(baseModel: string): number | undefined {
  const limit = modelMetadata(baseModel).limit as { context?: unknown } | undefined;
  return typeof limit?.context === "number" ? limit.context : undefined;
}

// The market price is quoted to micro-dollars; rounding drops float artifacts.
function price(value: number): number {
  return Number(value.toFixed(6));
}
