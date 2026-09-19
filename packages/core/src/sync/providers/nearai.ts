import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { nearaiCuration } from "./nearai-curation.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://cloud-api.near.ai/v1/models";

const TOKENS_PER_PRICING_UNIT = 1_000_000;

const HOSTED_BY_NEAR_AI = "nearai";

const MIN_LIVE_MODELS = 20;

const LAB_NAMESPACE: Record<string, string> = {
  qwen: "alibaba",
  "x-ai": "xai",
  "z-ai": "zhipuai",
  "zai-org": "zhipuai",
  "deepseek-ai": "deepseek",
};

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
  trackMissingModels: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} NEAR AI models were not synced, because they are held off the`
        + ` catalog on purpose.`,
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
    if (existing === undefined) return createNearAIModel(model);
    if (existing.cost === undefined) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
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
  const parsed = NearAIResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `NEAR AI returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

export function labModelID(id: string): string {
  const lowered = id.toLowerCase();
  const separator = lowered.lastIndexOf("/");
  if (separator === -1) return lowered;
  const namespace = lowered.slice(0, separator);
  return `${LAB_NAMESPACE[namespace] ?? namespace}${lowered.slice(separator)}`;
}

function createNearAIModel(model: NearAIModel) {
  const curated = nearaiCuration[model.id];
  if (curated === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      "live on NEAR AI Cloud but not published: record how this route controls reasoning,"
        + " or mark it skip, in packages/core/src/sync/providers/nearai-curation.ts",
    );
  }
  if (curated.skip === true) return undefined;
  const cacheRead = perMillion(model.pricing.input_cache_read);
  return {
    id: model.id,
    header: curated.source.map((line) => `# ${line}`).join("\n"),
    model: {
      base_model: curated.base_model ?? labModelID(model.id),
      ...(curated.attachment === undefined ? {} : { attachment: curated.attachment }),
      ...(curated.reasoning_options === undefined
        ? {}
        : { reasoning_options: curated.reasoning_options }),
      ...(curated.interleaved === undefined ? {} : { interleaved: curated.interleaved }),
      ...(curated.modalities === undefined ? {} : { modalities: curated.modalities }),
      cost: {
        input: price(model.pricing.input),
        output: price(model.pricing.output),
        ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
      },
    } as SyncedModel,
  };
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

  // Only price and serving limits come from the catalog. Its capability fields are
  // wrong in both directions: `supported_features` lists reasoning for relayed
  // routes that return no reasoning content, and `input_modalities` claims image
  // for routes that reject it. Capabilities, modalities and reasoning controls
  // therefore stay hand-authored.
  const values = { ...current, cost, limit } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}
