import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import { toV1Modality } from "../../translate.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://llmtr.com/v1/models";

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");
const MODELS_DIR = path.join(PROVIDERS_DIR, "..", "models");
const TOKENS_PER_PRICING_UNIT = 1_000_000;

// The public list is unauthenticated, and absence removes a model; a truncated
// 200 that still parses must not read as a mass retirement.
const MIN_LIVE_MODELS = 100;

// LLMTR namespaces the shared resolver spells differently.
const LAB_PREFIX: Record<string, string> = {
  gemma: "google",
  mimo: "xiaomi",
  mistral: "mistralai",
  publicai: "swiss-ai",
};

// Upstream inference hosts LLMTR relays. Their ids are `<host>/<lab model>`
// plus a host or region suffix, so they share a lab entry with the lab's own
// route and are told apart by name.
const HOSTS: Record<string, string> = {
  engy: "engy",
  greenpt: "GreenPT",
  heabsy: "Heabsy",
  tensorx: "TensorX",
};
const HOST_SUFFIX = /-(eu|tensorx|heabsy|engy)$/;

// The lab's own provider directory, where an alias such as `zai/glm-4.5-x`
// already records which lab entry it serves.
const FIRST_PARTY_DIR: Record<string, string> = {
  gemma: "google",
  mimo: "xiaomi",
  moonshot: "moonshotai",
  qwen: "alibaba",
};

// Routes whose lab entry the id does not spell.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "greenpt/mistral-medium-3.5-128b": "mistral/mistral-medium-3-5",
  "greenpt/mistral-small-3.2-24b-instruct-2506": "mistral/mistral-small-3.2-24b-instruct",
  "llmtr/qwen3-5-4b": "alibaba/qwen3.5-4b",
  "llmtr/qwen3-8-27b": "alibaba/qwen3.8-27b",
  "nvidia/nemotron-3.5-super-vl": "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/nemotron-3.5-super-vl-free": "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "qwen/qwen-plus-latest": "alibaba/qwen-plus",
};

// EVREN routes run on the caller's own EVREN key and are listed at 0, which
// would publish them as free. The decision model answers with a single letter.
const SKIPPED_NAMESPACES = new Set(["evren"]);
const SKIPPED_MODELS = new Set(["together/tev1-4b-experimental"]);

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Image, video and speech rows list 0 tokens and their own price shapes, so
// token limits and prices are only checked on the chat routes that use them.
const TokenLimit = z.number().int().nonnegative().nullish();
const Price = z.string().optional();

export const LLMTRModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  supported_endpoints: z.array(z.string()),
  context_length: TokenLimit,
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  pricing: z.object({
    prompt: Price.optional(),
    completion: Price.optional(),
    input_cache_read: Price.optional(),
    input_cache_write: Price.optional(),
    audio: Price.optional(),
    internal_reasoning: Price.optional(),
  }).passthrough(),
  top_provider: z.object({
    context_length: TokenLimit,
    max_completion_tokens: TokenLimit,
  }).passthrough().nullish(),
  supported_parameters: z.array(z.string()),
  reasoning: z.object({
    mandatory: z.boolean(),
    default_enabled: z.boolean(),
    supported_efforts: z.array(z.string()),
  }).passthrough().nullish(),
}).passthrough();

export const LLMTRResponse = z.object({
  object: z.literal("list"),
  data: z.array(LLMTRModel),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "LLMTR returned duplicate model IDs",
);

export type LLMTRModel = z.infer<typeof LLMTRModel>;

export const llmtr = {
  id: "llmtr",
  name: "LLMTR",
  modelsDir: "providers/llmtr/models",
  // Chat routes that cannot be created are listed in the run's report rather
  // than opened as one issue each.
  trackMissingModels: false,
  sourceID(model) {
    return chatRoute(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} LLMTR chat routes have no lab entry under models/ or no quoted price: `
        + ids.map((id) => `\`${id}\``).join(", "),
    ];
  },
  fetchModels: fetchLLMTRModels,
  parseModels(raw) {
    return LLMTRResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!chatRoute(model)) return undefined;
    const id = modelID(model.id);
    const existing = context.authored(id);
    if (existing !== undefined) return { id, model: updateModel(model, existing) };
    const baseModel = resolveLLMTRBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    // An unquoted price is unknown, not free.
    if (model.pricing.prompt === undefined || model.pricing.completion === undefined) return undefined;
    return createModel(model, id, baseModel);
  },
} satisfies SyncProvider<LLMTRModel>;

export async function fetchLLMTRModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`LLMTR models request failed: ${response.status} ${response.statusText}`);
  }
  const parsed = LLMTRResponse.parse(await response.json());
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `LLMTR returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + " distinguish a retirement from a truncated response",
    );
  }
  return parsed;
}

function chatRoute(model: LLMTRModel) {
  const [namespace = ""] = model.id.split("/");
  return model.supported_endpoints.includes("/v1/chat/completions")
    && model.architecture.input_modalities.includes("text")
    && model.architecture.output_modalities.includes("text")
    && !model.id.includes(":")
    && !SKIPPED_NAMESPACES.has(namespace)
    && !SKIPPED_MODELS.has(model.id);
}

// LLMTR's own deployments are served as `llmtr/<id>` and also answer to the
// bare id, which is what the catalog has always published.
export function modelID(id: string) {
  return id.startsWith("llmtr/") ? id.slice("llmtr/".length) : id;
}

export function resolveLLMTRBaseModel(id: string) {
  const override = BASE_MODEL_OVERRIDES[id];
  if (override !== undefined) return override;
  const [namespace = "", ...rest] = id.split("/");
  // Free, unmetered and context-capped (`-12k`) routes serve the same weights.
  const model = rest.join("/").replace(/-(free|unmetered|\d+k)$/, "");
  if (namespace === "llmtr" || HOSTS[namespace] !== undefined) {
    return resolveModelMetadataBaseModel(model.replace(HOST_SUFFIX, ""));
  }
  const firstPartyBase = firstParty(id)?.base_model;
  return resolveModelMetadataBaseModel(`${LAB_PREFIX[namespace] ?? namespace}/${model}`)
    ?? (typeof firstPartyBase === "string" ? firstPartyBase : undefined);
}

function firstParty(id: string) {
  const [namespace = "", ...rest] = id.split("/");
  const file = path.join(PROVIDERS_DIR, FIRST_PARTY_DIR[namespace] ?? namespace, "models", `${rest.join("/")}.toml`);
  return existsSync(file) ? Bun.TOML.parse(readFileSync(file, "utf8")) as { base_model?: unknown; name?: unknown } : undefined;
}

// Existing files were measured by hand, so the list only refreshes what LLMTR
// charges and serves: prices and limits. Capabilities, names, lab inheritance,
// lifecycle and reasoning controls stay as authored.
function updateModel(model: LLMTRModel, existing: ExistingModel): SyncedModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const limit = { ...current.limit, ...defined(served(model)) };
  const values = {
    ...current,
    cost: { ...current.cost, ...cost(model) },
    limit,
  } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

function createModel(model: LLMTRModel, id: string, baseModel: string) {
  const reasoning = reasoningControls(model, id, baseModel);
  const limit = served(model);
  const input = inputKinds(model, baseModel);
  const parameters = model.supported_parameters;
  const synced = factorBaseModel(baseModel, {
    name: displayName(model.id, baseModel),
    attachment: input.some((value) => value !== "text"),
    tool_call: parameters.includes("tools"),
    temperature: parameters.includes("temperature"),
    structured_output: parameters.includes("structured_outputs"),
    modalities: { input, output: ["text"] as SyncedFullModel["modalities"]["output"] },
    reasoning: reasoning.reasoning,
    reasoning_options: reasoning.options,
    // translateModel only creates routes with both prices quoted.
    cost: cost(model) as SyncedFullModel["cost"],
    limit,
  }, limit);
  return {
    id,
    model: synced,
    // v1 fields only carry kinds; the v2 file lists the lab's exact formats.
    ...("modalities" in synced ? { v2Set: { "modalities.input": labFormats(baseModel, input) } } : {}),
    header: [
      `# Generated by bun models:sync llmtr from ${API_ENDPOINT}.`,
      "# Prices are USD per million tokens; lab facts are inherited via base_model.",
      ...reasoning.header,
    ].join("\n") + "\n",
  };
}

// A route accepts the input kinds both LLMTR and the lab list: the gateway
// cannot add a kind the model does not read. When that is every lab kind the
// file inherits the lab's exact formats instead of writing generic ones.
function inputKinds(model: LLMTRModel, baseModel: string) {
  const kinds = new Set(model.architecture.input_modalities.map((value) => (value === "file" ? "pdf" : value)));
  const lab = (modelMetadata(baseModel).modalities as Partial<SyncedFullModel["modalities"]> | undefined)?.input;
  return (lab ?? ["text"]).filter((value) => kinds.has(value));
}

// The lab file's exact input formats (`image/png`, `application/pdf`) for the given kinds.
export function labFormats(baseModel: string, kinds: string[]) {
  const lab = Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8")) as {
    modalities?: { input?: string[] };
  };
  return (lab.modalities?.input ?? kinds).filter((value) => kinds.includes(toV1Modality(value)));
}

// LLMTR repeats the context window as the output cap when it has none of its
// own; that is not a real cap, so the lab's output limit applies instead.
function served(model: LLMTRModel) {
  const context = positive(model.top_provider?.context_length) ?? positive(model.context_length);
  const output = positive(model.top_provider?.max_completion_tokens);
  return { context, output: output === context ? undefined : output };
}

// Keys the list does not send are left out, so an update keeps the authored value.
function defined<T extends Record<string, unknown>>(values: T) {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== undefined)) as Partial<T>;
}

function positive(value: number | null | undefined) {
  return value != null && value > 0 ? value : undefined;
}

function cost(model: LLMTRModel) {
  const pricing = model.pricing;
  return defined({
    input: perMillion(pricing.prompt),
    output: perMillion(pricing.completion),
    cache_read: perMillion(pricing.input_cache_read),
    cache_write: perMillion(pricing.input_cache_write),
    input_audio: perMillion(pricing.audio),
    reasoning: perMillion(pricing.internal_reasoning),
  });
}

// Per-token USD strings. A malformed price must fail the run, not be written
// as a free model. Six decimals: scaling otherwise carries float error.
function perMillion(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d+)?(e[-+]?\d+)?$/i.test(value)) throw new Error(`LLMTR price is not a non-negative number: ${value}`);
  return Number((Number(value) * TOKENS_PER_PRICING_UNIT).toFixed(6));
}

// Several routes share one lab entry, so each one LLMTR serves differently is
// named for what sets it apart; the lab's own alias names are reused as is.
function displayName(id: string, baseModel: string) {
  const firstPartyName = firstParty(id)?.name;
  if (typeof firstPartyName === "string") return firstPartyName;
  const [namespace = ""] = id.split("/");
  const labels = [
    HOSTS[namespace],
    id.endsWith("-eu") ? "EU" : undefined,
    id.endsWith("-free") ? "Free" : undefined,
    id.endsWith("-unmetered") ? "Unmetered" : undefined,
    id.match(/-(\d+)k$/)?.[1]?.concat("K context"),
  ].filter((label) => label !== undefined);
  return labels.length === 0 ? undefined : `${modelMetadata(baseModel).name} (${labels.join(", ")})`;
}

// The list describes the controls the gateway itself parses and validates: an
// effort outside `supported_efforts` is rejected with the supported list, and
// an effort on a route without a ladder with the control that route does have.
// Other body fields reach the upstream unchanged, so a reasoning route the list
// says nothing about may still have a control, and the Alibaba relay (`qwen/`)
// and DeepSeek routes take their lab's own thinking fields (`enable_thinking`,
// `thinking_budget`, `thinking.type`) on top of what the list shows. Those
// routes are measured and hand-authored instead.
function reasoningControls(model: LLMTRModel, id: string, baseModel: string) {
  const parameters = model.supported_parameters;
  const published = model.reasoning;
  if (modelMetadata(baseModel).reasoning === true && (published == null || forwardsLabThinking(model.id, baseModel))) {
    throw new MissingReasoningOptionsError(
      id,
      published == null
        ? "LLMTR lists no reasoning control for this reasoning model; measure the route and hand-author its controls"
        : "this route forwards the lab's own thinking fields, which LLMTR's list does not describe; measure the route and hand-author its controls",
    );
  }
  if (published == null) return { reasoning: undefined, options: undefined, header: [] };
  const efforts = parameters.includes("reasoning_effort")
    ? published.supported_efforts
      .filter((value) => !(published.mandatory && value === "none"))
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    : [];
  // A route with an effort ladder takes no boolean `reasoning`; `none` on the
  // ladder is its off switch, and a ladder of only `none` is an on/off switch.
  if (efforts.length > 0) {
    return efforts.every((value) => value === "none")
      ? {
          reasoning: true,
          options: [{ type: "toggle" as const }],
          header: ["# Toggle: reasoning_effort = none turns reasoning off; omit it to keep it on."],
        }
      : {
          reasoning: true,
          options: [ReasoningOption.parse({ type: "effort", values: efforts })],
          header: [`# Effort: reasoning_effort = ${efforts.join("|")}`],
        };
  }
  if (!published.mandatory && parameters.includes("reasoning")) {
    return {
      reasoning: true,
      options: [{ type: "toggle" as const }],
      header: ["# Toggle: reasoning = true|false (or the :think suffix on the model id)."],
    };
  }
  // Without a control the route runs at its default, which for some lab
  // reasoning models is off.
  return published.mandatory || published.default_enabled
    ? {
        reasoning: true,
        options: [],
        header: ["# Reasoning is always on; LLMTR exposes no control for this route."],
      }
    : {
        reasoning: false,
        options: undefined,
        header: ["# Reasoning: LLMTR serves this route with reasoning off and exposes no control."],
      };
}

function forwardsLabThinking(sourceID: string, baseModel: string) {
  return sourceID.startsWith("qwen/") || baseModel.startsWith("deepseek/");
}
