import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

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
    const endpoints = ParasailResponse.parse(raw);
    // deleteMissing is enabled: an empty or truncated feed must fail loudly
    // here rather than read as "delete the local catalog".
    if (endpoints.length === 0) {
      throw new Error("Parasail catalog returned no endpoints; refusing an empty feed as authoritative");
    }
    const models = endpoints.filter(isChatEndpoint);
    if (models.length === 0) {
      throw new Error("Parasail catalog returned no public chat endpoints; refusing destructive sync");
    }
    return models;
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
 * Provider-specific reasoning controls, authored per AGENTS.md "Reasoning
 * options": the graded levels are the lab / same-surface peer set (Parasail
 * forwards `reasoning_effort` to the model), and the off control is modelled by
 * how this relay exposes it. Every claim was verified against api.parasail.io
 * on 2026-09-22 (evidence with response ids in the PR that added the entry).
 *
 * - Off is `reasoning_effort = "none"` on the same field as the graded levels,
 *   so DeepSeek V4 / Kimi K3 are `effort none|low|high|max` and GLM-5.2 is
 *   `effort none|high|max`, with no `toggle` (§3, row 1).
 * - Qwen3.8 27B: `effort none|low|medium|xhigh` (peer graded set; `none` stops).
 * - Binary on/off only: Kimi K2.6, Qwen3.5/3.6, Gemma 4 via
 *   `reasoning_effort = "none"` (Gemma 4 is off unless an effort is sent);
 *   MiniMax M3 via its native `thinking.type = "disabled"`, which this relay
 *   honours for MiniMax while `reasoning_effort = "none"` does not stop it.
 * - GLM-5.3 / GLM-5.3 Flash: effort low|high|max, thinking cannot be disabled
 *   (`none` leaks the thinking into content on GLM-5.3).
 * - GPT-OSS: effort low|medium|high (Harmony rejects none/minimal/xhigh/max).
 */
type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

const TOGGLE: ReasoningOptions = [{ type: "toggle" }];
const EFFORT_NONE_LHM: ReasoningOptions = [{ type: "effort", values: ["none", "low", "high", "max"] }];
const EFFORT_NONE_HM: ReasoningOptions = [{ type: "effort", values: ["none", "high", "max"] }];
const EFFORT_LHM: ReasoningOptions = [{ type: "effort", values: ["low", "high", "max"] }];
const EFFORT_HARMONY: ReasoningOptions = [{ type: "effort", values: ["low", "medium", "high"] }];
// Qwen3.8 27B forwards graded effort (peer set low|medium|xhigh) and `none` stops thinking.
const EFFORT_NONE_LMX: ReasoningOptions = [{ type: "effort", values: ["none", "low", "medium", "xhigh"] }];

const REASONING_OPTIONS: Record<string, ReasoningOptions> = {
  "deepseek/deepseek-v4-flash": EFFORT_NONE_LHM,
  "deepseek/deepseek-v4-flash-0731": EFFORT_NONE_LHM,
  "deepseek/deepseek-v4-pro": EFFORT_NONE_LHM,
  "deepseek/deepseek-v4-pro-0813": EFFORT_NONE_LHM,
  "deepseek/deepseek-v4.1-flash": EFFORT_NONE_LHM,
  "moonshotai/kimi-k3": EFFORT_NONE_LHM,
  "moonshotai/kimi-k2.6": TOGGLE,
  "zhipuai/glm-5.2": EFFORT_NONE_HM,
  "zhipuai/glm-5.3": EFFORT_LHM,
  "zhipuai/glm-5.3-flash": EFFORT_LHM,
  "minimax/MiniMax-M3": TOGGLE,
  "alibaba/qwen3.5-397b-a17b": TOGGLE,
  "alibaba/qwen3.5-35b-a3b": TOGGLE,
  "alibaba/qwen3.5-9b": TOGGLE,
  "alibaba/qwen3.6-35b-a3b": TOGGLE,
  "alibaba/qwen3.8-27b": EFFORT_NONE_LMX,
  "google/gemma-4-26b-a4b-it": TOGGLE,
  "google/gemma-4-31b-it": TOGGLE,
  "openai/gpt-oss-120b": EFFORT_HARMONY,
  "openai/gpt-oss-20b": EFFORT_HARMONY,
};

// The relay returns DeepSeek-style `reasoning_content` for these families and
// accepts it back on assistant messages (verified with a tool follow-up). Kimi,
// GPT-OSS and GLM-5.3 Flash return `reasoning` on this relay instead, which the
// schema does not name, so nothing is claimed for them.
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
// Families whose disable wire is not `reasoning_effort = "none"`.
const TOGGLE_WIRE: Record<string, string> = {
  "minimax/MiniMax-M3": "Toggle: thinking.type = enabled|disabled (reasoning_effort = \"none\" does not stop thinking on this relay).",
};
// Families whose thinking cannot be disabled on this relay.
const ALWAYS_ON_NOTE: Record<string, string> = {
  "zhipuai/glm-5.3": "Thinking cannot be disabled (reasoning_effort = \"none\" leaks the thinking into content).",
  "zhipuai/glm-5.3-flash": "Thinking cannot be disabled (reasoning_effort = \"none\" still returns reasoning).",
};

function controlStatement(baseModel: string, options: ReasoningOptions | undefined) {
  if (options === undefined) return "No reasoning control on this endpoint.";
  if (options.length === 0) return "Always-on reasoning: no caller control is offered.";
  const parts: string[] = [];
  for (const option of options) {
    if (option.type === "toggle") {
      parts.push(TOGGLE_WIRE[baseModel] ?? (OFF_BY_DEFAULT.has(baseModel)
        ? "Toggle: reasoning_effort = \"none\" (off, the default) | any effort such as \"high\" (on)."
        : "Toggle: reasoning_effort = \"none\" (off) | any other value (on); thinking.type is ignored."));
    } else if (option.type === "effort") {
      const graded = option.values.filter((value) => value !== "none").join("|");
      parts.push(option.values.includes("none")
        ? `Off is reasoning_effort = none; graded levels ${graded} are forwarded to the model, no toggle.`
        : `Effort: reasoning_effort = ${graded}, forwarded to the model.`);
    }
  }
  const note = ALWAYS_ON_NOTE[baseModel];
  return note === undefined ? parts.join(" ") : `${parts.join(" ")} ${note}`;
}

function parasailHeader(model: ParasailEndpoint, baseModel: string) {
  return [
    `Parasail OpenAI Chat (POST https://api.parasail.io/v1/chat/completions)`,
    `model = "${model.externalAlias}" (${model.modelName ?? "unknown upstream"}).`,
    `${controlStatement(baseModel, REASONING_OPTIONS[baseModel])} Verified against the endpoint on ${VERIFIED_ON}.`,
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
  TheDrummer: "thedrummer",
  Gryphe: "gryphe",
  Sao10K: "sao10k",
};

// Re-uploads under a hosting organisation: the lab is inferred from the model name.
const REUPLOAD_ORGS = new Set(["RedHatAI", "parasail-ai", "nvidia", "bighuggyd"]);

// Explicit model-name overrides where normalisation cannot recover the lab ID.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": "meta/llama-4-maverick-17b-instruct",
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506": "mistral/mistral-small-2506",
  "meta-llama/Llama-3.2-3B-Instruct": "meta/llama-3.2-3b",
  "parasail-ai/Mistral-Nemo-Instruct-2407-FP8": "mistral/mistral-nemo",
  "parasail-ai/qwen2.5-vl-72b-instruct-fp8-dynamic": "alibaba/qwen2-5-vl-72b-instruct",
  "Gryphe/MythoMax-L2-13b": "gryphe/mythomax-13b",
  "Sao10K/L3-8B-Lunaris-v1": "sao10k/lunaris-8b",
  "TheDrummer/UnslopNemo-12B-v4.1": "thedrummer/unslopnemo-12b",
  "bighuggyd/thedrummer_skyfall-36b-v2-fp8-dynamic": "thedrummer/skyfall-36b-v2",
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
  const candidate = `${lab}/${modelPart.toLowerCase()}`;
  return resolveCanonicalBaseModel(candidate) ?? resolveModelMetadataBaseModel(candidate);
}
