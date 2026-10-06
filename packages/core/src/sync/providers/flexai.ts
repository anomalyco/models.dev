import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = process.env.FLEXAI_MODELS_URL ?? "https://api.flex.ai/v1/models";

// FlexAI serves a fixed, operator-curated fleet, so every served id maps to an
// authored base model. Keys are the served ids, which are also the file names
// (the catalog id is the id a client sends); values are each file's base_model. An id absent from this map is reported as a missing
// model rather than authored automatically: the entries carry probed facts the
// API does not express (see translateModel).
const BaseModels: Record<string, string> = {
  "DeepSeek-V4-Flash-0731": "deepseek/deepseek-v4-flash-0731",
  "DeepSeek-V4.1-Flash": "deepseek/deepseek-v4.1-flash",
  "FLUX.1-schnell": "black-forest-labs/flux.1-schnell",
  "GLM-4.5-Air-FP8": "zhipuai/glm-4.5-air",
  "GLM-5.2": "zhipuai/glm-5.2",
  "GLM-5.3-Flash": "zhipuai/glm-5.3-flash",
  "Kokoro-82M": "hexgrad/kokoro-82m",
  "Llama-3.3-70B-Instruct-FP8": "meta/llama-3.3-70b-instruct",
  "Meta-Llama-3.1-8B-Instruct-FP8": "meta/llama-3.1-8b-instruct",
  "MiniMax-M2.7": "minimax/MiniMax-M2.7",
  "Mistral-Nemo-Instruct-2407-FP8": "mistral/mistral-nemo",
  "Muse-Glimmer-30B": "meta/muse-glimmer-30b",
  "NVIDIA-Nemotron-3.5-Lightning-30B-A3B": "nvidia/nemotron-3.5-lightning",
  "PaddleOCR-VL": "paddlepaddle/paddleocr-vl",
  "Qwen3-30B-A3B-Thinking-2507-FP8": "alibaba/qwen3-30b-a3b-thinking-2507",
  "Qwen3-8B-FP8": "alibaba/qwen3-8b",
  "Qwen3-Coder-30B-A3B-Instruct-FP8": "alibaba/qwen3-coder-30b-a3b-instruct",
  "Qwen3.5-9B": "alibaba/qwen3.5-9b",
  "Qwen3.6-27B-FP8": "alibaba/qwen3.6-27b",
  "Qwen3.6-35B-A3B-FP8": "alibaba/qwen3.6-35b-a3b",
  "Qwen3.8-27B": "alibaba/qwen3.8-27b",
  "Qwen3.8-Flash-Next": "alibaba/qwen3.8-flash-next",
  "Step-3.7-Flash": "stepfun/step-3.7-flash",
  "bge-m3": "baai/bge-m3",
  "gemma-4-26B-A4B-it": "google/gemma-4-26b-a4b-it",
  "gemma-4-31b-it": "google/gemma-4-31b-it",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "gpt-oss-20b": "openai/gpt-oss-20b",
  "parakeet-tdt-0.6b-v3": "nvidia/parakeet-tdt-0.6b-v3",
  "whisper-large-v3-turbo": "openai/whisper-large-v3-turbo",
};

// Toggle wire per model where it is not thinking.type. On these models
// thinking.type is accepted but does not disable reasoning; the chat-template
// switch does (measured 2026-10-05).
const ToggleWire: Record<string, string> = {
  "Qwen3.8-27B": "chat_template_kwargs.enable_thinking = true | false",
  "Qwen3.8-Flash-Next": "chat_template_kwargs.enable_thinking = true | false",
};
const DEFAULT_TOGGLE_WIRE = 'thinking.type = "enabled" | "disabled"';

const FlexAIPricing = z
  .object({
    input_per_mtok: z.number().nonnegative().nullish(),
    output_per_mtok: z.number().nonnegative().nullish(),
    cached_input_per_mtok: z.number().nonnegative().nullish(),
  })
  .passthrough();

const FlexAIModel = z
  .object({
    id: z.string(),
    context_length: z.number().int().positive().nullish(),
    pricing: FlexAIPricing.nullish(),
    media_pricing: z.unknown().nullish(),
  })
  .passthrough();

export const FlexAIResponse = z
  .object({
    data: z.array(FlexAIModel),
  })
  .passthrough();

export type FlexAIModel = z.infer<typeof FlexAIModel>;

export const flexai = {
  id: "flexai",
  name: "FlexAI",
  modelsDir: "providers/flexai/models",
  // Update-only. Every FlexAI entry carries probed facts /v1/models cannot
  // express, so a generated file would be wrong in ways validation cannot see.
  skipCreates: true,
  trackMissingModels: true,
  // Never delete. FlexAI's catalog is liveness-filtered with no hysteresis: a
  // model whose single replica is cycling leaves /v1/models within ~30-60s and
  // returns as soon as it is serveable again. Deleting on absence would make
  // this listing flap with the fleet rather than track the offering.
  deleteMissing: false,
  async fetchModels() {
    // /v1/models requires a bearer token. A zero-balance key is sufficient and
    // is what should be used here: discovery is budget-exempt upstream, while
    // inference on such a key is refused, so the credential cannot spend.
    const key = process.env.FLEXAI_API_KEY;
    if (key === undefined) throw new Error("FlexAI sync requires FLEXAI_API_KEY");
    const response = await fetch(API_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) {
      throw new Error(`FlexAI models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return FlexAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // The catalog id is the served id (e.g. "Qwen3-8B-FP8"): it is what a
    // client sends, and FlexAI rejects the base model's path-style id. The base
    // model (e.g. "alibaba/qwen3-8b") is only what the entry extends.
    const baseModel = BaseModels[model.id];
    if (baseModel === undefined) return undefined;
    const existing = context.existing(model.id);
    const translated = buildFlexAIModel(model, existing?.base_model ?? baseModel, existing);
    return {
      id: model.id,
      model: translated,
      header: reasoningHeader(model.id, translated),
    };
  },
  missingModelID(model) {
    return BaseModels[model.id] === undefined ? model.id : undefined;
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) are not present in FlexAI /v1/models and were retained: ${paths.join(", ")}`,
    ];
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} remote model(s) are served by FlexAI but were not created because FlexAI sync is update-only: ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<FlexAIModel>;

/**
 * Leading wire comment for a model with a reasoning control.
 *
 * Only the leading header block survives re-serialisation -- every other
 * comment in the file is dropped on the next sync -- so the wire path has to
 * live here rather than beside the option it documents.
 */
function reasoningHeader(id: string, model: SyncedModel): string | undefined {
  const options = (model as { reasoning_options?: { type: string }[] })
    .reasoning_options;
  if (!options || options.length === 0) return undefined;
  const lines = [];
  if (options.some((option) => option.type === "toggle")) {
    lines.push(`# Toggle: ${ToggleWire[id] ?? DEFAULT_TOGGLE_WIRE}`);
  }
  if (options.some((option) => option.type === "effort")) {
    lines.push("# Effort: reasoning_effort = <one of the values below>");
  }
  if (lines.length === 0) return undefined;
  lines.push("# https://docs.flex.ai/inference-api/agents/langchain");
  return lines.join("\n") + "\n";
}

/**
 * Token cost from the API, in the catalog's per-1M unit.
 *
 * Media models (image, speech, transcription) are priced per unit rather than
 * per token and carry `media_pricing` instead; they get no `[cost]` block, in
 * line with the other per-unit entries in the catalog.
 */
function flexaiCost(model: FlexAIModel): SyncedFullModel["cost"] {
  if (model.media_pricing !== null && model.media_pricing !== undefined) return undefined;
  const pricing = model.pricing;
  if (!pricing) return undefined;
  const { input_per_mtok: input, output_per_mtok: output, cached_input_per_mtok: cacheRead } = pricing;
  if (input === null || input === undefined || output === null || output === undefined) return undefined;
  return {
    input,
    output,
    ...(cacheRead === null || cacheRead === undefined ? {} : { cache_read: cacheRead }),
  };
}

function buildFlexAIModel(
  model: FlexAIModel,
  baseModel: string,
  existing: ExistingModel | undefined,
): SyncedModel {
  // `context` is the served window, which can differ from the base model's
  // published one. `output` is deliberately NOT taken from the API: FlexAI
  // reports max_output_length as a mirror of context_length on every row, so
  // it states no real output cap and publishing it would invent a limit.
  const limit = model.context_length
    ? { context: model.context_length, input: existing?.limit?.input, output: existing?.limit?.output }
    : existing?.limit;

  // Cost and context are the fields that actually drift and are authoritative
  // from the API. Everything else is preserved: reasoning behaviour, the
  // reasoning side channel and accepted input modalities are PROBED facts that
  // /v1/models does not carry, so re-deriving them here would overwrite
  // measurement with assumption.
  return factorBaseModel(
    baseModel,
    {
      cost: flexaiCost(model) ?? existing?.cost,
      reasoning: existing?.reasoning,
      reasoning_options: existing?.reasoning_options,
      interleaved: existing?.interleaved,
      // Preserved, not re-derived: /v1/models under-reports here. It lists
      // DeepSeek V4.1 Flash as text-only when it reads images, and it cannot
      // express that a model accepts an image part and ignores it. It also
      // cannot express that the base entry's video input is not served.
      modalities: existing?.modalities,
      status: existing?.status,
      limit,
    },
    limit,
    existing?.base_model_omit,
  );
}
