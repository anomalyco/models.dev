import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// `?prices=list` serves the direct api.morphllm.com list rates. The bare URL is
// Morph's OpenRouter provider feed (same schema, OpenRouter channel prices).
const API_ENDPOINT = "https://www.morphllm.com/api/models/json?prices=list";

// OpenRouter endpoint identities that alias a cataloged model: morph-dsv4flash-0731
// is the OpenRouter-facing name of morph-dsv4flash (same weights and prices).
const ALIASES = new Set(["morph-dsv4flash-0731"]);

const Price = z.object({
  type: z.string(),
  cost_usd: z.string(),
}).passthrough();

export const MorphModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input_modalities: z.array(z.object({
    type: z.string(),
    supported_inputs: z.object({
      max_context_length: z.object({ value: z.number().int().positive() }).passthrough(),
    }).passthrough().optional(),
    pricing: z.array(Price).optional(),
  }).passthrough()),
  output_modalities: z.array(z.object({
    type: z.string(),
    max_length: z.object({ value: z.number().int().positive() }).passthrough().optional(),
    pricing: z.array(Price).optional(),
  }).passthrough()),
  is_ready: z.boolean().optional(),
}).passthrough();

export const MorphResponse = z.object({
  data: z.array(MorphModel),
}).passthrough();

export type MorphModel = z.infer<typeof MorphModel>;

export const morph = {
  id: "morph",
  name: "Morph",
  modelsDir: "providers/morph/models",
  // `auto` has no feed entry, and a hidden or unready model keeps its file.
  deleteMissing: false,
  // Reasoning controls, image formats and Messages support come from live probes
  // the feed cannot express, so new IDs open an issue for a hand-authored file.
  skipCreates: true,
  sourceID(model) {
    return ALIASES.has(model.id) || model.is_ready === false ? undefined : model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Morph models were not created because their reasoning controls and input formats need hand-authored, live-probed metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchMorphModels();
  },
  parseModels(raw) {
    return MorphResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined || ALIASES.has(model.id) || model.is_ready === false) return undefined;
    // The v1 view reduces MIME types to generic kinds, which can factor a
    // hand-authored format list away against the lab file; keep it verbatim.
    const modalities = context.v2?.(model.id)?.modalities;
    return {
      id: model.id,
      model: buildMorphModel(model, existing),
      v2Set: modalities === undefined ? undefined : { modalities },
    };
  },
} satisfies SyncProvider<MorphModel>;

export async function fetchMorphModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Morph models request failed: ${response.status} ${response.statusText}`);
  }
  return MorphResponse.parse(await response.json());
}

// The feed states list price, cached-input price, context and output limit;
// everything else in the file is hand-authored and kept.
export function buildMorphModel(model: MorphModel, existing: ExistingModel): SyncedModel {
  const text = model.input_modalities.find((modality) => modality.type === "text");
  const output = model.output_modalities.find((modality) => modality.type === "text");
  const input = perMillion(text?.pricing, "prompt");
  const completion = perMillion(output?.pricing, "completion");
  const context = text?.supported_inputs?.max_context_length.value;
  if (input === undefined || completion === undefined || context === undefined || output?.max_length === undefined) {
    throw new Error(`Morph model ${model.id} is missing a text price or limit in the feed`);
  }

  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cost = {
    ...existing.cost,
    input,
    output: completion,
    cache_read: perMillion(text?.pricing, "cached_prompt"),
  };
  const limit = { ...existing.limit, context, output: output.max_length.value };
  const values = { ...current, cost, limit } as SyncedFullModel;

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

// cost_usd is an exact per-token decimal; the catalog stores USD per 1M tokens.
function perMillion(pricing: z.infer<typeof Price>[] | undefined, type: string) {
  const value = pricing?.find((price) => price.type === type)?.cost_usd;
  if (value === undefined) return undefined;
  return Math.round(Number(value) * 1e15) / 1e9;
}
