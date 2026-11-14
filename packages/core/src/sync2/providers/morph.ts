// Morph: https://www.morphllm.com/api/models/json?prices=list (public). `?prices=list`
// serves the direct api.morphllm.com list rates; the bare URL is Morph's
// OpenRouter provider feed (same schema, OpenRouter channel prices).
// Authoritative for the text price, cached-input price, context and output
// limit. Everything else is hand-authored from live probes (reasoning
// controls, image formats, Messages support), so new models are added by
// hand. A decision model (reflex) generates nothing: its output is free and
// its output limit stays as written. Models the feed drops are kept for review.

import { z } from "zod";

import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://www.morphllm.com/api/models/json?prices=list";

// OpenRouter endpoint names for a cataloged model: morph-dsv4flash-0731 is
// morph-dsv4flash (same weights and prices).
const ALIASES = new Set(["morph-dsv4flash-0731"]);

// Approval-only: accounts without privileged access get a 403
// (https://docs.morphllm.com/sdk/components/fast-models#deepseek-uncensored).
const RESTRICTED = new Set(["morph-dsv41flash-abliterated"]);

const Price = z.object({ type: z.string(), cost_usd: z.string() }).passthrough();

const MorphModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input_modalities: z.array(z.object({
    type: z.string(),
    supported_inputs: z.object({ max_context_length: z.object({ value: z.number().int().positive() }).passthrough() }).passthrough().optional(),
    pricing: z.array(Price).optional(),
  }).passthrough()),
  output_modalities: z.array(z.object({
    type: z.string(),
    max_length: z.object({ value: z.number().int().positive() }).passthrough().optional(),
    pricing: z.array(Price).optional(),
  }).passthrough()),
  is_ready: z.boolean().optional(),
}).passthrough();
type MorphModel = z.infer<typeof MorphModel>;

const MorphResponse = z.object({ data: z.array(MorphModel) }).passthrough();

export const morph: SyncModule<unknown> = {
  id: "morph",
  name: "Morph",
  policy: {
    owns: ["limit.context", "limit.output", "cost.text.input.price", "cost.text.input.cache.read", "cost.text.output.price"],
    creates: "gap",
    removals: "keep",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Morph models" }),
  observe(raw) {
    return MorphResponse.parse(raw).data
      .filter((model) => !ALIASES.has(model.id) && model.is_ready !== false)
      .map(observe);
  },
  // The `auto` router has no feed entry.
  manages: (id) => id !== "auto",
};

function observe(model: MorphModel): Observation {
  const text = model.input_modalities.find((modality) => modality.type === "text");
  const decisions = model.output_modalities.some((modality) => modality.type === "decisions");
  const output = model.output_modalities.find((modality) => modality.type === "text");
  const input = perMillion(text?.pricing, "prompt");
  const completion = decisions ? 0 : perMillion(output?.pricing, "completion");
  const context = text?.supported_inputs?.max_context_length.value;
  const outputLimit = decisions ? undefined : output?.max_length?.value;
  if (input === undefined || completion === undefined || context === undefined || (!decisions && outputLimit === undefined)) {
    throw new Error(`Morph model ${model.id} is missing a text price or limit in the feed`);
  }
  return {
    id: model.id,
    // Not a model most accounts can call; only an existing file is kept current.
    ...(RESTRICTED.has(model.id) ? { updateOnly: true } : {}),
    limit: { context, ...(outputLimit === undefined ? {} : { output: outputLimit }) },
    cost: { text: { input: { price: input, cache: { read: perMillion(text?.pricing, "cached_prompt") ?? null } }, output: { price: completion } } },
  };
}

// cost_usd is an exact per-token decimal.
function perMillion(pricing: z.infer<typeof Price>[] | undefined, type: string) {
  const value = pricing?.find((price) => price.type === type)?.cost_usd;
  if (value === undefined) return undefined;
  return Math.round(Number(value) * 1e15) / 1e9;
}
