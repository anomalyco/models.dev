// Cortecs: https://api.cortecs.ai/v1/models (public). Prices are EUR per 1M
// tokens, converted at 1.114 USD per EUR (the rate the files use, 2026-07-30).
// Authoritative for token and cache prices, input and output kinds, context
// and output limits, tool calling and structured output (`json_mode`). Whether
// a model reasons comes from the source only on files without a base_model.
// New models are created from a lab file; dropped models are deleted.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.cortecs.ai/v1/models";
const EUR_TO_USD = 1.114;

// Cortecs IDs whose lab ID is spelled differently.
const BASE_MODEL_EXCEPTIONS: Record<string, string> = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4-0",
};

const KINDS = ["text", "audio", "image", "video", "pdf"];

const CortecsModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  description: z.string().optional(),
  pricing: z.object({
    currency: z.literal("EUR"),
    input_token: z.number().nonnegative(),
    output_token: z.number().nonnegative(),
    cache_read_cost: z.number().nonnegative().optional(),
    cache_write_cost: z.number().nonnegative().optional(),
  }).passthrough(),
  context_size: z.number().int().positive(),
  max_output_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).default(["text"]),
  output_modalities: z.array(z.string()).default(["text"]),
  supported_features: z.array(z.string()).default([]),
}).passthrough();
type CortecsModel = z.infer<typeof CortecsModel>;

const CortecsResponse = z.object({ object: z.literal("list"), data: z.array(CortecsModel) }).passthrough();

export const cortecs: SyncModule<unknown> = {
  id: "cortecs",
  name: "Cortecs",
  policy: {
    owns: [
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      { path: "capabilities.reasoning.supported", standalone: true },
      "capabilities.structured_output",
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Cortecs models" }),
  observe: (raw) => CortecsResponse.parse(raw).data.map(observe),
};

function observe(model: CortecsModel): Observation {
  const features = new Set(model.supported_features);
  const { pricing } = model;
  return {
    id: model.id,
    base: baseHints(model.id),
    modalities: { input: kinds(model.input_modalities), output: kinds(model.output_modalities) },
    capabilities: {
      tools: { supported: features.has("tools") },
      reasoning: { supported: features.has("reasoning") },
      structured_output: features.has("json_mode"),
    },
    limit: { context: model.context_size, output: model.max_output_tokens ?? model.context_size },
    cost: {
      text: {
        input: {
          price: usd(pricing.input_token),
          // An unlisted cache price leaves the file's.
          cache: { ...(pricing.cache_read_cost === undefined ? {} : { read: usd(pricing.cache_read_cost) }), ...(pricing.cache_write_cost === undefined ? {} : { write: usd(pricing.cache_write_cost) }) },
        },
        output: { price: usd(pricing.output_token) },
      },
    },
  };
}

function usd(eur: number) {
  return Math.round(eur * EUR_TO_USD * 1_000) / 1_000;
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])].map((value) => (value === "pdf" ? "application/pdf" : value));
}

// Anthropic models are named family-last (`claude-4-5-sonnet`) or run
// together (`claude-opus4-5`) here.
function baseHints(id: string) {
  const exception = BASE_MODEL_EXCEPTIONS[id];
  if (exception !== undefined) return labHints(exception);
  const trailing = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/.exec(id);
  if (trailing !== null) return labHints(`anthropic/claude-${trailing[3]}-${trailing[1]}-${trailing[2]}`);
  const compact = /^claude-(opus|sonnet|haiku)(\d+)-(\d+)$/.exec(id);
  if (compact !== null) return labHints(`anthropic/claude-${compact[1]}-${compact[2]}-${compact[3]}`);
  return labHints(id);
}
