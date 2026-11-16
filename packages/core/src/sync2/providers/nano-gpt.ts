// NanoGPT: https://nano-gpt.com/api/v1/models?detailed=true (public;
// NANO_GPT_MODELS_URL overrides it). Authoritative for token and cache prices,
// context, input and output limits, input and output kinds, tool calling,
// structured output, and reasoning with its effort levels. A field the source
// leaves out keeps the file's value. Files without a lab file also take the
// release date and open weights; new ones get a name, description and family.
// New models are created from a lab file, or standalone when the source gives
// enough; dropped models are deleted. A `systemone` table's media_input isn't
// synced (no file has one).

import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://nano-gpt.com/api/v1/models?detailed=true";

// NanoGPT accepts these exact request values, including `max`:
// https://github.com/Nano-GPT-com/nanogpt/blob/073b25b07e9af619333c679e694de664bf1ceb30/lib/utils/reasoningInput.ts#L12-L28
const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const NanoGptModel = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  context_length: z.number().int().nonnegative().nullish(),
  max_output_tokens: z.number().int().nonnegative().nullish(),
  architecture: z.object({ input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).passthrough().optional(),
  capabilities: z.object({
    vision: z.boolean().optional(),
    video_input: z.boolean().optional(),
    audio_input: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_calling: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    pdf_upload: z.boolean().optional(),
  }).passthrough().optional(),
  reasoning_efforts: z.array(ReasoningEffort).nullish(),
  open_weights: z.boolean().nullish(),
  pricing: z.object({
    prompt: z.number().nullish(),
    completion: z.number().nullish(),
    input: z.number().nullish(),
    output: z.number().nullish(),
    cacheReadInputPer1kTokens: z.number().nullish(),
    cacheWriteInputPer1kTokens: z.number().nullish(),
    note: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
type NanoGptModel = z.infer<typeof NanoGptModel>;

const NanoGptResponse = z.object({ data: z.array(NanoGptModel).min(1) }).passthrough();

const ORG_ID_NORMALIZATION: Record<string, string> = {
  nousresearch: "NousResearch",
  qwen: "qwen",
  thedrummer: "TheDrummer",
};

const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4": "anthropic/claude-opus-4-0",
  "claude-sonnet-4": "anthropic/claude-sonnet-4-0",
  "cohere/north-mini-code": "cohere/north-mini-code-1-0",
  "doubao-seed-2-0-code-preview-260215": "bytedance-seed/seed-2.0-code",
};

const VARIANT_SUFFIX = /(?::(?:thinking|none|minimal|low|medium|high|xhigh|max|\d+)|-thinking)$/i;

const KNOWN_OPEN_WEIGHT_IDS = new Set(["nex-agi/nex-n2-pro"]);

const KINDS = ["text", "audio", "image", "video", "pdf"];

let labs: Labs | undefined;

export const nanoGpt: SyncModule<unknown> = {
  id: "nano-gpt",
  name: "NanoGPT",
  policy: {
    owns: [
      { path: "name", createOnly: true },
      { path: "description", standalone: true, createOnly: true },
      { path: "family", standalone: true, createOnly: true },
      { path: "release_date", standalone: true },
      { path: "open_weights", standalone: true },
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "limit.context",
      "limit.input",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
  },
  fetch: () => fetchJSON(process.env.NANO_GPT_MODELS_URL ?? API_ENDPOINT, { source: "NanoGPT models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    return NanoGptResponse.parse(raw).data.map((model) => observe(model, labs!));
  },
};

function observe(model: NanoGptModel, labs: Labs): Observation {
  const capabilities = model.capabilities ?? {};
  const hasInput = model.architecture?.input_modalities !== undefined || hasInputCapabilities(model);
  const input = hasInput ? inputKinds(model) : undefined;
  const output = model.architecture?.output_modalities === undefined ? undefined : kinds(model.architecture.output_modalities);
  const context = positive(model.context_length);
  const outputLimit = positive(model.max_output_tokens);
  const outputsText = model.architecture?.output_modalities?.includes("text") ?? true;
  const efforts = model.reasoning_efforts;
  const reasoning = efforts != null && efforts.length > 0 ? true : capabilities.reasoning ?? (efforts != null ? true : undefined);
  const name = model.name ?? humanize(model.id);
  const hints = baseHints(model.id);
  const lab = hints.map((hint) => labs.find(hint)).find((found) => found !== undefined);
  const labLimit = lab === undefined ? undefined : labs.get(lab)?.limit as { context?: number; output?: number } | undefined;
  // A new text model without an output limit uses its context window when
  // it has no lab file, or its lab file has no output limit.
  const fallbackOutput = outputsText ? (lab === undefined ? context : labLimit?.output === undefined ? context ?? labLimit?.context : undefined) : undefined;
  const releaseDate = model.created == null || model.created <= 0 ? undefined : new Date(model.created * 1_000).toISOString().slice(0, 10);
  const openWeights = model.open_weights ?? (KNOWN_OPEN_WEIGHT_IDS.has(model.id.toLowerCase()) ? true : undefined);
  const family = inferFamily(model.id, model.name ?? "");

  return {
    id: normalizeID(model.id),
    base: lab === undefined ? [] : [lab],
    name,
    description: model.description ?? `${name} on NanoGPT.`,
    ...(family === undefined ? {} : { family: family as never }),
    ...(releaseDate === undefined ? {} : { release_date: releaseDate }),
    ...(openWeights === undefined ? {} : { open_weights: openWeights }),
    ...(input === undefined && output === undefined ? {} : { modalities: { ...(input && { input: mime(input) }), ...(output && { output: mime(output) }) } }),
    capabilities: {
      ...(capabilities.tool_calling === undefined ? {} : { tools: { supported: capabilities.tool_calling } }),
      ...(reasoning === undefined ? {} : { reasoning: reasoningTable(reasoning, efforts) }),
      ...(capabilities.structured_output === undefined ? {} : { structured_output: capabilities.structured_output }),
    },
    ...(context === undefined && outputLimit === undefined ? {} : {
      limit: { ...(context && { context, input: context }), ...(outputLimit && { output: outputLimit }) },
    }),
    ...cost(model.pricing),
    // A new file without these stated: no tools or reasoning, closed weights,
    // and an output limit of its context window.
    defaults: {
      ...(lab === undefined ? { open_weights: false, capabilities: { tools: { supported: false }, reasoning: { supported: false } } } : {}),
      ...(fallbackOutput === undefined ? {} : { limit: { output: fallbackOutput } }),
    },
  } as Observation;
}

function reasoningTable(reasoning: boolean, efforts: NanoGptModel["reasoning_efforts"]) {
  if (!reasoning) return { supported: false };
  // No effort levels listed: the file's controls stay.
  if (efforts == null || efforts.length === 0) return { supported: true };
  const order = ReasoningEffort.options;
  return { supported: true, toggle: null, effort: [...new Set(efforts)].sort((a, b) => order.indexOf(a) - order.indexOf(b)), budget: null };
}

function cost(pricing: NanoGptModel["pricing"]) {
  if (pricing === undefined || pricing.note === "varies_by_modality") return {};
  const input = pricing.input ?? pricing.prompt;
  const output = pricing.output ?? pricing.completion;
  if (!valid(input) || !valid(output)) return {};
  const read = pricing.cacheReadInputPer1kTokens;
  const write = pricing.cacheWriteInputPer1kTokens;
  // An unlisted cache price keeps the file's.
  const cache = { ...(valid(read) ? { read: price(read * 1_000) } : {}), ...(valid(write) ? { write: price(write * 1_000) } : {}) };
  return { cost: { text: { input: { price: price(input), cache }, output: { price: price(output) } } } };
}

function hasInputCapabilities(model: NanoGptModel) {
  const capabilities = model.capabilities ?? {};
  return capabilities.vision !== undefined || capabilities.audio_input !== undefined || capabilities.video_input !== undefined || capabilities.pdf_upload !== undefined;
}

function inputKinds(model: NanoGptModel) {
  const capabilities = model.capabilities ?? {};
  return kinds([
    ...model.architecture?.input_modalities ?? ["text"],
    ...(capabilities.vision ? ["image"] : []),
    ...(capabilities.audio_input ? ["audio"] : []),
    ...(capabilities.video_input ? ["video"] : []),
    ...(capabilities.pdf_upload ? ["pdf"] : []),
  ]);
}

function kinds(values: string[]) {
  const plural: Record<string, string> = { images: "image", videos: "video", audios: "audio", documents: "pdf" };
  const result = values.map((value) => value.toLowerCase()).map((value) => plural[value] ?? value).filter((value) => KINDS.includes(value));
  return [...new Set(result.length > 0 ? result : ["text"])];
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}

function normalizeID(id: string) {
  const [org, ...rest] = id.split("/");
  if (org === undefined || rest.length === 0) return id;
  const normalized = ORG_ID_NORMALIZATION[org.toLowerCase()];
  return normalized === undefined ? id : `${normalized}/${rest.join("/")}`;
}

// The ID (without a `TEE/` prefix), then without variant suffixes such as `:thinking`.
function baseHints(id: string) {
  let normalized = normalizeID(id);
  if (normalized.toLowerCase().startsWith("tee/")) normalized = normalizeID(normalized.slice("TEE/".length));
  const candidate = (value: string) => {
    const alias = BASE_MODEL_ALIASES[value.toLowerCase()];
    return alias === undefined ? labHints(value) : [alias];
  };
  let stripped = normalized;
  while (VARIANT_SUFFIX.test(stripped)) stripped = stripped.replace(VARIANT_SUFFIX, "");
  return [...new Set([...candidate(normalized), ...(stripped === normalized ? [] : candidate(stripped))])];
}

// Like the shared inferFamily, except `o` only matches before a digit (o3, o4-mini).
function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d)`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function humanize(id: string) {
  return (id.split("/").at(-1) ?? id).replace(/[:/_-]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function positive(value: number | null | undefined) {
  return value == null || value <= 0 ? undefined : value;
}

function price(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function valid(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value >= 0;
}
