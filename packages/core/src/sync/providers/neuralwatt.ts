import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import { kindOf, labInputModalities, labsDir, labWeightsIndex, readLabModel } from "../lab-metadata.js";
import { EFFORT_ORDER, exactInput } from "./keln.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.neuralwatt.com/v1/models";
const SYSTEMONE_DOCS = "https://portal.neuralwatt.com/docs/api/systemone";
const MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
// The architecture lists describe the model itself, and chat completions
// doesn't accept video (https://docs.neuralwatt.com/api/models#architecture).
const CHAT_INPUT = new Set(["text", "image", "audio"]);
// Hugging Face repos whose lab model publishes different weights, so the
// weights index can't find it. Keyed by lowercased `metadata.huggingface_id`.
const LAB_OVERRIDES: Record<string, string> = {
  // Xiaomi's MOPD build of MiMo-V2.6-Pro. The lab file lists the -RL weights.
  "xiaomimimo/mimo-v2.6-pro-mopd": "xiaomi/mimo-v2.6-pro",
  // NVIDIA's NVFP4 quantization of Google's Gemma 4 31B IT.
  "nvidia/gemma-4-31b-it-nvfp4": "google/gemma-4-31b-it",
};
// A lab's own quantized repo (Qwen/Qwen3.8-27B-FP8) serves the lab model
// named without the suffix in the same org.
const QUANT_SUFFIX = /-(fp8|fp4|nvfp4|mxfp4|int4|int8|awq|gptq|bf16|w4a16|w8a8)$/i;
// The public list had 24 chat and decision rows when this was written. A list
// with fewer than 12 of those fails the run, so a badly truncated response
// can't delete most of the catalog. The runner itself has no deletion limit.
// Smaller drops are held for review only in the scheduled job (auto-merge.ts
// and .github/sync-models/publish.sh), and a local run deletes them.
const MIN_LIVE_MODELS = 12;
// Neuralwatt takes audio as WAV only (PCM or float). MP3, FLAC, M4A and other
// compressed formats are rejected (https://docs.neuralwatt.com/api/chat-completions, "Format").
const HOST_AUDIO = ["audio/wav"];

const Price = z.number().nonnegative();
const Effort = z.string().min(1);

export const NeuralwattModel = z.object({
  id: z.string().min(1),
  max_model_len: z.number().int().positive(),
  metadata: z.object({
    display_name: z.string().nullish(),
    huggingface_id: z.string().nullish(),
    pricing: z.object({
      input_per_million: Price.nullish(),
      output_per_million: Price.nullish(),
      cached_input_per_million: Price.nullish(),
      pricing_tbd: z.boolean(),
      service_tier: z.string().nullish(),
    }).passthrough(),
    capabilities: z.object({
      tools: z.boolean(),
      json_mode: z.boolean(),
      reasoning: z.boolean(),
      // Only decision models set it ("decision").
      task: z.string().nullish(),
    }).passthrough(),
    // The reasoning_effort contract. It is null when the model publishes no levels.
    reasoning: z.object({
      mandatory: z.boolean(),
      supported_efforts: z.array(Effort).nullish(),
      default_effort: Effort.nullish(),
    }).passthrough().nullish(),
    limits: z.object({
      max_context_length: z.number().int().positive().nullish(),
      // null means no host cap, and the request may use whatever context is left.
      max_output_tokens: z.number().int().nonnegative().nullish(),
    }).passthrough(),
    deprecated: z.boolean(),
  }).passthrough(),
  architecture: z.object({
    input_modalities: z.array(z.string()).min(1),
    output_modalities: z.array(z.string()).min(1),
  }).passthrough(),
}).passthrough();

export const NeuralwattResponse = z.object({
  object: z.literal("list"),
  // An authenticated list adds the account's private grants. Only the public
  // list may feed the catalog, so anything else fails the run.
  scope: z.literal("public"),
  data: z.array(NeuralwattModel),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Neuralwatt returned duplicate model IDs",
);

export type NeuralwattModel = z.infer<typeof NeuralwattModel>;

export const neuralwatt = {
  id: "neuralwatt",
  name: "Neuralwatt",
  modelsDir: "providers/neuralwatt/models",
  fetchModels: fetchNeuralwattModels,
  parseModels(raw) {
    const models = NeuralwattResponse.parse(raw).data;
    const catalogRows = models.filter(syncable).length;
    if (catalogRows < MIN_LIVE_MODELS) {
      throw new Error(
        `Neuralwatt returned ${catalogRows} chat or decision models, below the ${MIN_LIVE_MODELS} needed to tell a retirement from a truncated list`,
      );
    }
    return models;
  },
  sourceID(model) {
    return model.id;
  },
  // A priced model whose checkpoint has no lab file, whose decision lab isn't a
  // decision model, that is a decision model taking more than text, or that
  // publishes no reasoning levels gets a missing-model issue, and an existing
  // file for it is kept meanwhile.
  missingModelID(model) {
    if (!priced(model) || !syncable(model)) return undefined;
    const labs = labsDir(this.modelsDir);
    const baseModel = neuralwattBaseModel(model.metadata.huggingface_id, labs);
    if (baseModel === undefined) return model.id;
    if (isDecision(model)) {
      return readLabModel(baseModel, labs)?.type === "decision" && textOnly(model) ? undefined : model.id;
    }
    const levelsUnpublished = model.metadata.capabilities.reasoning
      && reasoningOptions(model.metadata.reasoning, undefined) === undefined;
    return levelsUnpublished ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Neuralwatt models not synced (unpriced, not a chat or text-only decision model, no lab model for their huggingface_id, or no published reasoning levels): ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    // A listed row the sync can't use keeps its file as written. Returning
    // undefined would let the runner delete it as retired.
    if (!priced(model) || !syncable(model)) return republish(model.id, context);
    const labs = labsDir(this.modelsDir);
    const authored = context.authored(model.id);
    const existingV2 = context.v2?.(model.id);
    const existingBase = authored?.base_model ?? stringAt(existingV2, "base_model");
    // Fall back to the file's base_model only when the row names no checkpoint.
    // An unknown checkpoint goes to missingModelID, which keeps the file.
    const checkpoint = model.metadata.huggingface_id?.trim();
    const baseModel = checkpoint ? neuralwattBaseModel(checkpoint, labs) : existingBase;
    if (baseModel === undefined) return undefined;
    // Authored host facts (reasoning controls and default, output cap, MIME
    // list, reasoning field, omissions) describe the lab the file points at,
    // so none of them carry over when an alias moves to another lab.
    const kept = existingBase === undefined || existingBase === baseModel ? authored : undefined;
    const keptV2 = kept === undefined ? undefined : existingV2;

    if (isDecision(model)) {
      if (!textOnly(model)) return undefined;
      const v2 = buildDecisionModel(model, baseModel, existingV2, labs);
      return v2 === undefined ? undefined : { id: model.id, v2, header: DECISION_HEADER };
    }

    const reasoning = model.metadata.capabilities.reasoning;
    const controls = reasoning ? reasoningOptions(model.metadata.reasoning, kept) : undefined;
    // A thinking model needs its levels published, and they are never invented.
    // An existing file on the same lab keeps its authored controls (the runner preserves them).
    if (reasoning && controls === undefined && kept?.reasoning_options === undefined) return undefined;

    const input = kinds(model.architecture.input_modalities).filter((kind) => CHAT_INPUT.has(kind));
    const pricing = model.metadata.pricing;
    const limit = {
      context: model.metadata.limits.max_context_length ?? model.max_model_len,
      output: outputLimit(model, kept),
    };
    const deprecated = model.metadata.deprecated;
    const translated = factorBaseModel(baseModel, {
      name: model.metadata.display_name?.trim() || undefined,
      attachment: input.some((value) => value !== "text"),
      tool_call: model.metadata.capabilities.tools,
      structured_output: model.metadata.capabilities.json_mode,
      reasoning,
      reasoning_options: controls,
      // The API doesn't say where the reasoning trace comes back, so an authored
      // field (reasoning_content on Kimi) is kept. Otherwise it is `reasoning`
      // (see provider.toml).
      interleaved: kept?.interleaved ?? (reasoning ? true : undefined),
      status: deprecated ? "deprecated" : authored?.status === "deprecated" ? undefined : authored?.status,
      cost: {
        input: pricing.input_per_million!,
        output: pricing.output_per_million!,
        cache_read: pricing.cached_input_per_million ?? undefined,
      },
      limit,
      modalities: { input, output: ["text"] },
    }, limit, kept?.base_model_omit);

    const v2Set: Record<string, unknown> = {};
    const labInput = labInputModalities(baseModel, labs);
    if (labInput !== undefined) {
      const host = hostInput(input, labInput, valueAt(keptV2, "modalities", "input"));
      // The lab's list is inherited when the host's is the same. Otherwise the
      // v1 view needs the kinds too, since factoring drops them when they match the lab's.
      if (sameItems(host, labInput)) v2Set.modalities = undefined;
      else {
        v2Set.modalities = { input: host, output: ["text"] };
        if (!("modalities" in translated) || translated.modalities === undefined) {
          Object.assign(translated, { modalities: { input, output: ["text"] } });
        }
      }
    }
    // The runner rebuilds the reasoning table from the controls when they
    // change, so an authored default is put back while a control still backs it.
    const authoredDefault = valueAt(keptV2, "capabilities", "reasoning", "default");
    if (reasoning && controls !== undefined) {
      const restored = backedDefault(authoredDefault, controls);
      v2Set["capabilities.reasoning"] = (current: unknown) => {
        if (!isRecord(current) || current.supported !== true) return current;
        const { supported, default: _old, ...rest } = current;
        return restored === undefined ? { supported, ...rest } : { supported, default: restored, ...rest };
      };
    }

    return {
      id: model.id,
      model: translated,
      header: chatHeader(model),
      v2Set,
    };
  },
} satisfies SyncProvider<NeuralwattModel>;

type TranslateContext = Parameters<SyncProvider<NeuralwattModel>["translateModel"]>[1];
type Controls = z.infer<typeof ReasoningOption>[];

function priced(model: NeuralwattModel) {
  const pricing = model.metadata.pricing;
  return !pricing.pricing_tbd && pricing.input_per_million != null && pricing.output_per_million != null;
}

function isDecision(model: NeuralwattModel) {
  return model.metadata.capabilities.task === "decision";
}

// Chat and decision models have a catalog shape. Embedding rows (task "embed") don't.
function syncable(model: NeuralwattModel) {
  return isDecision(model) || model.architecture.output_modalities.includes("text");
}

// Media decision models need hand-written files (media_input, output, header).
function textOnly(model: NeuralwattModel) {
  return kinds(model.architecture.input_modalities).every((kind) => kind === "text");
}

// The existing file, unchanged, or undefined when there is none (a quiet skip).
function republish(id: string, context: TranslateContext) {
  const v2 = context.v2?.(id);
  if (v2?.v2_only === true) return { id, v2 };
  const authored = context.authored(id);
  return authored === undefined ? undefined : { id, model: authored as SyncedModel };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(doc: unknown, ...keys: string[]) {
  return keys.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), doc);
}

function stringAt(doc: unknown, key: string) {
  const value = valueAt(doc, key);
  return typeof value === "string" ? value : undefined;
}

/** The API's levels, low to high, plus a budget the file already documents. */
export function reasoningOptions(
  reasoning: NeuralwattModel["metadata"]["reasoning"],
  authored: ExistingModel | undefined,
) {
  if (reasoning == null) return undefined;
  const values = [...new Set(reasoning.supported_efforts ?? [])]
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  // With no published levels, reasoning is always on and nothing controls it.
  if (values.length === 0) return reasoning.mandatory ? [] : undefined;
  const effort = ReasoningOption.safeParse({ type: "effort", values });
  if (!effort.success) return undefined;
  // `thinking_token_budget` is accepted per model but /v1/models doesn't say
  // where, so a budget is only ever carried over from the authored file.
  const budget = authored?.reasoning_options?.filter((option) => option.type === "budget_tokens") ?? [];
  return [effort.data, ...budget];
}

// An authored v2 `default`, while the controls still offer it.
function backedDefault(value: unknown, controls: Controls) {
  if (!isRecord(value)) return undefined;
  if (value.type === "effort") {
    const effort = controls.find((option) => option.type === "effort");
    return effort?.type === "effort" && effort.values.includes(value.value as never) ? value : undefined;
  }
  if (value.type === "budget") return controls.some((option) => option.type === "budget_tokens") ? value : undefined;
  if (value.type === "toggle") return controls.some((option) => option.type === "toggle") ? value : undefined;
  return undefined;
}

// A published cap wins. With none (null), keep the file's limit, else inherit the lab's.
function outputLimit(model: NeuralwattModel, authored: ExistingModel | undefined) {
  const cap = model.metadata.limits.max_output_tokens;
  return cap != null && cap > 0 ? cap : authored?.limit?.output;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()))]
    .filter((value): value is "text" | "audio" | "image" | "video" | "pdf" => MODALITIES.has(value));
}

function sameKinds(current: unknown[], expected: string[]) {
  const have = new Set(current.map((item) => kindOf(String(item))));
  return have.size === expected.length && expected.every((kind) => have.has(kind));
}

function sameItems(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

// The exact input list the host accepts, per kind: the file's MIME types for
// a kind it already lists, else the lab's, with audio as WAV only.
function hostInput(inputKinds: string[], labInput: string[], current: unknown) {
  const authored = Array.isArray(current) ? current.map(String) : [];
  return inputKinds.flatMap((kind) => {
    if (kind === "text") return ["text"];
    if (kind === "audio") return HOST_AUDIO;
    const own = authored.filter((item) => kindOf(item) === kind);
    return own.length > 0 ? own : exactInput([kind], labInput);
  });
}

function chatHeader(model: NeuralwattModel) {
  const lines = [
    `# Generated by bun models:sync neuralwatt from ${API_ENDPOINT} (public list).`,
    "# Prices are USD per million tokens from metadata.pricing. Lab facts are inherited via base_model.",
  ];
  if (model.metadata.pricing.service_tier === "flex") {
    lines.push("# The Flex tier requires stream = true, and its listed prices already include the flex discount.");
  }
  if (model.id.endsWith("-speed")) {
    lines.push(
      "# The Speed tier bills measured energy with no per-server cap on each request's share, so a request costs more than",
      "# the listed token prices. Accounts billed at token prices get a 403 (https://docs.neuralwatt.com/guides/speed-tier).",
    );
  }
  return `${lines.join("\n")}\n`;
}

const DECISION_HEADER = [
  `# Decision model: POST https://api.neuralwatt.com/v1/systemone with the System One {model, state, questions} body (${SYSTEMONE_DOCS}).`,
  "# It takes text only, and a request with images or videos is a 400. Prices are USD per million tokens from GET /v1/models metadata.pricing.",
].join("\n") + "\n";

// Decision models only answer on /v1/systemone, so they are v2-only files.
// Only text-only rows are built. An existing file is the starting point, so
// fields the sync doesn't own survive.
export function buildDecisionModel(
  model: NeuralwattModel,
  baseModel: string,
  existing?: Record<string, unknown>,
  labs?: string,
) {
  const lab = readLabModel(baseModel, labs);
  if (lab?.type !== "decision") return undefined;
  const pricing = model.metadata.pricing;
  const doc: Record<string, any> = structuredClone(existing ?? {});
  Object.assign(doc, { schema: 2, v2_only: true, base_model: baseModel });

  const name = model.metadata.display_name?.trim();
  if (name && name !== lab.name) doc.name = name;
  else delete doc.name;
  if (model.metadata.deprecated) doc.status = "deprecated";
  else if (doc.status === "deprecated") delete doc.status;

  const labModalities = lab.modalities as { input?: string[]; output?: string[] } | undefined;
  if (labModalities?.input !== undefined && !sameKinds(labModalities.input, ["text"])) {
    doc.modalities = { ...doc.modalities, input: ["text"], output: doc.modalities?.output ?? labModalities.output ?? ["decision"] };
  } else if (doc.modalities !== undefined) {
    delete doc.modalities.input;
    if (Object.keys(doc.modalities).every((key) => key === "output")) delete doc.modalities;
  }

  const context = model.metadata.limits.max_context_length ?? model.max_model_len;
  if (context !== (lab.limit as { context?: number } | undefined)?.context) doc.limit = { ...doc.limit, context };
  else if (doc.limit !== undefined) {
    delete doc.limit.context;
    if (Object.keys(doc.limit).length === 0) delete doc.limit;
  }

  // Neuralwatt has no @opencode/ai package of its own (see AGENTS.md "APIs").
  doc.api = {
    ...doc.api,
    systemone: {
      ...doc.api?.systemone,
      sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/typesafe-ai/decisions" },
    },
  };

  const cacheRead = pricing.cached_input_per_million;
  const textInput = { ...doc.cost?.text?.input, price: pricing.input_per_million! };
  if (cacheRead != null) textInput.cache = { ...textInput.cache, read: cacheRead };
  else if (textInput.cache !== undefined) {
    delete textInput.cache.read;
    if (Object.keys(textInput.cache).length === 0) delete textInput.cache;
  }
  doc.cost = {
    ...doc.cost,
    text: {
      ...doc.cost?.text,
      input: textInput,
      output: { ...doc.cost?.text?.output, price: pricing.output_per_million! },
    },
  };
  return doc;
}

/** The lab model served under a `metadata.huggingface_id`, or undefined when no single one matches. */
export function neuralwattBaseModel(huggingfaceID: string | null | undefined, labs?: string) {
  if (huggingfaceID == null || !huggingfaceID.includes("/")) return undefined;
  const id = huggingfaceID.toLowerCase();
  if (LAB_OVERRIDES[id] !== undefined) return LAB_OVERRIDES[id];
  const index = labWeightsIndex(labs);
  const unique = (ids: string[] | undefined) => (ids !== undefined && new Set(ids).size === 1 ? ids[0] : undefined);
  const exact = unique(index.get(id));
  if (exact !== undefined) return exact;

  const [org = "", repo = ""] = id.split("/");
  const bare = repo.replace(QUANT_SUFFIX, "");
  // Another org's quantization goes in LAB_OVERRIDES, never a basename match.
  return bare === repo ? undefined : unique(index.get(`${org}/${bare}`));
}

// Never sends credentials, because an authenticated list would add private grants.
// parseModels validates the response.
export async function fetchNeuralwattModels(fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Neuralwatt catalog request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
