import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.groq.com/openai/v1/models";

const Pricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
}).passthrough();

export const GroqModel = z.object({
  id: z.string().min(1),
  active: z.boolean().optional(),
  context_window: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  pricing: Pricing.optional(),
}).passthrough();

export const GroqResponse = z.object({
  data: z.array(GroqModel),
}).passthrough();

export type GroqModel = z.infer<typeof GroqModel>;

// Speech, transcription and other non-text outputs are priced per character or
// second, which the v1 fields this sync writes can't carry. A model listed with
// no price (allam-2-7b) has nothing to sync.
function isTextModel(model: GroqModel) {
  return model.output_modalities?.length === 1 && model.output_modalities[0] === "text"
    && model.pricing?.prompt !== undefined && model.pricing.completion !== undefined;
}

export const groq = {
  id: "groq",
  name: "Groq",
  modelsDir: "providers/groq/models",
  // Reasoning efforts, service tiers, the Responses API and web search fees are
  // hand-authored, so new IDs open an issue instead of creating a file. A model
  // that drops out of the list keeps its file until someone marks it deprecated.
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return isTextModel(model) && model.active !== false ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Groq models were not created because their reasoning controls and API support need hand-authored metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchGroqModels();
  },
  parseModels(raw) {
    return GroqResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined || !isTextModel(model)) return undefined;
    // The v1 view reduces MIME types to generic kinds, which can factor a
    // hand-authored format list away against the lab file; keep it verbatim.
    const modalities = context.v2?.(model.id)?.modalities;
    return {
      id: model.id,
      model: buildGroqModel(model, existing),
      v2Set: modalities === undefined ? undefined : { modalities },
    };
  },
} satisfies SyncProvider<GroqModel>;

export async function fetchGroqModels(fetcher: typeof fetch = fetch) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is required to sync Groq");
  const response = await fetcher(API_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) {
    throw new Error(`Groq models request failed: ${response.status} ${response.statusText}`);
  }
  return GroqResponse.parse(await response.json());
}

// The list states per-token prices, the context window and the output cap;
// everything else in the file is hand-authored and kept.
export function buildGroqModel(model: GroqModel, existing: ExistingModel): SyncedModel {
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  if (input === undefined || output === undefined) {
    throw new Error(`Groq model ${model.id} is missing a text price in the list`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input,
    output,
    // The list gives every model a cache rate at half its input price, including models Groq's prompt caching page
    // doesn't support (https://console.groq.com/docs/prompt-caching). So only a cache price already in the file is updated.
    cache_read: existing.cost?.cache_read === undefined ? undefined : (perMillion(model.pricing?.input_cache_read) ?? existing.cost.cache_read),
  };
  const limit = { ...existing.limit, context: model.context_window, output: model.max_completion_tokens };
  const values = { ...current, cost, limit } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

// Prices are exact per-token decimals; the catalog stores USD per 1M tokens.
function perMillion(value: string | undefined) {
  if (value === undefined) return undefined;
  return Math.round(Number(value) * 1e15) / 1e9;
}
