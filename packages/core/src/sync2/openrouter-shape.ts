// Observations for hosts whose catalog follows OpenRouter's model shape (the
// old sync's `buildOpenRouterModel`): Ambient and Cloudflare Workers AI map
// their lists onto it.

import { describeModel } from "../describe.js";
import type { Labs } from "./catalog.js";
import type { Observation, Owned } from "./types.js";
import { inferFamily } from "./units.js";

export interface OpenRouterShaped {
  id: string;
  name: string;
  created: number;
  hugging_face_id?: string | null;
  knowledge_cutoff?: string | null;
  context_length: number;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  pricing: {
    prompt?: string;
    completion?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider: { max_completion_tokens: number | null };
  supported_parameters: string[];
}

/** What an OpenRouter-shaped source speaks for. */
export const OPENROUTER_SHAPED_OWNS: Owned[] = [
  "name",
  { path: "description", createOnly: true },
  { path: "family", standalone: true, createOnly: true },
  { path: "release_date", standalone: true },
  { path: "knowledge", standalone: true },
  { path: "open_weights", standalone: true },
  { path: "modalities.input", merge: "kinds" },
  { path: "modalities.output", merge: "kinds" },
  "capabilities.tools.supported",
  "capabilities.reasoning.supported",
  "capabilities.structured_output",
  "capabilities.temperature",
  "limit.context",
  "limit.output",
  "cost.text.input.price",
  "cost.text.input.cache.read",
  "cost.text.input.cache.write",
  "cost.text.output.price",
  "cost.text.output.reasoning",
];

const KINDS = ["text", "audio", "image", "video", "pdf"];

/**
 * One OpenRouter-shaped model. `hints` are its lab candidates, best first. A
 * name is kept only where it says more than the lab's (the slug differs from
 * the lab's, or the route is `:free`); otherwise the file inherits the lab's.
 */
export function observeOpenRouterShaped(model: OpenRouterShaped, options: { id?: string; hints: string[]; labs: Labs }): Observation {
  const params = new Set(model.supported_parameters);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const input = kinds(model.architecture.input_modalities);
  const output = kinds(model.architecture.output_modalities);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const tools = params.has("tools") || params.has("tool_choice");
  const structured = params.has("structured_outputs");
  const openWeights = Boolean(model.hugging_face_id);
  const context = model.context_length;
  const outputLimit = model.top_provider.max_completion_tokens ?? undefined;
  const family = inferFamily(model.id, name);
  const lab = options.hints.map((hint) => options.labs.find(hint)).find((found) => found !== undefined);
  const keepName = lab === undefined || model.id.endsWith(":free") || slug(model.id.split("/").slice(1).join("/").replace(/:free$/, "")) !== slug(lab.split("/").slice(1).join("/"));
  const releaseDate = new Date(model.created * 1000).toISOString().slice(0, 10);
  return {
    id: options.id ?? model.id,
    base: lab === undefined ? [] : [lab],
    name: keepName ? name : null,
    description: describeModel({
      id: model.id,
      name,
      family,
      reasoning,
      tool_call: tools,
      structured_output: structured,
      open_weights: openWeights,
      limit: { context, output: outputLimit ?? context },
      modalities: { input: input as never, output: output as never },
    }),
    ...(family === undefined ? {} : { family: family as never }),
    release_date: releaseDate,
    ...(model.knowledge_cutoff == null ? {} : { knowledge: model.knowledge_cutoff.slice(0, 10) }),
    open_weights: openWeights,
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: tools },
      reasoning: { supported: reasoning },
      structured_output: structured,
      temperature: params.has("temperature"),
    },
    limit: { context, ...(outputLimit === undefined ? {} : { output: outputLimit }) },
    ...(prompt === undefined || completion === undefined ? {} : {
      cost: {
        text: {
          input: { price: prompt, cache: { read: price(model.pricing.input_cache_read) ?? null, write: price(model.pricing.input_cache_write) ?? null } },
          output: { price: completion, reasoning: (reasoning ? price(model.pricing.internal_reasoning) : undefined) ?? null },
        },
      },
    }),
    defaults: { limit: { output: context } },
  } as Observation;
}

function slug(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}
