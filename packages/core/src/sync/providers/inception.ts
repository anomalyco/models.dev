import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const ENDPOINT = "https://api.inceptionlabs.ai/v1/models";

const Price = z.string().regex(/^\d+(?:\.\d+)?$/);

export const InceptionPricing = z.object({
  prompt: Price.optional(),
  completion: Price.optional(),
  input_cache_reads: Price.optional(),
  input_cache_writes: Price.optional(),
}).passthrough();

export const InceptionModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_length: z.number().int().positive().optional(),
  max_output_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  pricing: InceptionPricing.optional(),
  supported_endpoints: z.array(z.string()).optional(),
}).passthrough();

export type InceptionModel = z.infer<typeof InceptionModel>;

export function parseInceptionModels(raw: unknown): InceptionModel[] {
  const rows = z.object({ data: z.array(InceptionModel).nonempty() }).parse(raw).data;
  if (new Set(rows.map((model) => model.id)).size !== rows.length) {
    throw new Error("Inception returned duplicate model IDs");
  }
  return rows;
}

export async function fetchInceptionModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(ENDPOINT);
  if (!response.ok) throw new Error(`Inception models request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

// Prices are per-token USD strings; convert to per-1M-token with the same
// rounding other catalog syncs use.
function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

// Only chat-completion routes are representable as chat models. `mercury-decide`
// is a decisions-endpoint preview and stays out of the catalog.
function eligible(model: InceptionModel) {
  const endpoints = model.supported_endpoints;
  return (endpoints === undefined || endpoints.includes("chat.completions"))
    && price(model.pricing?.prompt) !== undefined
    && price(model.pricing?.completion) !== undefined;
}

function cost(model: InceptionModel, current: ExistingModel["cost"]) {
  const result = {
    ...current,
    input: price(model.pricing?.prompt),
    output: price(model.pricing?.completion),
  };
  if (result.input === undefined || result.output === undefined) throw new Error("Inception pricing is incomplete");
  for (const [field, source] of [["cache_read", "input_cache_reads"], ["cache_write", "input_cache_writes"]] as const) {
    const amount = price(model.pricing?.[source]);
    // Zero placeholders are not new free-cache capabilities.
    if (amount !== undefined && (amount > 0 || result[field] !== undefined)) result[field] = amount;
  }
  return result as NonNullable<ExistingModel["cost"]>;
}

export function buildInceptionModel(model: InceptionModel, existing: ExistingModel, authored = existing): SyncedModel {
  const nextCost = cost(model, existing.cost);
  const limit = {
    ...existing.limit,
    context: model.context_length ?? existing.limit?.context,
    output: model.max_output_length ?? existing.limit?.output,
  };
  // Only pricing and served limits are API-authoritative here. Capabilities,
  // reasoning controls, dates, descriptions, and request metadata are curated.
  const { base_model: baseModel, base_model_omit: omit, ...current } = authored;
  const values = { ...current, cost: nextCost, limit } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, omit);
}

export const inception = {
  id: "inception",
  name: "Inception",
  modelsDir: "providers/inception/models",
  skipCreates: true,
  trackMissingModels: true,
  // The edit model is not part of this chat catalog. Never delete on absence.
  deleteMissing: false,
  fetchModels: fetchInceptionModels,
  parseModels: parseInceptionModels,
  sourceID(model) {
    return eligible(model) ? model.id : undefined;
  },
  translateModel(model, context) {
    if (!eligible(model)) return undefined;
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    if (existing === undefined || authored === undefined) return undefined;
    return { id: model.id, model: buildInceptionModel(model, existing, authored) };
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `New Inception chat models require manual catalog review (missing-model issue fixer): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<InceptionModel>;
