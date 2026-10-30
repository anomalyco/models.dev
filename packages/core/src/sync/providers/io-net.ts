import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const ENDPOINT = "https://api.intelligence.io.solutions/api/v1/models";

export const IoNetModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_window: z.number().int().positive().nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  input_token_price: z.number().finite().nonnegative().optional(),
  output_token_price: z.number().finite().nonnegative().optional(),
  cache_read_token_price: z.number().finite().nonnegative().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supports_reasoning: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
}).passthrough();

export type IoNetModel = z.infer<typeof IoNetModel>;

export function parseIoNetModels(raw: unknown): IoNetModel[] {
  const rows = z.object({ data: z.array(IoNetModel).nonempty() }).parse(raw).data;
  if (new Set(rows.map((model) => model.id)).size !== rows.length) {
    throw new Error("IO.NET returned duplicate model IDs");
  }
  return rows;
}

export async function fetchIoNetModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(ENDPOINT);
  if (!response.ok) throw new Error(`IO.NET models request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

// Per-token USD prices are converted to per-1M-token with the same rounding
// other catalog syncs use.
function price(value: number | undefined) {
  if (value === undefined) return undefined;
  return value >= 0 ? Math.round(value * 1_000_000_000_000) / 1_000_000 : undefined;
}

// Chat services are the ones quoting token prices; per-request and non-text
// offerings stay hand-authored.
function eligible(model: IoNetModel) {
  return price(model.input_token_price) !== undefined && price(model.output_token_price) !== undefined;
}

function cost(model: IoNetModel, current: ExistingModel["cost"]) {
  const result = {
    ...current,
    input: price(model.input_token_price),
    output: price(model.output_token_price),
  };
  if (result.input === undefined || result.output === undefined) throw new Error("IO.NET pricing is incomplete");
  const cacheRead = price(model.cache_read_token_price);
  // Zero placeholders are not new free-cache capabilities.
  if (cacheRead !== undefined && (cacheRead > 0 || result.cache_read !== undefined)) result.cache_read = cacheRead;
  return result as NonNullable<ExistingModel["cost"]>;
}

export function buildIoNetModel(model: IoNetModel, existing: ExistingModel, authored = existing): SyncedModel {
  const nextCost = cost(model, existing.cost);
  // Null served limits (e.g. max_tokens) preserve the authored value.
  const limit = {
    ...existing.limit,
    context: model.context_window ?? existing.limit?.context,
    output: model.max_tokens ?? existing.limit?.output,
  };
  // Only pricing and served limits are API-authoritative here. Capabilities,
  // reasoning controls, dates, descriptions, and request metadata are curated.
  const { base_model: baseModel, base_model_omit: omit, ...current } = authored;
  const values = { ...current, cost: nextCost, limit } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, omit);
}

export const ioNet = {
  id: "io-net",
  name: "IO.NET",
  modelsDir: "providers/io-net/models",
  skipCreates: true,
  trackMissingModels: true,
  // Retired and tier-gated models are not part of this serverless listing. Never delete on absence.
  deleteMissing: false,
  fetchModels: fetchIoNetModels,
  parseModels: parseIoNetModels,
  sourceID(model) {
    return eligible(model) ? model.id : undefined;
  },
  translateModel(model, context) {
    if (!eligible(model)) return undefined;
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    if (existing === undefined || authored === undefined) return undefined;
    return { id: model.id, model: buildIoNetModel(model, existing, authored) };
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `New IO.NET chat models require manual catalog review (missing-model issue fixer): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<IoNetModel>;
