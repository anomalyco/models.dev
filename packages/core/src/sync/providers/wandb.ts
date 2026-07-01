import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// Not the same endpoint as W&B's public /v1/models (which returns only
// {id, object, created, owned_by, root} -- no pricing, limits, or
// capability data, and `created` is always 0). This is the endpoint that
// backs wandb.ai's own model catalog UI and carries real per-model
// metadata. No API key required.
const API_ENDPOINT = "https://trace.wandb.ai/inference/analysis/artificialanalysis/models";

const WandbPricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  image: z.string().optional(),
  request: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
}).passthrough();

const WandbModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  context_length: z.number().int().nonnegative(),
  max_output_length: z.number().int().nonnegative(),
  pricing: WandbPricing.optional(),
  supported_sampling_parameters: z.array(z.string()).default([]),
  supported_features: z.array(z.string()).default([]),
}).passthrough();

const WandbResponse = z.object({
  data: z.array(WandbModel),
}).passthrough();

export type WandbModel = z.infer<typeof WandbModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const MODALITY_MAP: Record<string, Modality | undefined> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  pdf: "pdf",
  file: "pdf",
  files: "pdf",
};

const OPEN_WEIGHTS_PREFIXES = [
  "deepseek-ai/",
  "meta-llama/",
  "microsoft/",
  "MiniMaxAI/",
  "moonshotai/",
  "nvidia/",
  "OpenPipe/",
  "Qwen/",
  "zai-org/",
  "google/",
  "ibm-granite/",
  "JetBrains/",
];

// The artificialanalysis endpoint's supported_features never includes a
// "reasoning" flag (confirmed: only json_mode/structured_outputs/tools are
// ever present across all 29 models), so reasoning support has to come from
// an authoritative source, not the live API. This list is sourced from
// https://docs.wandb.ai/inference/response-settings/reasoning's "Supported
// models with reasoning" table (accessed 2026-07-02) and cross-verified with
// live chat-completions probes against api.inference.wandb.ai (see the
// Hermes Agent WandbProfile provider plugin for the per-family wire-format
// findings that motivated this cross-check). Models not listed here have no
// reasoning support on W&B, per the same source.
const REASONING_MODEL_IDS = new Set([
  "deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-ai/DeepSeek-V4-Pro",
  "deepseek-ai/DeepSeek-V3.1",
  "google/gemma-4-31B-it",
  "MiniMaxAI/MiniMax-M2.5",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
  "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
  "Qwen/Qwen3.6-35B-A3B",
  "Qwen/Qwen3.6-27B",
  "Qwen/Qwen3.5-35B-A3B",
  "Qwen/Qwen3.5-27B",
  "Qwen/Qwen3-235B-A22B-Thinking-2507",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.1",
  // Not in W&B's documented reasoning table, but OpenAI's Harmony response
  // format always emits an analysis/reasoning channel for gpt-oss; matches
  // the reasoning=true already curated in the existing gpt-oss-* TOMLs.
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
]);

export const wandb = {
  id: "wandb",
  name: "Weights & Biases",
  modelsDir: "providers/wandb/models",
  // A model temporarily absent from the live listing (maintenance, staged
  // rollout) shouldn't have its curated TOML deleted outright -- retain it
  // and surface a notice, mirroring Baseten's lifecycle-review pattern.
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  // release_date isn't in this API response (nor the plain /v1/models one),
  // so a brand-new model can't be created with authoritative data -- only
  // existing hand-authored TOMLs (which already have a curated release_date)
  // can be confirmed/updated. Mirrors xai.ts's skipCreates + skippedNotice
  // pattern for the same reason.
  skipCreates: true,
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} W&B Inference models are live on the API but not yet in the catalog. ` +
        "release_date is not provided by this endpoint (nor by W&B's plain /v1/models, which " +
        "also lacks pricing/limits/capability data), so these were not auto-created -- add TOML " +
        "files under providers/wandb/models/ with a curated release_date; all other fields " +
        "(pricing, context/output limits, modalities, tool_call, structured_output) will sync " +
        "automatically once the file exists.",
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local W&B models were absent from the live model listing and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`W&B models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return WandbResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;

    return {
      id: model.id,
      model: buildWandbModel(model, existing),
    };
  },
} satisfies SyncProvider<WandbModel>;

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const result = values
    .map((value) => MODALITY_MAP[value.toLowerCase()])
    .filter((value): value is Modality => value !== undefined);
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferOpenWeights(modelId: string) {
  return OPEN_WEIGHTS_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function inferFamily(modelId: string, modelName: string) {
  const kimiFamily = inferKimiFamily(modelId, modelName);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${modelId} ${modelName}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => target.includes(family.toLowerCase()));
}

function normalizeName(model: WandbModel) {
  const stripped = model.name.replace(/^[^:]+:\s*/, "").trim();
  return stripped || model.id.split("/").pop() || model.id;
}

export function buildWandbModel(model: WandbModel, existing: ExistingModel): SyncedModel {
  const features = new Set(model.supported_features);
  const samplingParameters = new Set(model.supported_sampling_parameters);
  const input = modalities(model.input_modalities, existing.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing.modalities?.output ?? ["text"]);
  const attachment = input.some((value) => value !== "text");
  const reasoning = existing.reasoning ?? REASONING_MODEL_IDS.has(model.id);

  const inputCost = price(model.pricing?.prompt);
  const outputCost = price(model.pricing?.completion);
  const cacheRead = price(model.pricing?.input_cache_read);
  const cacheWrite = price(model.pricing?.input_cache_write);
  const cost = inputCost !== undefined && outputCost !== undefined
    ? {
        input: inputCost,
        output: outputCost,
        cache_read: cacheRead !== undefined && cacheRead > 0 ? cacheRead : undefined,
        cache_write: cacheWrite !== undefined && cacheWrite > 0 ? cacheWrite : undefined,
      }
    : existing.cost;

  const name = existing.name ?? normalizeName(model);
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;
  const openWeights = existing.open_weights ?? inferOpenWeights(model.id);

  const limit = {
    context: model.context_length > 0 ? model.context_length : existing.limit?.context,
    input: existing.limit?.input,
    output: model.max_output_length > 0 ? model.max_output_length : existing.limit?.output,
  };

  const values = {
    name,
    family: existing.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoning ? existing.reasoning_options : undefined,
    temperature: existing.temperature ?? samplingParameters.has("temperature"),
    tool_call: existing.tool_call ?? features.has("tools"),
    structured_output: existing.structured_output ?? (features.has("structured_outputs") || undefined),
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (existing.base_model !== undefined) {
    return factorBaseModel(existing.base_model, values, limit, existing.base_model_omit);
  }

  if (releaseDate === undefined || lastUpdated === undefined) {
    throw new Error(`W&B model ${model.id} is missing release_date/last_updated in its local TOML`);
  }

  return values as SyncedModel;
}
