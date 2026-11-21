import { z } from "zod";

import type { SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildOpenRouterModel, modelMetadata, resolveModelMetadataBaseModel, type OpenRouterModel } from "./openrouter.js";

// TrustedRouter serves OpenRouter's model ids and catalog shape, so models
// translate through the OpenRouter builder and resolve the same lab bases.
const API_ENDPOINT = "https://api.trustedrouter.com/v1/models";
const ROUTE_PREFIX = "trustedrouter/";

const Efforts = z.array(z.enum(["max", "xhigh", "high", "medium", "low", "minimal", "none"]));

export const TrustedRouterModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number(),
  // Embedding, video and decision rows can omit token context and prices.
  context_length: z.number().int().positive().nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  pricing: z.object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough(),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }).passthrough(),
  supported_parameters: z.array(z.string()),
  // Published only where OpenRouter has reasoning metadata for the id and every
  // route honors reasoning controls. Absent does not mean "no caller control":
  // it means TrustedRouter states nothing. An empty list means on/off only.
  reasoning: z.object({
    mandatory: z.boolean(),
    supported_efforts: Efforts.nullable().optional(),
  }).passthrough().optional(),
  trustedrouter: z.object({
    route_kind: z.string().nullish(),
    internal_only: z.boolean().nullish(),
    configuration_hidden: z.boolean().nullish(),
    synthetic_monitor: z.boolean().nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const TrustedRouterResponse = z.object({
  data: z.array(TrustedRouterModel).min(1, "TrustedRouter returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "TrustedRouter returned duplicate model IDs",
);

export type TrustedRouterModel = z.infer<typeof TrustedRouterModel>;

// Public, tool-capable text models. Internal, hidden and monitor rows are not
// for customers.
function publicChatModel(model: TrustedRouterModel) {
  const meta = model.trustedrouter;
  if (meta?.internal_only || meta?.configuration_hidden || meta?.synthetic_monitor) return false;
  if (model.context_length == null || model.pricing.prompt === undefined || model.pricing.completion === undefined) return false;
  return model.supported_parameters.includes("tools")
    && model.architecture.input_modalities.includes("text")
    && model.architecture.output_modalities.includes("text");
}

function toOpenRouterShape(model: TrustedRouterModel, baseModel: string): OpenRouterModel {
  // The catalog publishes no output cap, so the lab's output limit stands.
  const labOutput = (modelMetadata(baseModel).limit as { output?: number } | undefined)?.output ?? null;
  const reasoning = model.reasoning === undefined ? undefined : {
    mandatory: model.reasoning.mandatory,
    // OpenRouter reads null as every effort, and an empty list would publish an
    // empty effort control; TrustedRouter's empty or null list means on/off only.
    supported_efforts: model.reasoning.supported_efforts?.length ? model.reasoning.supported_efforts : undefined,
  };
  return {
    id: model.id,
    name: model.name,
    created: model.created,
    hugging_face_id: null,
    knowledge_cutoff: null,
    context_length: model.context_length!,
    architecture: {
      // Lab order (text first), so the MIME mapping below lines up with the v1 list.
      input_modalities: [...model.architecture.input_modalities].sort((a, b) => kindRank(a) - kindRank(b)),
      output_modalities: model.architecture.output_modalities,
    },
    pricing: {
      prompt: model.pricing.prompt!,
      completion: model.pricing.completion!,
      input_cache_read: model.pricing.input_cache_read,
      input_cache_write: model.pricing.input_cache_write,
    },
    top_provider: {
      context_length: model.top_provider.context_length,
      // A lab output cap never exceeds this row's context.
      max_completion_tokens:
        model.top_provider.max_completion_tokens ?? (labOutput === null ? null : Math.min(labOutput, model.context_length!)),
    },
    supported_parameters: supportedParameters(model, baseModel),
    reasoning,
  };
}

const REASONING_PARAMETERS = ["reasoning", "include_reasoning", "reasoning_effort"];

// A model that publishes no reasoning controls and whose lab says it does not
// reason only passes `reasoning` through; it is not a reasoner.
function supportedParameters(model: TrustedRouterModel, baseModel: string) {
  return model.reasoning === undefined && labDoesNotReason(baseModel)
    ? model.supported_parameters.filter((name) => !REASONING_PARAMETERS.includes(name))
    : model.supported_parameters;
}

// The OpenRouter builder reads a model as a reasoner when it takes either field.
function takesReasoning(model: TrustedRouterModel, baseModel: string) {
  const params = supportedParameters(model, baseModel);
  return params.includes("reasoning") || params.includes("include_reasoning");
}

// Why a reasoner's controls are not stated affirmatively, or undefined when they
// are. A row without a `reasoning` object states nothing. A mandatory object
// with no efforts is an always-on claim only when the row also refuses an
// effort; one that takes `reasoning_effort` (o3, Gemini 2.5 Pro) contradicts it.
export function unstatedReasoningControls(model: TrustedRouterModel, baseModel: string) {
  if (!takesReasoning(model, baseModel)) return undefined;
  if (model.reasoning === undefined) {
    return "TrustedRouter publishes no reasoning controls for this reasoning model; manual authoring is needed";
  }
  if (model.reasoning.mandatory && !model.reasoning.supported_efforts?.length
    && model.supported_parameters.includes("reasoning_effort")) {
    return "TrustedRouter lists no efforts but accepts reasoning_effort, so always-on is not established; manual authoring is needed";
  }
  return undefined;
}

// OpenAI GPT-5 and later (not gpt-oss), whose custom-tool formats AGENTS.md asks
// every host file to state.
export function isGpt5Plus(baseModel: string) {
  const major = /^openai\/gpt-(\d+)/.exec(baseModel)?.[1];
  return major !== undefined && Number(major) >= 5;
}

// TrustedRouter's prompt-caching guide: providers cache prompt prefixes
// automatically, and Anthropic content-block cache_control is preserved.
// A row that prices cache reads caches; Anthropic models cache only with
// explicit markers, as on other relays.
const CACHE_DOCS = "https://trustedrouter.com/docs/prompt-caching";
export function trustedRouterCache(model: TrustedRouterModel, baseModel: string) {
  if (model.pricing.input_cache_read === undefined) return undefined;
  return baseModel.startsWith("anthropic/") ? { explicit: true } : { implicit: true };
}

export const trustedrouter = {
  id: "trustedrouter",
  name: "TrustedRouter",
  modelsDir: "providers/trustedrouter/models",
  // Lab bases are resolved per model; the catalog is not a source of lab facts.
  trackMissingModels: false,
  // The header states each file's reasoning wire fields, so it follows the model.
  authoritativeHeaders: true,
  fetchModels: fetchTrustedRouterModels,
  parseModels(raw) {
    return TrustedRouterResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.id.startsWith(ROUTE_PREFIX) || publicChatModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `${ids.length} TrustedRouter models were skipped: no lab metadata in models/ to use as base_model, or a TrustedRouter route without an authored file.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  translateModel(model, context) {
    // trustedrouter/* routes (auto, zdr, e2e, ...) are TrustedRouter's own
    // routing aliases with no lab identity: while listed, authored files are
    // kept as written and new routes are left for hand authoring. A route
    // the catalog stops listing is removed like any other model.
    if (model.id.startsWith(ROUTE_PREFIX)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored };
    }
    if (!publicChatModel(model)) return undefined;
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveModelMetadataBaseModel(model.id) ?? openRouterBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    // Writing no controls claims always-on, so a reasoner is left for hand
    // authoring (an authored file is kept as written) unless TrustedRouter states
    // its controls affirmatively.
    const unstated = unstatedReasoningControls(model, baseModel);
    if (unstated !== undefined) throw new MissingReasoningOptionsError(model.id, unstated);
    const labInput = labMimeList(baseModel);
    const built = buildOpenRouterModel(toOpenRouterShape(model, baseModel), existing, baseModel);
    const options = built.reasoning_options ?? [];
    const efforts = options.find((option) => option.type === "effort");
    const cache = trustedRouterCache(model, baseModel);
    return {
      id: model.id,
      model: built,
      v2Set: {
        "modalities.input": (current: unknown) => labMimeInput(current, labInput),
        "capabilities.cache": cache,
      },
      header: "# Generated by bun models:sync trustedrouter from https://api.trustedrouter.com/v1/models.\n"
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + (options.some((option) => option.type === "toggle") ? "# Toggle: reasoning.enabled = true|false\n" : "")
        + (efforts && "values" in efforts ? `# Effort: reasoning.effort = ${efforts.values.join("|")}\n` : "")
        + (model.reasoning === undefined ? "" :
          "# Reasoning controls are TrustedRouter's published `reasoning` object (OpenRouter's request shape): OpenRouter's\n"
          + "# efforts for the model, narrowed to what the gateway honors on every route (https://trustedrouter.com/docs).\n")
        + (model.reasoning?.mandatory && options.length === 0 && takesReasoning(model, baseModel)
          ? "# Always-on: the object marks reasoning mandatory with no efforts, and the row does not take reasoning_effort.\n"
          : "")
        + (cache === undefined ? "" : "explicit" in cache
          ? `# Cache: explicit; Anthropic cache_control breakpoints pass through to the provider (${CACHE_DOCS}).\n`
          : `# Cache: implicit; the selected provider caches prompt prefixes automatically (${CACHE_DOCS}).\n`)
        + (isGpt5Plus(baseModel)
          ? "# Custom tools: freeform is left out; TrustedRouter documents no custom-tool (text/lark/regex) support and none was probed.\n"
          : "")
        + "# Mid-conversation: system_updates, effort_updates and tools.updates are unset; TrustedRouter documents none of them.\n",
    };
  },
} satisfies SyncProvider<TrustedRouterModel>;

// Same ids as OpenRouter: when the lab name doesn't resolve directly, reuse the
// base_model OpenRouter's entry for the id already points at.
const OPENROUTER_MODELS = path.join(import.meta.dir, "../../../../../providers/openrouter/models");
function openRouterBaseModel(id: string) {
  const file = path.join(OPENROUTER_MODELS, `${id}.toml`);
  if (!existsSync(file)) return undefined;
  const base = (Bun.TOML.parse(readFileSync(file, "utf8")) as { base_model?: unknown }).base_model;
  return typeof base === "string" ? base : undefined;
}


// The catalog lists generic input kinds (`image`, `pdf`, ...). Use the lab's
// exact MIME entries for each kind TrustedRouter serves, and inherit the lab's
// list when it is the same.
const KIND_PREFIX: Record<string, (mime: string) => boolean> = {
  text: (mime) => mime === "text",
  image: (mime) => mime.startsWith("image"),
  pdf: (mime) => mime === "pdf" || mime === "application/pdf",
  audio: (mime) => mime.startsWith("audio"),
  video: (mime) => mime.startsWith("video"),
};
export function labMimeInput(current: unknown, lab: string[] | undefined) {
  if (!Array.isArray(current) || lab === undefined) return current;
  const kinds = current.filter((value): value is string => typeof value === "string");
  const mapped = lab.filter((mime) => kinds.some((kind) => KIND_PREFIX[kind]?.(mime)));
  const unmatched = kinds.filter((kind) => !lab.some((mime) => KIND_PREFIX[kind]?.(mime)));
  const input = [...mapped, ...unmatched];
  return input.length === lab.length && input.every((value, index) => value === lab[index]) ? undefined : input;
}

const KIND_ORDER = ["text", "image", "pdf", "audio", "video"];
function kindRank(kind: string) {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

// The lab file's own input list, with MIME types (modelMetadata gives v1 kinds).
const LAB_MODELS = path.join(import.meta.dir, "../../../../../models");
function labMimeList(baseModel: string) {
  const file = path.join(LAB_MODELS, `${baseModel}.toml`);
  if (!existsSync(file)) return undefined;
  const lab = Bun.TOML.parse(readFileSync(file, "utf8")) as { modalities?: { input?: unknown } };
  const input = lab.modalities?.input;
  return Array.isArray(input) && input.every((value) => typeof value === "string") ? input as string[] : undefined;
}

export async function fetchTrustedRouterModels(fetcher: typeof fetch = fetch) {
  // The catalog is public; no key is sent.
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`TrustedRouter catalog request failed: ${response.status} ${response.statusText}`);
  }
  return TrustedRouterResponse.parse(await response.json());
}

function labDoesNotReason(baseModel: string) {
  return (modelMetadata(baseModel) as { reasoning?: unknown }).reasoning === false;
}
