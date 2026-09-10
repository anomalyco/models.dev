import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://cloud-api.near.ai/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

const HOSTED_BY_NEAR_AI = "nearai";

const NearAIPricing = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  input_cache_read: z.string().optional(),
}).passthrough();

export const NearAIModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
  name: z.string().min(1),
  pricing: NearAIPricing,
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  supported_features: z.array(z.string()),
}).passthrough();

export const NearAIResponse = z.object({
  object: z.literal("list"),
  data: z.array(NearAIModel),
}).passthrough();

export type NearAIModel = z.infer<typeof NearAIModel>;

export const nearai = {
  id: "nearai",
  name: "NEAR AI Cloud",
  modelsDir: "providers/nearai/models",
  skipCreates: true,
  // Much of the catalog has no local entry. Those are reported in the sync
  // notice rather than filed as an issue each.
  trackMissingModels: false,
  // A truncated or degraded catalog response is indistinguishable from a
  // genuine removal, so absence never proposes a delete.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} NEAR AI models were not created because the catalog exposes no release date, knowledge cutoff, or reasoning controls, and most of them reason.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchNearAIModels();
  },
  parseModels(raw) {
    return NearAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildNearAIModel(model, existing),
    };
  },
} satisfies SyncProvider<NearAIModel>;

export async function fetchNearAIModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`NEAR AI models request failed: ${response.status} ${response.statusText}`);
  }
  return NearAIResponse.parse(await response.json());
}

function atMost(current: number | undefined, reported: number | undefined): number | undefined {
  if (current === undefined) return reported;
  if (reported === undefined) return current;
  return Math.min(current, reported);
}

// The catalog returns artifacts like 1.4000000000000001, and scaling per-token
// strings introduces its own, so every published price is rounded.
function price(value: number): number {
  return Number(value.toFixed(6));
}

// Per-token strings, unlike the per-million `input` and `output` numbers.
function perMillion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? price(parsed * TOKENS_PER_PRICING_UNIT) : undefined;
}

export function buildNearAIModel(
  model: NearAIModel,
  existing: ExistingModel,
): SyncedModel {
  if (existing.cost === undefined) {
    throw new Error(`NEAR AI model ${model.id} has incomplete local pricing required for sync`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;

  const cost = {
    ...existing.cost,
    input: price(model.pricing.input),
    output: price(model.pricing.output),
    cache_read: perMillion(model.pricing.input_cache_read) ?? existing.cost.cache_read,
  };

  // `context_length` is the serving `max_model_len` only for models NEAR AI hosts
  // itself. On relayed routes it is whatever the upstream aggregator reported and
  // is often rounded below the lab figure, so it would publish a cap the host does
  // not impose. `max_output_length` is advisory even on hosted models: requests
  // above it succeed, and only exceeding the context window is rejected. So output
  // is never synced, and context only for hosted models, capped downward.
  const limit = model.owned_by === HOSTED_BY_NEAR_AI
    ? { ...existing.limit, context: atMost(existing.limit?.context, model.context_length) }
    : existing.limit;

  const values = {
    ...current,
    // The catalog misreports capabilities in both directions: `supported_features`
    // omits reasoning for relayed models that plainly reason, and
    // `input_modalities` claims image for routes that reject it. So these two
    // flags are the only ones taken from it, and only to turn something on;
    // reasoning, modalities and attachment stay hand-authored.
    tool_call: model.supported_features.includes("tools") ? true : existing.tool_call,
    structured_output: model.supported_features.includes("structured_outputs")
      ? true
      : existing.structured_output,
    cost,
    limit,
  } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
