import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel } from "./openrouter.js";

// Public Parasail serverless catalog. Richer than the OpenAI-compatible
// `/v1/models` endpoint: it carries the API alias, the underlying Hugging Face
// model name, the served context length, per-1M-token prices, and feature tags.
// No authentication required.
const API_ENDPOINT = "https://platform.parasail.io/api/v1/prices/serverlessEndpoints";
const VERIFIED_ON = "2026-09-22";

export const ParasailEndpoint = z.object({
  // The model ID accepted by api.parasail.io (`parasail-…` for public models).
  externalAlias: z.string().min(1),
  // Hugging Face repository the endpoint serves, sometimes a quantized re-upload.
  modelName: z.string().nullish(),
  displayName: z.string().nullish(),
  contextLength: z.number().int().positive().nullish(),
  maxCompletionTokens: z.number().int().positive().nullish(),
  // USD per 1M tokens.
  inputCost: z.number().nullish(),
  outputCost: z.number().nullish(),
  cachedCost: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  engineTask: z.string().nullish(),
}).passthrough();

export const ParasailResponse = z.array(ParasailEndpoint);

export type ParasailEndpoint = z.infer<typeof ParasailEndpoint>;

// Entries that are not chat models (embeddings, TTS) or are private aliases.
function isChatEndpoint(model: ParasailEndpoint) {
  if (!model.externalAlias.startsWith("parasail-")) return false;
  if (model.outputCost === undefined || model.outputCost === null) return false;
  const tags = new Set(model.tags ?? []);
  if (tags.has("TTS") || tags.has("Embedding")) return false;
  if (model.engineTask !== undefined && model.engineTask !== null && model.engineTask !== "chat") return false;
  return true;
}

export const parasail = {
  id: "parasail",
  name: "Parasail",
  modelsDir: "providers/parasail/models",
  // The endpoint is authoritative for what Parasail serves: aliases that
  // disappear from it are no longer routable, so their TOMLs are removed.
  deleteMissing: true,
  sourceID(model) {
    return model.externalAlias;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Parasail endpoints were not created because their Hugging Face model could not be mapped to a \`models/\` lab entry to inherit from.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add the lab entry under `models/<lab>/` (or a mapping override in `parasail.ts`) to include them in the next sync.",
    ];
  },
  async fetchModels() {
    return fetchParasailModels();
  },
  parseModels(raw) {
    return ParasailResponse.parse(raw).filter(isChatEndpoint);
  },
  translateModel(model, context) {
    const id = model.externalAlias;
    const existing = context.existing(id);
    const authored = context.authored(id);
    const baseModel = existing === undefined
      ? resolveParasailBaseModel(model.modelName)
      : existing.base_model;
    if (baseModel === undefined) return undefined;
    if (
      existing === undefined
      && (price(model.inputCost) === undefined || price(model.outputCost) === undefined)
    ) return undefined;

    return {
      id,
      model: buildParasailModel(model, existing, baseModel, authored),
      header: parasailHeader(model, baseModel),
    };
  },
} satisfies SyncProvider<ParasailEndpoint>;

export async function fetchParasailModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Parasail catalog request failed: ${response.status} ${response.statusText}`);
  }
  return ParasailResponse.parse(await response.json());
}

function price(value: number | null | undefined) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Provider-specific reasoning controls, verified per model family against
 * api.parasail.io on 2026-09-22 by sending `reasoning_effort` and reading the
 * returned `reasoning_content` / `reasoning` field. Keyed by `base_model`.
 *
 * - DeepSeek V4 and Kimi K3 forward DeepSeek's effort vocabulary; `none` stops
 *   thinking.
 * - Hybrid models with a native on/off switch only expose a toggle here:
 *   `none` stops thinking, any other value enables it (Gemma 4 is off unless
 *   an effort is sent).
 * - GLM-5.3 and MiniMax M3 always think on this relay: `none` is accepted but
 *   thinking still happens, so no control is offered.
 * - GPT-OSS (Harmony) accepts low|medium|high and rejects none/minimal/xhigh/max.
 */
type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

const EFFORT_DEEPSEEK: ReasoningOptions = [{ type: "effort", values: ["none", "low", "high", "max"] }];
const TOGGLE: ReasoningOptions = [{ type: "toggle" }];
const ALWAYS_ON: ReasoningOptions = [];
const EFFORT_HARMONY: ReasoningOptions = [{ type: "effort", values: ["low", "medium", "high"] }];

const REASONING_OPTIONS: Record<string, ReasoningOptions> = {
  "deepseek/deepseek-v4-flash": EFFORT_DEEPSEEK,
  "deepseek/deepseek-v4-flash-0731": EFFORT_DEEPSEEK,
  "deepseek/deepseek-v4-pro": EFFORT_DEEPSEEK,
  "deepseek/deepseek-v4-pro-0813": EFFORT_DEEPSEEK,
  "deepseek/deepseek-v4.1-flash": EFFORT_DEEPSEEK,
  "moonshotai/kimi-k3": EFFORT_DEEPSEEK,
  "moonshotai/kimi-k2.6": TOGGLE,
  "zhipuai/glm-5.2": TOGGLE,
  "zhipuai/glm-5.3": ALWAYS_ON,
  "zhipuai/glm-5.3-flash": ALWAYS_ON,
  "minimax/MiniMax-M3": ALWAYS_ON,
  "alibaba/qwen3.5-397b-a17b": TOGGLE,
  "alibaba/qwen3.5-35b-a3b": TOGGLE,
  "alibaba/qwen3.5-9b": TOGGLE,
  "alibaba/qwen3.6-35b-a3b": TOGGLE,
  "alibaba/qwen3.8-27b": TOGGLE,
  "google/gemma-4-26b-a4b-it": TOGGLE,
  "google/gemma-4-31b-it": TOGGLE,
  "openai/gpt-oss-120b": EFFORT_HARMONY,
  "openai/gpt-oss-20b": EFFORT_HARMONY,
};

// The relay returns DeepSeek-style `reasoning_content` for these families and
// accepts it back on assistant messages (verified with a tool follow-up).
const INTERLEAVED_REASONING_CONTENT = new Set([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro-0813",
  "deepseek/deepseek-v4.1-flash",
  "zhipuai/glm-5.2",
  "zhipuai/glm-5.3",
  "minimax/MiniMax-M3",
]);

// Per-alias deltas from the lab entry that the endpoint does not express.
const OVERRIDES: Record<string, Partial<SyncedFullModel>> = {};

function nameOverride(alias: string, baseModel: string) {
  const base = modelMetadata(baseModel);
  const baseName = typeof base.name === "string" ? base.name : undefined;
  if (baseName === undefined) return undefined;
  if (alias.endsWith("-fast")) return `${baseName} (Fast)`;
  return undefined;
}

export function buildParasailModel(
  model: ParasailEndpoint,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveParasailBaseModel(model.modelName) : existing.base_model,
  authored?: ExistingModel,
): SyncedModel {
  if (baseModel === undefined) {
    throw new Error(`Parasail endpoint ${model.externalAlias} has no lab entry to inherit from`);
  }
  const alias = model.externalAlias;
  const overrides = OVERRIDES[alias] ?? {};
  const base = modelMetadata(baseModel);

  const inputCost = price(model.inputCost);
  const outputCost = price(model.outputCost);
  const cost = inputCost !== undefined && outputCost !== undefined
    ? {
        input: inputCost,
        output: outputCost,
        reasoning: existing?.cost?.reasoning,
        cache_read: price(model.cachedCost),
        cache_write: existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  // The catalog reports the served context window; the completion cap is only
  // published for some endpoints, so an authored output limit or the lab value
  // is kept otherwise.
  const limit = {
    context: model.contextLength ?? existing?.limit?.context,
    input: existing?.limit?.input,
    output: authored?.limit?.output ?? model.maxCompletionTokens ?? existing?.limit?.output,
  };

  const reasoning = overrides.reasoning ?? existing?.reasoning ?? (base.reasoning === true ? true : undefined);
  const reasoningOptions = reasoning === false
    ? undefined
    : (existing?.reasoning_options ?? REASONING_OPTIONS[baseModel]);
  if (reasoning !== false && base.reasoning === true && reasoningOptions === undefined) {
    throw new MissingReasoningOptionsError(
      alias,
      `${baseModel} reasons, but Parasail's controls for this endpoint have not been verified; add them to REASONING_OPTIONS in parasail.ts`,
    );
  }

  const values: Partial<SyncedFullModel> = {
    name: existing?.name ?? overrides.name ?? nameOverride(alias, baseModel),
    description: existing?.description,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment: existing?.attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature,
    tool_call: existing?.tool_call,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    status: existing?.status,
    interleaved: existing?.interleaved
      ?? (reasoning !== false && INTERLEAVED_REASONING_CONTENT.has(baseModel)
        ? { field: "reasoning_content" as const }
        : undefined),
    cost,
    limit,
    modalities: existing?.modalities ?? overrides.modalities,
  };

  if (limit.context === undefined) {
    throw new Error(`Parasail endpoint ${alias} is missing a context length required for sync`);
  }
  return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

// Toggle wording for models that only think when an effort is sent.
const OFF_BY_DEFAULT = new Set(["google/gemma-4-26b-a4b-it", "google/gemma-4-31b-it"]);

function parasailHeader(model: ParasailEndpoint, baseModel: string) {
  const options = REASONING_OPTIONS[baseModel];
  const control = options === undefined || OVERRIDES[model.externalAlias]?.reasoning === false
    ? "No reasoning control on this endpoint."
    : options.length === 0
      ? "Always-on reasoning: reasoning_effort is accepted but does not stop thinking."
      : options[0]?.type === "toggle"
        ? OFF_BY_DEFAULT.has(baseModel)
          ? "Toggle: thinking is off unless reasoning_effort is sent (e.g. \"high\"); reasoning_effort = \"none\" keeps it off."
          : "Toggle: reasoning_effort = \"none\" stops thinking; any other value enables it."
        : `Effort: reasoning_effort = ${(options[0] as { values: string[] }).values.map((value) => `"${value}"`).join("|")}.`;
  return [
    `Parasail OpenAI Chat (POST https://api.parasail.io/v1/chat/completions)`,
    `model = "${model.externalAlias}" (${model.modelName ?? "unknown upstream"}).`,
    `${control} Verified against the endpoint on ${VERIFIED_ON}.`,
    "Catalog: https://platform.parasail.io/api/v1/prices/serverlessEndpoints",
  ].map((line) => `# ${line}`).join("\n");
}

// Hugging Face organisations Parasail serves from, mapped to the catalog's lab
// namespaces. Quantized re-uploads (RedHatAI, parasail-ai, nvidia NVFP4, …) are
// mapped back to the lab that made the model.
const HF_ORG_TO_LAB: Record<string, string> = {
  "deepseek-ai": "deepseek",
  moonshotai: "moonshotai",
  MiniMaxAI: "minimax",
  "zai-org": "zai",
  openai: "openai",
  google: "google",
  "meta-llama": "meta",
  mistralai: "mistralai",
  nvidia: "nvidia",
  Qwen: "qwen",
  qwen: "qwen",
  "ByteDance-Seed": "bytedance-seed",
};

// Re-uploads under a hosting organisation: the lab is inferred from the model name.
const REUPLOAD_ORGS = new Set(["RedHatAI", "parasail-ai", "nvidia", "bighuggyd"]);

// Explicit model-name overrides where normalisation cannot recover the lab ID.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": "meta/llama-4-maverick-17b-instruct",
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506": "mistral/mistral-small-2506",
};

const QUANT_SUFFIX = /-(fp8|fp8-dynamic|nvfp4|mxfp8|int4|int8|awq|gptq)$/i;

function inferLab(modelPart: string) {
  const lower = modelPart.toLowerCase();
  if (lower.startsWith("gemma")) return "google";
  if (lower.startsWith("llama")) return "meta";
  if (lower.startsWith("glm")) return "zai";
  if (lower.startsWith("minimax")) return "minimax";
  if (lower.startsWith("qwen")) return "qwen";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("kimi")) return "moonshotai";
  if (lower.startsWith("mistral")) return "mistralai";
  if (lower.startsWith("gpt-oss")) return "openai";
  return undefined;
}

export function resolveParasailBaseModel(modelName: string | null | undefined) {
  if (modelName === undefined || modelName === null) return undefined;
  const override = BASE_MODEL_OVERRIDES[modelName];
  if (override !== undefined) return override;

  const [org, ...parts] = modelName.split("/");
  if (org === undefined || parts.length === 0) return undefined;
  let modelPart = parts.join("/").replace(QUANT_SUFFIX, "").replace(QUANT_SUFFIX, "");
  // Meta's `-128E` expert-count infix is not part of the lab ID.
  modelPart = modelPart.replace(/-\d+E-/i, "-");

  const lab = REUPLOAD_ORGS.has(org) ? inferLab(modelPart) : HF_ORG_TO_LAB[org];
  if (lab === undefined) return undefined;
  return resolveCanonicalBaseModel(`${lab}/${modelPart.toLowerCase()}`);
}
