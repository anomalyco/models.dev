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

// The public catalog lists about 600 rows (2026-11-25). Absence deletes a
// generated file, so a response under half that is treated as truncated, not
// as a mass retirement (the NEAR AI sync guards the same way).
export const MIN_LIVE_MODELS = 300;

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
      input_modalities: labDocumentedKinds(model.architecture.input_modalities, labMimeList(baseModel))
        .sort((a, b) => kindRank(a) - kindRank(b)),
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
  if (!takesReasoning(model, baseModel)) {
    // The OpenRouter builder would write a non-reasoner. A row that omits the
    // reasoning fields states nothing, so it never overrides a lab that reasons.
    return labReasons(baseModel)
      ? "TrustedRouter's row omits reasoning, but the lab model reasons; manual authoring is needed"
      : undefined;
  }
  if (model.reasoning === undefined) {
    return "TrustedRouter publishes no reasoning controls for this reasoning model; manual authoring is needed";
  }
  if (model.reasoning.mandatory && !model.reasoning.supported_efforts?.length
    && model.supported_parameters.includes("reasoning_effort")) {
    return "TrustedRouter lists no efforts but accepts reasoning_effort, so always-on is not established; manual authoring is needed";
  }
  // OpenAI's API takes reasoning_effort on every o-series model, so a mandatory
  // object with no efforts there (o3-pro) is a gap in the metadata, not always-on.
  if (model.reasoning.mandatory && !model.reasoning.supported_efforts?.length && /^openai\/o\d/.test(baseModel)) {
    return "TrustedRouter lists no efforts for this OpenAI o-series model, whose API takes reasoning_effort, so always-on is not established; manual authoring is needed";
  }
  return undefined;
}

// Live probes of POST https://api.trustedrouter.com/v1/chat/completions, the
// evidence AGENTS.md asks for where the catalog states nothing (or contradicts
// itself) about reasoning. Each model got a request with no reasoning fields,
// reasoning.enabled = false, reasoning.enabled = true, every reasoning.effort the
// lab or same-id peers list, and an invalid effort ("banana"), and reasoning was
// read from usage.completion_tokens_details.reasoning_tokens and the returned
// reasoning text. The object below stands in for the row's `reasoning` object:
// - toggle: reasoning.enabled = false returned no reasoning while the default or
//   reasoning.enabled = true returned it. Efforts are not published where the
//   invalid effort was accepted too and token use did not follow the level.
// - efforts: the provider validated reasoning.effort (the invalid value came back
//   400/422 naming the accepted values), so the field reaches it; `none` is listed
//   only where it returned no reasoning.
// - always-on (mandatory, no efforts): reasoning came back on every request,
//   reasoning.enabled = false was ignored or rejected, and an invalid effort was
//   accepted with no change in reasoning, so the caller has no control.
// Models whose probes were inconclusive or failed to route stay held back. A
// probe applies only while the row is unstated or contradictory: when the
// catalog states well-formed controls, they are used instead.
export const PROBED = "2026-11-24";
type Effort = z.infer<typeof Efforts>[number];
export interface ProbedReasoning {
  mandatory: boolean;
  supported_efforts?: Effort[];
  /** What the probe showed, for the file header. */
  note: string;
}
const TOGGLE = (route: string): ProbedReasoning => ({
  mandatory: false,
  note: `reasoning.enabled = false returned no reasoning and reasoning.enabled = true returned reasoning (routed to ${route}); `
    + "efforts are not published: an invalid effort was accepted and reasoning did not follow the level",
});
const ALWAYS_ON = (route: string, off = "reasoning.enabled = false still returned reasoning"): ProbedReasoning => ({
  mandatory: true,
  note: `Always-on: reasoning came back on every request (routed to ${route}); ${off}, and an invalid effort was accepted with no change`,
});
export const PROBED_REASONING: Record<string, ProbedReasoning> = {
  "deepseek/deepseek-v3.1": TOGGLE("deepinfra"),
  "deepseek/deepseek-v4-flash-0731-fast": TOGGLE("venice"),
  "deepseek/deepseek-v4-pro-0423": TOGGLE("deepinfra"),
  "deepseek/deepseek-v4.1-flash-fast": TOGGLE("baseten"),
  "moonshotai/kimi-k3-fast": TOGGLE("fireworks"),
  "nvidia/nemotron-3.5-super-vl-120b-a12b": TOGGLE("baseten"),
  "qwen/qwen3-omni-30b-a3b-thinking": TOGGLE("novita"),
  "qwen/qwen3-vl-plus": TOGGLE("novita"),
  "qwen/qwen3.5-flash": TOGGLE("atlas-cloud"),
  "qwen/qwen3.5-plus": TOGGLE("atlas-cloud"),
  "qwen/qwen3.7-plus": TOGGLE("atlas-cloud"),
  "z-ai/glm-5.2-fast": TOGGLE("baseten"),
  "z-ai/glm-5.3-fast": TOGGLE("baseten"),
  "openai/o3": {
    mandatory: true,
    supported_efforts: ["high", "medium", "low"],
    note: "reasoning.enabled = false returned 400 (\"this model cannot turn reasoning off\"); low, medium and high were accepted and an "
      + "invalid effort returned OpenAI's 400 listing the accepted values (routed to openai; this route reports no reasoning token count)",
  },
  "mistralai/mistral-large-4": {
    mandatory: true,
    supported_efforts: ["high", "medium", "low"],
    note: "low, medium and high were accepted with reasoning returned; none and an invalid effort returned Mistral's 422 listing "
      + "high, low and medium, and reasoning.enabled = false was rejected (routed to mistral)",
  },
  "inception/mercury-3": {
    mandatory: false,
    supported_efforts: ["high", "medium", "low", "none"],
    note: "none returned no reasoning and low, medium and high returned reasoning; an invalid effort returned Inception's 400 "
      + "listing instant, low, medium and high; reasoning.enabled = false was ignored, so there is no separate toggle (routed to inception)",
  },
  "qwen/qwen3.6-flash": {
    mandatory: false,
    supported_efforts: ["xhigh", "high", "medium", "low", "minimal", "none"],
    note: "none and minimal returned no reasoning and low to xhigh returned reasoning; an invalid effort and max returned Alibaba's 400 "
      + "listing none, minimal, low, medium, high and xhigh; reasoning.enabled = false was ignored, so there is no separate toggle (routed to alibaba)",
  },
  "qwen/qwen3.7-flash": {
    mandatory: false,
    supported_efforts: ["xhigh", "high", "medium", "low", "minimal", "none"],
    note: "none and minimal returned no reasoning and low to xhigh returned reasoning; an invalid effort and max returned Alibaba's 400 "
      + "listing none, minimal, low, medium, high and xhigh; reasoning.enabled = false was ignored, so there is no separate toggle (routed to alibaba)",
  },
  "aion-labs/aion-2.0": ALWAYS_ON("aion-labs"),
  "aion-labs/aion-3.0": ALWAYS_ON("aion-labs"),
  "aion-labs/aion-3.0-mini": ALWAYS_ON("aion-labs"),
  "deepseek/deepseek-v4.1-flash-1017-fast": ALWAYS_ON("nebius", "reasoning.enabled = false and effort none still returned reasoning"),
  "google/gemini-2.5-pro": ALWAYS_ON("google-vertex"),
  "minimax/minimax-m2": ALWAYS_ON("amazon-bedrock"),
  "moonshotai/kimi-k2-thinking": ALWAYS_ON("amazon-bedrock and novita"),
  "moonshotai/kimi-k2.7-code": ALWAYS_ON("azure"),
  "moonshotai/kimi-k2.7-code-highspeed": ALWAYS_ON("kimi", "reasoning.enabled = false and effort none returned 400 (\"only type=enabled is allowed for this model\")"),
  "openai/gpt-oss-safeguard-120b": ALWAYS_ON("tinfoil"),
  "qwen/qwen3.6-35b-a3b": ALWAYS_ON("parasail"),
  "stepfun/step-3.5-flash-2603": ALWAYS_ON("stepfun"),
  "zai-org/glm-4.5-air": ALWAYS_ON("novita"),
  "zai-org/glm-4.5v": ALWAYS_ON("novita"),
  "zai-org/glm-4.6": ALWAYS_ON("novita", "reasoning.enabled = false and effort none still returned reasoning"),
  "zai-org/glm-4.6v": ALWAYS_ON("novita"),
  "zai-org/glm-4.7": ALWAYS_ON("novita"),
  "zai-org/glm-5": ALWAYS_ON("novita", "reasoning.enabled = false and effort none still returned reasoning"),
};

// The row with a probed `reasoning` object in place of the catalog's. A row
// that omitted the reasoning fields takes `reasoning`, as the probe showed.
export function withProbedReasoning(model: TrustedRouterModel, probe: ProbedReasoning): TrustedRouterModel {
  return {
    ...model,
    reasoning: { mandatory: probe.mandatory, supported_efforts: probe.supported_efforts },
    supported_parameters: model.supported_parameters.includes("reasoning")
      ? model.supported_parameters
      : [...model.supported_parameters, "reasoning"],
  };
}

// OpenAI GPT-5 and later (not gpt-oss). AGENTS.md asks every host file for these
// models to state which custom-tool (freeform) formats each API accepts, from host
// docs or a probe. TrustedRouter documents neither, so a model is left for hand
// authoring unless it is in FREEFORM_REJECTED below.
export const GPT5_FREEFORM_UNSTATED =
  "TrustedRouter documents no custom-tool (freeform) formats for this GPT-5+ model; manual authoring is needed";
// Probed on Chat Completions (the only API these files list) per AGENTS.md: one
// custom tool per format (text, regex ZZ[0-9]{3}, the same grammar in lark) with
// tool_choice "required". Each returned 501 not_supported_in_alpha on
// tools[0].type from the router, so `freeform` is left out. The pro models priced
// above $20 per million input tokens were not probed and stay held back.
export const FREEFORM_REJECTED = new Set([
  "openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-5-pro", "openai/gpt-5.1", "openai/gpt-5.2",
  "openai/gpt-5.3-codex", "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "openai/gpt-5.5",
  "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-6-astra", "openai/gpt-6-luna",
  "openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6.2-astra", "openai/gpt-6.2-sol",
]);
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
      return authored === undefined ? undefined : { id: model.id, model: authored, keepHeader: true };
    }
    if (!publicChatModel(model)) return undefined;
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveModelMetadataBaseModel(model.id) ?? openRouterBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    // Thrown as a missing-controls error so an authored file is kept as written.
    const gpt5 = isGpt5Plus(baseModel);
    if (gpt5 && !FREEFORM_REJECTED.has(model.id)) {
      throw new MissingReasoningOptionsError(model.id, GPT5_FREEFORM_UNSTATED);
    }
    // Writing no controls claims always-on, so a reasoner is left for hand
    // authoring (an authored file is kept as written) unless TrustedRouter states
    // its controls affirmatively or a live probe established them.
    // A probe stands in only while the catalog states nothing or contradicts
    // itself; once the row states controls, the catalog's values are used.
    const unstated = unstatedReasoningControls(model, baseModel);
    const probe = unstated === undefined ? undefined : PROBED_REASONING[model.id];
    if (unstated !== undefined && probe === undefined) throw new MissingReasoningOptionsError(model.id, unstated);
    const row = probe === undefined ? model : withProbedReasoning(model, probe);
    const labInput = labMimeList(baseModel);
    const built = buildOpenRouterModel(toOpenRouterShape(row, baseModel), existing, baseModel);
    const options = built.reasoning_options ?? [];
    const efforts = options.find((option) => option.type === "effort");
    const cache = trustedRouterCache(model, baseModel);
    return {
      id: model.id,
      model: built,
      v2Set: {
        "modalities.input": (current: unknown) => labMimeInput(current, labInput),
        // The catalog says a model caches but not how in detail (TTLs, breakpoints),
        // so a file's cache kinds are kept and otherwise filled from the row.
        ...(cache === undefined ? {} : {
          "capabilities.cache": (current: unknown) => (current !== null && typeof current === "object" ? current : cache),
        }),
      },
      header: "# Generated by bun models:sync trustedrouter from https://api.trustedrouter.com/v1/models.\n"
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + (options.some((option) => option.type === "toggle") ? "# Toggle: reasoning.enabled = true|false\n" : "")
        + (efforts && "values" in efforts ? `# Effort: reasoning.effort = ${efforts.values.join("|")}\n` : "")
        + (probe !== undefined
          ? `# Reasoning probed live ${PROBED} on POST https://api.trustedrouter.com/v1/chat/completions: ${probe.note}.\n`
          : model.reasoning === undefined ? "" :
          "# Reasoning controls are TrustedRouter's published `reasoning` object (OpenRouter's request shape): OpenRouter's\n"
          + "# efforts for the model, narrowed to what the gateway honors on every route (https://trustedrouter.com/docs).\n")
        + (probe === undefined && model.reasoning?.mandatory && options.length === 0 && takesReasoning(model, baseModel)
          ? "# Always-on: the object marks reasoning mandatory with no efforts, and the row does not take reasoning_effort.\n"
          : "")
        + (gpt5
          ? `# tools.freeform left out: Chat Completions, the only API listed, rejects custom tools. Text, regex ZZ[0-9]{3} and lark custom tools each returned 501 not_supported_in_alpha on tools[0].type (live ${PROBED} on this model).\n`
          : "")
        + (cache === undefined ? "" : "explicit" in cache
          ? `# Cache: explicit; Anthropic cache_control breakpoints pass through to the provider (${CACHE_DOCS}).\n`
          : `# Cache: implicit; the selected provider caches prompt prefixes automatically (${CACHE_DOCS}).\n`)
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
// list when it is the same. A kind the lab does not document is dropped: the
// row alone is not evidence the model accepts it.
const KIND_PREFIX: Record<string, (mime: string) => boolean> = {
  text: (mime) => mime === "text",
  image: (mime) => mime.startsWith("image"),
  pdf: (mime) => mime === "pdf" || mime === "application/pdf",
  // OpenRouter's catalog shape spells document input `file`; it is PDF input,
  // as openrouter.ts's modalities() reads it.
  file: (mime) => mime === "pdf" || mime === "application/pdf",
  audio: (mime) => mime.startsWith("audio"),
  video: (mime) => mime.startsWith("video"),
};
export function labDocumentedKinds(kinds: string[], lab: string[] | undefined) {
  return lab === undefined ? [...kinds] : kinds.filter((kind) => lab.some((mime) => KIND_PREFIX[kind]?.(mime)));
}
// The kind of one input entry: a generic kind from the catalog, or a MIME type
// already written in the file (an update starts from the file's list).
function inputKind(value: string) {
  if (KIND_PREFIX[value] !== undefined) return value;
  return Object.keys(KIND_PREFIX).find((kind) => kind !== "file" && KIND_PREFIX[kind]!(value));
}
export function labMimeInput(current: unknown, lab: string[] | undefined) {
  if (!Array.isArray(current) || lab === undefined) return current;
  const kinds = current.flatMap((value) => {
    const kind = typeof value === "string" ? inputKind(value) : undefined;
    return kind === undefined ? [] : [kind];
  });
  const input = lab.filter((mime) => kinds.some((kind) => KIND_PREFIX[kind]?.(mime)));
  return input.length === lab.length && input.every((value, index) => value === lab[index]) ? undefined : input;
}

const KIND_ORDER = ["text", "image", "pdf", "audio", "video"];
function kindRank(kind: string) {
  const index = KIND_ORDER.indexOf(kind === "file" ? "pdf" : kind);
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
  const parsed = TrustedRouterResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `TrustedRouter returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return parsed;
}

function labDoesNotReason(baseModel: string) {
  return (modelMetadata(baseModel) as { reasoning?: unknown }).reasoning === false;
}

function labReasons(baseModel: string) {
  return (modelMetadata(baseModel) as { reasoning?: unknown }).reasoning === true;
}
