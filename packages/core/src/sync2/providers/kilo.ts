// Kilo Gateway: https://api.kilo.ai/api/gateway/models (KILO_API_KEY optional),
// an OpenRouter-shaped catalog. Authoritative for token, cache, reasoning and
// web search prices, context and output limits, input and output kinds,
// temperature, tool calling, structured output and whether a model reasons,
// with the effort levels Kilo's OpenCode variants list. A display name is
// kept current where a file sets its own. Files without a lab file also take
// the source's release date, knowledge cutoff and open weights. New models get
// the source's description. Routes Kilo serves as unavailable stubs (negative
// prices, no parameters) keep their files as they are. New models are created
// from a lab file; dropped models are deleted.

import { z } from "zod";

import { describeModel } from "../../describe.js";
import { bearer, fetchJSON } from "../http.js";
import { namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";
import { inferFamily } from "../units.js";

const API_ENDPOINT = "https://api.kilo.ai/api/gateway/models";
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const KINDS = ["text", "audio", "image", "video", "pdf"];

const KiloModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  description: z.string().optional(),
  hugging_face_id: z.string().nullable().optional(),
  knowledge_cutoff: z.string().nullable().optional(),
  context_length: z.number(),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }).passthrough(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    // USD per web search.
    web_search: z.string().optional(),
  }).passthrough(),
  top_provider: z.object({ context_length: z.number().nullable(), max_completion_tokens: z.number().nullable() }).passthrough(),
  supported_parameters: z.array(z.string()),
  opencode: z.object({
    variants: z.record(z.object({ reasoning: z.object({ enabled: z.boolean(), effort: z.string().optional() }).optional() }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();
type KiloModel = z.infer<typeof KiloModel>;

const KiloResponse = z.object({ data: z.array(KiloModel) }).passthrough();

export const kilo: SyncModule<unknown> = {
  id: "kilo",
  name: "Kilo",
  policy: {
    owns: [
      { path: "name", merge: "refresh" },
      { path: "description", createOnly: true },
      { path: "family", standalone: true, createOnly: true },
      { path: "release_date", standalone: true },
      { path: "knowledge", standalone: true },
      { path: "open_weights", standalone: true },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "capabilities.temperature",
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
      "cost.text.output.reasoning",
      "cost.web_search",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => {
    const key = process.env.KILO_API_KEY;
    return fetchJSON(API_ENDPOINT, { source: "Kilo models", headers: key ? bearer(key) : {} });
  },
  observe: (raw) => KiloResponse.parse(raw).data.map(observe),
};

function observe(model: KiloModel): Observation {
  // Kilo serves unavailable routes as stubs: negative prices and no
  // parameters. Their files are kept as written.
  if (model.supported_parameters.length === 0 || Number(model.pricing.prompt) < 0 || Number(model.pricing.completion) < 0) {
    return { id: model.id, updateOnly: true };
  }
  const params = new Set(model.supported_parameters);
  const input = kinds(model.architecture.input_modalities);
  const output = kinds(model.architecture.output_modalities);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const efforts = reasoning ? variantEfforts(model.opencode?.variants) : undefined;
  const context = model.top_provider.context_length ?? model.context_length;
  const outputLimit = model.top_provider.max_completion_tokens ?? undefined;
  const tools = params.has("tools") || params.has("tool_choice");
  const structured = params.has("structured_outputs");
  const openWeights = Boolean(model.hugging_face_id);
  const family = inferFamily(model.id, model.name);
  const webSearch = webSearchPrice(model.pricing.web_search);
  return {
    id: model.id,
    base: namespaceHints(model.id),
    name: model.name,
    description: model.description?.replaceAll(/\s+/g, " ").trim() ?? describeModel({
      id: model.id,
      name: model.name,
      family,
      reasoning,
      tool_call: tools,
      structured_output: structured,
      open_weights: openWeights,
      limit: { context, output: outputLimit ?? context },
      modalities: { input: input as never, output: output as never },
    }),
    ...(family === undefined ? {} : { family: family as never }),
    release_date: new Date(model.created * 1000).toISOString().slice(0, 10),
    ...(model.knowledge_cutoff == null ? {} : { knowledge: model.knowledge_cutoff.slice(0, 10) }),
    open_weights: openWeights,
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: tools },
      // Kilo's OpenCode variants list the effort levels; without them the file's controls stay.
      reasoning: reasoning
        ? { supported: true, ...(efforts === undefined ? {} : { toggle: null, effort: efforts as never, budget: null }) }
        : { supported: false },
      structured_output: structured,
      temperature: params.has("temperature"),
    },
    limit: { context, ...(outputLimit === undefined ? {} : { output: outputLimit }) },
    ...(prompt === undefined || completion === undefined ? {} : {
      cost: {
        text: {
          input: { price: prompt, cache: { read: price(model.pricing.input_cache_read) ?? null, write: price(model.pricing.input_cache_write) ?? null } },
          // Reasoning tokens are billed whenever the model reasons.
          output: { price: completion, reasoning: price(model.pricing.internal_reasoning) ?? null },
        },
        web_search: webSearch === undefined ? null : { price: webSearch },
      },
    }),
  };
}

// Effort levels from the variants: each enabled variant's effort, and `none`
// when one turns reasoning off.
function variantEfforts(variants: NonNullable<KiloModel["opencode"]>["variants"]) {
  if (variants === undefined) return undefined;
  const entries = Object.values(variants);
  if (entries.length === 0) return undefined;
  const efforts = entries.filter((variant) => variant.reasoning?.enabled === true).map((variant) => variant.reasoning?.effort).filter((effort): effort is string => effort !== undefined);
  const all = [...new Set(entries.some((variant) => variant.reasoning?.enabled === false) ? [...efforts, "none"] : efforts)];
  if (all.length === 0) return undefined;
  const rank = (effort: string) => (EFFORT_ORDER.includes(effort) ? EFFORT_ORDER.indexOf(effort) : Number.MAX_SAFE_INTEGER);
  return all.sort((a, b) => rank(a) - rank(b));
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000_000_000) / 1_000_000 : undefined;
}

// USD per search as USD per 1,000; zero is no price.
function webSearchPrice(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000 * 1e6) / 1e6 : undefined;
}

function kinds(values: string[]) {
  const result = values.map((value) => value.toLowerCase()).map((value) => (value === "file" ? "pdf" : value)).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}
