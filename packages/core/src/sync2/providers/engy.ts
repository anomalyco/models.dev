// engy: https://api.engy.ai/v1/models (public). Authoritative for token and
// cache-read prices, input and output kinds, and the context window. engy's
// context is max input + max output, and the public list omits that split, so
// a changed window makes the model a gap for a person to re-read both from the
// authenticated https://engy.ai/api/v1/models. For the same reason new models
// are gaps. The list is unauthenticated and may come back truncated, so
// dropped models are kept for review.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.engy.ai/v1/models";

// Per-token USD, usually a string. An empty or non-numeric one fails the run
// instead of being written as a free model.
const Price = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?(e[-+]?\d+)?$/i, "engy price is not a non-negative number")]);

const EngyModel = z.object({
  id: z.string(),
  pricing: z.object({ prompt: Price.optional(), completion: Price.optional(), input_cache_read: Price.optional() }).passthrough().optional(),
  context_length: z.number().int().optional(),
  max_model_len: z.number().int().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
}).passthrough();
type EngyModel = z.infer<typeof EngyModel>;

const EngyResponse = z.object({ data: z.array(EngyModel) }).passthrough();

const KINDS = ["text", "image", "audio", "video", "pdf"];

export const engy: SyncModule<unknown> = {
  id: "engy",
  name: "engy",
  policy: {
    owns: [
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      { path: "limit.context", merge: "report" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
    ],
    creates: "gap",
    removals: "keep",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "engy models" }),
  // A row without an ID maps to no file.
  observe: (raw) => EngyResponse.parse(raw).data.filter((model) => model.id.trim() !== "").map(observe),
};

function observe(model: EngyModel): Observation {
  const input = kinds(model.input_modalities);
  const output = kinds(model.output_modalities);
  // A non-positive window is a bad row, not a smaller window.
  const context = model.context_length ?? model.max_model_len ?? 0;
  const pricing = model.pricing;
  return {
    id: model.id,
    // An absent, empty or unknown modality list means "not reported", not text-only.
    ...(input === undefined && output === undefined ? {} : { modalities: { ...(input && { input }), ...(output && { output }) } }),
    ...(context > 0 ? { limit: { context } } : {}),
    ...(pricing?.prompt === undefined || pricing.completion === undefined ? {} : {
      cost: {
        text: {
          input: { price: perMillion(pricing.prompt), ...(pricing.input_cache_read === undefined ? {} : { cache: { read: perMillion(pricing.input_cache_read) } }) },
          output: { price: perMillion(pricing.completion) },
        },
      },
    }),
  };
}

// Two wire prices pick up float error when scaled (0.00000068 * 1e6), so round to micro-dollars.
function perMillion(value: string | number) {
  return Math.round(Number(value) * 1_000_000 * 1e6) / 1e6;
}

function kinds(values: string[] | undefined) {
  if (values === undefined) return undefined;
  const result = [...new Set(values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value)))]
    .sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b))
    .map((value) => (value === "pdf" ? "application/pdf" : value));
  return result.length > 0 ? result : undefined;
}
