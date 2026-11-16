// xAI: https://api.x.ai/v1/{language,image-generation,video-generation}-models (XAI_API_KEY,
// which must carry the api-key:model:* ACL so the list isn't filtered).
// Token prices, the long-context tier, the prompt limit and modality kinds are
// authoritative. The API has no output limits or capability flags, so new models
// are added by hand. Alias IDs only update a file filed under the alias.
// The Voice APIs aren't in any models endpoint, so their files are left alone.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { round } from "../units.js";

const API_BASE = "https://api.x.ai/v1";
const ENDPOINTS = ["language-models", "image-generation-models", "video-generation-models"];
const UNLISTED = new Set(["grok-tts", "grok-voice-3.0", "grok-voice-transcribe-2.0"]);

const price = z.number().int().nonnegative().optional();
const XAIModel = z.object({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  prompt_text_token_price: price,
  cached_prompt_text_token_price: price,
  completion_text_token_price: price,
  prompt_text_token_price_long_context: price,
  cached_prompt_text_token_price_long_context: price,
  completion_text_token_price_long_context: price,
  long_context_threshold: price,
  max_prompt_length: price,
}).passthrough();
type XAIModel = z.infer<typeof XAIModel>;

export const XAIResponse = z.object({ models: z.array(XAIModel) });

export const xai: SyncModule<unknown> = {
  id: "xai",
  name: "xAI",
  policy: {
    owns: [
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
      "limit.context",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
    ],
    creates: "gap",
    removals: "delete",
  },
  manages: (id) => !UNLISTED.has(id),
  async fetch() {
    const key = requireEnv("xAI", "XAI_API_KEY");
    const { acls } = z.object({ acls: z.array(z.string()) }).parse(await fetchJSON(`${API_BASE}/api-key`, { source: "xAI api-key", headers: bearer(key) }));
    if (!acls.includes("api-key:model:*")) {
      throw new Error("xAI sync requires XAI_API_KEY to include api-key:model:* so the model list is not ACL-filtered");
    }
    const lists = await Promise.all(ENDPOINTS.map(async (endpoint) =>
      XAIResponse.parse(await fetchJSON(`${API_BASE}/${endpoint}`, { source: `xAI ${endpoint}`, headers: bearer(key) })).models));
    return { models: lists.flat() };
  },
  observe(raw) {
    const models = XAIResponse.parse(raw).models;
    const seen = new Set<string>();
    const observations: Observation[] = [];
    for (const model of models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      observations.push(observe(model));
    }
    for (const model of models) {
      for (const alias of model.aliases ?? []) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        observations.push({ ...observe(model), id: alias, updateOnly: true });
      }
    }
    return observations;
  },
};

// Prices are in units of 1/10,000 USD per 1M tokens.
const perMillion = (value: number | undefined) => (value === undefined ? undefined : round(value / 10_000));

function observe(model: XAIModel): Observation {
  return { id: model.id, modalities: modalities(model), limit: { context: model.max_prompt_length }, cost: cost(model) };
}

const KINDS = new Set(["text", "audio", "image", "video", "pdf"]);

// Text models that take images also take PDFs, which the API doesn't list.
function modalities(model: XAIModel) {
  const kinds = (values: string[] | undefined) => [...new Set((values ?? []).map((value) => value.toLowerCase()).filter((value) => KINDS.has(value)))];
  const output = kinds(model.output_modalities);
  const input = kinds(model.input_modalities);
  if (output.includes("text") && input.includes("image")) input.push("pdf");
  const mime = (values: string[]) => values.map((value) => (value === "pdf" ? "application/pdf" : value));
  return {
    ...(input.length > 0 ? { input: mime(input) } : {}),
    ...(output.length > 0 ? { output: mime(output) } : {}),
  };
}

// Image and video models list no token prices; their files keep theirs.
function cost(model: XAIModel): Observation["cost"] {
  const input = perMillion(model.prompt_text_token_price);
  const output = perMillion(model.completion_text_token_price);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = perMillion(model.cached_prompt_text_token_price);
  const tier = longContext(model);
  return {
    text: {
      input: {
        price: input,
        cache: { read: cacheRead ?? null },
        ...(tier === undefined ? {} : { overrides: tier && [{ when: tier.when, price: tier.input, ...(tier.cacheRead === undefined ? {} : { cache: { read: tier.cacheRead } }) }] }),
      },
      output: {
        price: output,
        ...(tier === undefined ? {} : { overrides: tier && [{ when: tier.when, price: tier.output }] }),
      },
    },
  };
}

// The long-context band: prompts of at least `long_context_threshold` tokens
// (docs.x.ai/developers/pricing) are billed at the long-context rates. A
// threshold of 0 means there is none (null); a missing threshold or price
// leaves the file's band alone (undefined). A long-context price of 0 means
// the same as the base price.
function longContext(model: XAIModel) {
  const size = model.long_context_threshold;
  if (size === undefined) return undefined;
  if (size === 0) return null;
  const longInput = model.prompt_text_token_price_long_context;
  const longOutput = model.completion_text_token_price_long_context;
  if (longInput === undefined || longOutput === undefined) return undefined;
  const input = perMillion(longInput || model.prompt_text_token_price);
  const output = perMillion(longOutput || model.completion_text_token_price);
  if (input === undefined || output === undefined) return undefined;
  return {
    when: { context: { gte: size } },
    input,
    output,
    cacheRead: perMillion(model.cached_prompt_text_token_price_long_context || model.cached_prompt_text_token_price),
  };
}
