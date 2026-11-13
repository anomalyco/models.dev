import { z } from "zod";

import type { SyncProvider } from "../index.js";

const API_ENDPOINT = "https://api.sintaks.dev/v1/models";

const SintaksModel = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  pricing: z.object({
    input_usd_per_1m: z.number().nonnegative().optional(),
    output_usd_per_1m: z.number().nonnegative().optional(),
  }).optional(),
}).passthrough();

const SintaksResponse = z.object({ data: z.array(SintaksModel) }).passthrough();
export type SintaksModel = z.infer<typeof SintaksModel>;

// Missing rows can be malformed active records, and new rows lack the lab
// identity and per-model reasoning controls needed to create a catalog file.
export const sintaksDev = {
  id: "sintaks-dev",
  name: "Sintaks.dev",
  modelsDir: "providers/sintaks-dev/models",
  deleteMissing: false,
  skipCreates: true,
  trackMissingModels: false,
  sourceID(model) { return model.id; },
  async fetchModels() { return fetchSintaksModels(); },
  parseModels(raw) { return parseSintaksModels(raw); },
  translateModel(model, context) {
    const current = context.v2?.(model.id);
    if (current === undefined) return undefined;
    const resolved = context.existing(model.id);
    const v2 = structuredClone(current);
    const cost = v2.cost as Record<string, unknown> | undefined;
    const text = cost?.text as Record<string, unknown> | undefined;
    // Omitted price fields mean unknown, not free. Update only rates the
    // gateway actually reported and that the existing file already models.
    for (const [direction, price] of [
      ["input", model.pricing?.input_usd_per_1m],
      ["output", model.pricing?.output_usd_per_1m],
    ] as const) {
      const entry = text?.[direction] as Record<string, unknown> | undefined;
      if (entry !== undefined && price !== undefined) entry.price = price;
    }
    if (model.context_window !== undefined) {
      const limit = (v2.limit ??= {}) as Record<string, unknown>;
      limit.context = model.context_window;
      // A completion cannot exceed its total context. Keep a smaller existing
      // output cap, but never publish an inherited cap above the host limit.
      const output = typeof limit.output === "number" ? limit.output : resolved?.limit?.output;
      if (output !== undefined && output > model.context_window) limit.output = model.context_window;
    }
    return { id: model.id, v2 };
  },
} satisfies SyncProvider<SintaksModel>;

export async function fetchSintaksModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) throw new Error(`Sintaks.dev models request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export function parseSintaksModels(raw: unknown): SintaksModel[] {
  const models = SintaksResponse.parse(raw).data;
  if (models.length === 0) throw new Error("Sintaks.dev returned an empty model list");
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Duplicate Sintaks.dev model ID: ${model.id}`);
    seen.add(model.id);
  }
  return models;
}
