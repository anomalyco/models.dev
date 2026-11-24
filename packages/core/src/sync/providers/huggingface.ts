import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { providerModelToV2 } from "../../model-file-v2.js";
import type { ExistingModel, SyncProvider, SyncedFullModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.huggingface.co/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Hugging Face org prefixes mapped to the canonical metadata prefixes understood
// by resolveCanonicalBaseModel. Anything not listed falls back to a direct lookup.
const CANONICAL_ORG_PREFIXES: Record<string, string> = {
  CohereLabs: "cohere",
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta-llama",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  Qwen: "qwen",
  "stepfun-ai": "stepfun",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

// Hugging Face orgs mapped to the models/ directory holding their lab files, for orgs
// resolveCanonicalBaseModel doesn't know or whose IDs it can't match.
const LAB_DIRS: Record<string, string> = {
  aisingapore: "aisingapore",
  // Re-upload of Microsoft's WizardLM-2 weights.
  alpindale: "microsoft",
  "anthracite-org": "anthracite-org",
  CohereLabs: "cohere",
  // Cognitive Computations' renamed org (Dolphin models).
  dphn: "cognitivecomputations",
  Gryphe: "gryphe",
  "ibm-granite": "ibm",
  inclusionAI: "inclusionai",
  "meta-llama": "meta",
  "meta-models": "meta",
  mistralai: "mistral",
  NousResearch: "nousresearch",
  nvidia: "nvidia",
  Qwen: "alibaba",
  reflection: "reflection",
  "swiss-ai": "swiss-ai",
  Undi95: "undi95",
};

// Weight-precision suffixes the router appends to a served checkpoint
// (`GLM-5.3-BF16`, `Qwen3.8-Flash-Next-FP8`).
const PRECISION_SUFFIX = /-(bf16|fp8|nvfp4)$/i;
// A trailing total/active parameter pair on MoE IDs (`-816B-A42B`, `-1T-A52B`).
// Only the pair is stripped, so a dense size like `-14B` never collapses onto a family file.
const MOE_PARAMS_SUFFIX = /-\d+(\.\d+)?[bt]-a\d+(\.\d+)?b$/i;
// Llama 4's expert count (`Llama-4-Maverick-17B-128E-Instruct`).
const EXPERTS_TOKEN = /-\d+e(?=-)/i;

const HuggingFaceProvider = z.object({
  provider: z.string(),
  status: z.string(),
  context_length: z.number().int().positive().optional(),
  pricing: z.object({
    input: z.number(),
    output: z.number(),
  }).passthrough().optional(),
  throughput: z.number().nonnegative().optional(),
  first_token_latency_ms: z.number().nonnegative().optional(),
  is_free: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_structured_output: z.boolean().optional(),
  is_model_author: z.boolean().optional(),
}).passthrough();

export const HuggingFaceModel = z.object({
  id: z.string().min(1),
  created: z.number().optional(),
  owned_by: z.string().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  providers: z.array(HuggingFaceProvider),
}).passthrough();

export const HuggingFaceResponse = z.object({
  data: z.array(HuggingFaceModel),
}).passthrough();

export type HuggingFaceModel = z.infer<typeof HuggingFaceModel>;
export type HuggingFaceProvider = z.infer<typeof HuggingFaceProvider>;

export const huggingface = {
  id: "huggingface",
  name: "Hugging Face",
  modelsDir: "providers/huggingface/models",
  deleteMissing: false,
  // translateModel returns each file's own header with the synced price line replaced.
  authoritativeHeaders: true,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Hugging Face Inference Providers models were not created because their IDs could not be mapped to provider-agnostic metadata, had no live provider, or had no priced provider.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Hugging Face models were absent from the Inference Providers catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const headers = process.env.HF_TOKEN
      ? { Authorization: `Bearer ${process.env.HF_TOKEN}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Hugging Face models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HuggingFaceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!model.providers.some((provider) => provider.status === "live")) return undefined;

    const aggregate = aggregateProviders(model);
    const existing = context.existing(model.id);
    if (existing !== undefined) {
      const authored = context.authored(model.id);
      const modalities = context.v2?.(model.id)?.modalities;
      return {
        id: model.id,
        model: refreshHuggingFaceModel(model.id, existing, authored, aggregate),
        header: syncedHeader(context.header?.(model.id) ?? "", aggregate.cost !== undefined),
        v2Set: {
          api: (current: unknown) => chatApis(current),
          // The v1 view reduces MIME types to generic kinds, which can factor a
          // hand-authored format list away against the lab file; keep it verbatim.
          ...(modalities === undefined ? {} : { modalities }),
        },
      };
    }

    const baseModel = resolveHuggingFaceBaseModel(model.id);
    const lab = baseModel === undefined ? undefined : labModel(baseModel);
    if (baseModel === undefined || lab === undefined) return undefined;

    // The router only exposes pricing per inference provider, so a new model with
    // no priced provider cannot be created with a meaningful cost.
    if (aggregate.cost === undefined) return undefined;
    // Reasoning controls depend on the inference provider the router picks, so a
    // new reasoning model needs them researched before it's created.
    if (((lab.capabilities as { reasoning?: { supported?: boolean } } | undefined)?.reasoning?.supported ?? lab.reasoning) === true) {
      throw new MissingReasoningOptionsError(model.id, "Hugging Face reasoning controls vary by inference provider; author them before creating this model");
    }

    return {
      id: model.id,
      v2: buildHuggingFaceModel(model, baseModel, aggregate, lab),
      header: `# Created by the Hugging Face sync.\n${SYNCED_LINE}\n`,
    };
  },
} satisfies SyncProvider<HuggingFaceModel>;

interface Aggregate {
  cost: { input: number; output: number } | undefined;
  context: number | undefined;
  tools: boolean;
  structuredOutput: boolean;
}

function price(value: number) {
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000) / 1_000_000
    : undefined;
}

// The router publishes no model-level price or context, only one entry per inference
// provider. This collapses them the way OpenRouter's own model-level values do (the
// OpenRouter sync publishes those as is): the context is the largest any live provider
// serves (OpenRouter's `context_length`), and the price is the cheapest live provider's,
// the one default routing favors (lowest input + output, then highest throughput, then
// provider id). Capabilities are advertised by any provider (a caller can pin one).
export function aggregateProviders(model: HuggingFaceModel): Aggregate {
  const providers = model.providers.filter((provider) => provider.status === "live");

  const priced = providers.flatMap((provider) => {
    if (provider.pricing === undefined) return [];
    const input = price(provider.pricing.input);
    const output = price(provider.pricing.output);
    return input === undefined || output === undefined ? [] : [{ provider, cost: { input, output } }];
  });
  const cheapest = priced.sort((a, b) =>
    (a.cost.input + a.cost.output) - (b.cost.input + b.cost.output)
    || (b.provider.throughput ?? -Infinity) - (a.provider.throughput ?? -Infinity)
    || a.provider.provider.localeCompare(b.provider.provider)
  ).at(0);

  const contexts = providers
    .map((provider) => provider.context_length)
    .filter((value): value is number => value !== undefined);

  return {
    cost: cheapest?.cost,
    context: contexts.length > 0 ? Math.max(...contexts) : undefined,
    tools: providers.some((provider) => provider.supports_tools === true),
    structuredOutput: providers.some((provider) => provider.supports_structured_output === true),
  };
}

const SYNCED_LINE =
  "# Price and context: synced from https://router.huggingface.co/v1/models (cheapest live provider's price, largest live context).";
const CONTEXT_LINE =
  "# Context: synced from https://router.huggingface.co/v1/models (largest live context); price kept, no live provider lists one.";
// Lines earlier syncs and hand edits wrote for the router's price and context, which
// the synced line replaces. Indented lines after one continue it.
const STALE_LINE = /^# (Created by the Hugging Face sync\. )?(Price|Price and context|Context): (synced from )?https:\/\/router\.huggingface\.co\/v1\/models\b/;

// A file's header with its router price line replaced by the synced one, in place,
// or appended when it has none.
export function syncedHeader(header: string, priced: boolean) {
  const lines = header.split("\n").filter((line, index, all) => !(line === "" && index === all.length - 1));
  const out: string[] = [];
  let at: number | undefined;
  let created = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (STALE_LINE.test(line)) {
      at ??= out.length;
      created ||= line.startsWith("# Created by the Hugging Face sync.");
      while (lines[index + 1]?.startsWith("#   ")) index++;
      continue;
    }
    if (line === "# Created by the Hugging Face sync.") {
      at ??= out.length;
      created = true;
      continue;
    }
    out.push(line);
  }
  const synced = [...(created ? ["# Created by the Hugging Face sync."] : []), priced ? SYNCED_LINE : CONTEXT_LINE];
  out.splice(at ?? out.length, 0, ...synced);
  return `${out.join("\n")}\n`;
}

// An existing file with the router's price and context in place of its own. The output
// cap follows the context: a file's own output equal to its old context was a cap at
// that context and is worked out again; another own output is a hand-set cap and kept,
// at most the context. Everything else in the file is kept.
export function refreshHuggingFaceModel(
  id: string,
  existing: ExistingModel,
  authored: ExistingModel | undefined,
  aggregate: Aggregate,
): SyncedFullModel {
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const context = aggregate.context ?? existing.limit?.context;
  if (context === undefined) throw new Error(`Hugging Face model ${id}: no context in the router or the file`);
  const own = authored?.limit?.output;
  const labOutput = baseModel === undefined
    ? undefined
    : (labModel(baseModel)?.limit as { output?: number } | undefined)?.output;
  const kept = own !== undefined && own !== existing.limit?.context ? own : (labOutput ?? existing.limit?.output);
  const output = kept === undefined ? undefined : Math.min(kept, context);
  const limit = { ...existing.limit, context, ...(output === undefined ? {} : { output }) } as SyncedFullModel["limit"];
  const cost = aggregate.cost === undefined ? existing.cost : { ...existing.cost, ...aggregate.cost };
  const values = { ...current, cost, limit } as SyncedFullModel;
  return (baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, baseModelOmit)) as SyncedFullModel;
}

const KINDS = ["text", "image", "audio", "video", "pdf"];

// The router lists modality kinds only (text, image). Each kind takes the lab's
// exact MIME types of that kind.
function exactModalities(values: string[], lab: string[]) {
  const kinds = [...new Set(values.map((value) => value.toLowerCase()).filter((value) => KINDS.includes(value)))];
  return kinds.flatMap((kind) => {
    if (kind === "text") return ["text"];
    const mime = kind === "pdf" ? "application/pdf" : kind;
    const exact = lab.filter((item) => item === mime || item.startsWith(`${mime}/`));
    return exact.length > 0 ? exact : [mime];
  });
}

// A new v2 file for a router model that maps to a lab model. Only host data is
// written: price, context, structured output, and modalities when the router
// lists different kinds than the lab. Model facts come from the lab.
export function buildHuggingFaceModel(
  model: HuggingFaceModel,
  baseModel: string,
  aggregate: Aggregate = aggregateProviders(model),
  lab: Record<string, unknown> | undefined = labModel(baseModel),
): Record<string, unknown> {
  if (lab === undefined) throw new Error(`Hugging Face model ${model.id}: no lab file for ${baseModel}`);
  const labModalities = lab.modalities as { input: string[]; output: string[] };
  // A served context below the lab's output cap would publish an output larger than the
  // window, so the output is capped at the context.
  const labOutput = (lab.limit as { output?: number } | undefined)?.output;
  const output = labOutput !== undefined && aggregate.context !== undefined && labOutput > aggregate.context
    ? aggregate.context
    : undefined;
  const factored = factorBaseModel(baseModel, {
    structured_output: aggregate.structuredOutput || undefined,
    cost: aggregate.cost,
    limit: { context: aggregate.context, ...(output === undefined ? {} : { output }) } as SyncedFullModel["limit"],
  }, { context: aggregate.context });
  const doc = providerModelToV2(factored);

  const input = exactModalities(model.architecture.input_modalities, labModalities.input);
  const outputKinds = exactModalities(model.architecture.output_modalities, labModalities.output);
  const kinds = (values: string[]) => [...new Set(values.map((value) => value.split("/")[0]))].sort().join();
  if (input.length > 0 && outputKinds.length > 0
    && (kinds(input) !== kinds(labModalities.input) || kinds(outputKinds) !== kinds(labModalities.output))) {
    doc.modalities = { input, output: outputKinds };
  }

  // Chat Completions takes tools and reasoning_effort per request, with no
  // per-turn effort or tool-change message.
  // Tool support comes from the router (any live provider); otherwise it's inherited.
  const next: Record<string, unknown> = {};
  if (aggregate.tools) next.tools = { supported: true };
  Object.assign(next, doc.capabilities);
  doc.capabilities = next;
  doc.api = chatApis(undefined);
  return doc;
}

// The router serves every chat model on POST /v1/responses too ("All Inference Providers chat
// completion models should be compatible with the Responses API"):
// https://huggingface.co/docs/inference-providers/guides/responses-api
const RESPONSES_API = {
  sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
};

// The router's Chat Completions API documents max_tokens, not max_completion_tokens:
// https://huggingface.co/docs/inference-providers/tasks/chat-completion (accessed 2026-10-24)
const MAX_TOKENS_FIELD = { max_tokens_field: "max_tokens" };

// A chat model's APIs: its own first table (what v1 reads; an empty table takes the
// provider's Chat Completions API), then Responses.
export function chatApis(current: unknown): Record<string, unknown> {
  const { responses: _responses, ...own } = isRecord(current) ? current : {};
  const tables: Record<string, unknown> = Object.keys(own).length > 0 ? own : { "chat-completions": {} };
  const chat = tables["chat-completions"];
  if (isRecord(chat)) {
    tables["chat-completions"] = {
      ...chat,
      compatibility: { ...(isRecord(chat.compatibility) ? chat.compatibility : {}), ...MAX_TOKENS_FIELD },
    };
  }
  return { ...tables, responses: structuredClone(RESPONSES_API) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function labModel(modelID: string) {
  try {
    return Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function resolveHuggingFaceBaseModel(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const canonicalPrefix = CANONICAL_ORG_PREFIXES[prefix];
  const canonical = canonicalPrefix === undefined
    ? resolveCanonicalBaseModel(id)
    : resolveCanonicalBaseModel(`${canonicalPrefix}/${parts.join("/").toLowerCase()}`);
  if (canonical !== undefined) return canonical;

  const dir = LAB_DIRS[prefix];
  if (dir === undefined) return undefined;
  const files = labFileIDs(dir);
  const match = huggingFaceCandidates(prefix, parts.join("/")).find((candidate) => files.has(candidate));
  return match === undefined ? undefined : `${dir}/${files.get(match)}`;
}

// Lab file IDs a router model may match, most specific first. Each one must equal a
// lab file name (case-insensitive); nothing is matched by prefix.
export function huggingFaceCandidates(org: string, model: string) {
  const name = model.toLowerCase();
  const base = name.replace(PRECISION_SUFFIX, "");
  const unprefixed = org === "nvidia" ? base.replace(/^nvidia-/, "") : base;
  const candidates = [name, base, unprefixed];
  for (const candidate of [base, unprefixed]) {
    candidates.push(candidate.replace(MOE_PARAMS_SUFFIX, ""));
    candidates.push(candidate.replace(EXPERTS_TOKEN, ""));
  }
  return [...new Set(candidates)];
}

const labFileCache = new Map<string, Map<string, string>>();

// Lab file IDs in a models/ directory, keyed by their lowercase form.
function labFileIDs(dir: string) {
  const cached = labFileCache.get(dir);
  if (cached !== undefined) return cached;
  let names: string[] = [];
  try {
    names = readdirSync(path.join(MODELS_DIR, dir)).filter((file) => file.endsWith(".toml"));
  } catch {}
  const files = new Map(names.map((file) => {
    const id = file.slice(0, -".toml".length);
    return [id.toLowerCase(), id] as const;
  }));
  labFileCache.set(dir, files);
  return files;
}
