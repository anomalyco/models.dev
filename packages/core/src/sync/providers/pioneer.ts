import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const baseModelReasoningCache = new Map<string, boolean>();

/** Whether the base model's authored metadata declares it a reasoning model. */
function baseModelReasoning(modelID: string): boolean {
  let value = baseModelReasoningCache.get(modelID);
  if (value === undefined) {
    const parsed = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
    ) as Record<string, unknown>;
    value = parsed.reasoning === true;
    baseModelReasoningCache.set(modelID, value);
  }
  return value;
}

const API_ENDPOINT = "https://api.pioneer.ai/v1/models";

const BaseModels: Record<string, string> = {
  "Qwen/Qwen2.5-Coder-0.5B": "alibaba/qwen2.5-coder-0.5b",
  "Qwen/Qwen3-235B-A22B-Instruct-2507": "alibaba/qwen3-235b-a22b-instruct-2507",
  "Qwen/Qwen3.5-9B": "alibaba/qwen3.5-9b",
  "deepseek-ai/DeepSeek-V3": "deepseek/deepseek-v3",
  "deepseek-ai/DeepSeek-V3.1": "deepseek/deepseek-v3.1",
  "meta-llama/Llama-3.2-1B": "meta/llama-3.2-1b",
  "meta-llama/Llama-3.2-3B": "meta/llama-3.2-3b",
  "mistralai/Codestral-22B-v0.1": "mistral/codestral-22b-v0.1",
  "mistralai/Magistral-Small-2506": "mistral/magistral-small-2506",
  "mistralai/Ministral-8B-Instruct-2410": "mistral/ministral-8b-instruct-2410",
  "claude-3-7-sonnet-latest": "anthropic/claude-3-7-sonnet-20250219",
  "claude-fable-5": "anthropic/claude-fable-5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "devstral-2": "mistral/devstral-2512",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite": "google/gemini-3.5-flash-lite",
  "gemini-3.6-flash": "google/gemini-3.6-flash",
  "google/gemma-4-E2B-it": "google/gemma-4-E2B-it",
  "google/gemma-4-E4B-it": "google/gemma-4-E4B-it",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "grok-4.5": "xai/grok-4.5",
  "meta/muse-spark-1.1": "meta/muse-spark-1.1",
  "mistral-large-3": "mistral/mistral-large-2512",
  "mistral-medium-3.5": "mistral/mistral-medium-2604",
  "mistralai/Pixtral-12B-2409": "mistral/pixtral-12b",
  "moonshotai/Kimi-K2.7-Code": "moonshotai/kimi-k2.7-code",
  "moonshotai/Kimi-K3": "moonshotai/kimi-k3",
  "openai/gpt-oss-120b": "openai/gpt-oss-120b",
  "openai/gpt-oss-20b": "openai/gpt-oss-20b",
  "poolside/laguna-s-2.1": "poolside/laguna-s-2.1",
  "sakana/fugu-ultra": "sakana/fugu-ultra",
  "zai-org/GLM-5.2": "zhipuai/glm-5.2",
};

const Capability = z
  .object({
    supported: z.boolean(),
  })
  .passthrough();

const ReasoningEffortValues = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
] as const;

type ReasoningEffort = typeof ReasoningEffortValues[number];

const ReasoningEfforts = new Set<string>(ReasoningEffortValues);

const PioneerReasoningLevel = z
  .object({
    effort: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const PioneerMetadataModel = z
  .object({
    slug: z.string(),
    default_reasoning_level: z.string().nullish(),
    supported_reasoning_levels: z.array(PioneerReasoningLevel).nullish(),
  })
  .passthrough();

const PioneerServedModel = z
  .object({
    id: z.string(),
    display_name: z.string(),
    created: z.number().optional(),
    created_at: z.string().optional(),
    max_input_tokens: z.number().int().nonnegative(),
    max_tokens: z.number().int().nonnegative(),
    deprecated: z.boolean().optional(),
    input_price_per_million: z.number().nonnegative().optional(),
    output_price_per_million: z.number().nonnegative().optional(),
    cache_read_price_per_million: z.number().nonnegative().optional(),
    cache_write_price_per_million: z.number().nonnegative().optional(),
    capabilities: z
      .object({
        image_input: Capability.optional(),
        pdf_input: Capability.optional(),
        structured_outputs: Capability.optional(),
        thinking: Capability.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const PioneerModel = PioneerServedModel.extend({
  metadata: PioneerMetadataModel.optional(),
});

export const PioneerResponse = z
  .object({
    data: z.array(PioneerServedModel),
    models: z.array(PioneerMetadataModel).optional().default([]),
  })
  .passthrough();

export type PioneerModel = z.infer<typeof PioneerModel>;

export const pioneer = {
  id: "pioneer",
  name: "Pioneer",
  modelsDir: "providers/pioneer/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Pioneer request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const parsed = PioneerResponse.parse(raw);
    const metadata = new Map(parsed.models.map((model) => [model.slug, model]));
    // Pioneer /v1/models returns each served model twice: once under its real
    // id (e.g. "gpt-4o") and once under a duplicate "anthropic/pioneer/<id>"
    // alias. The aliased entries are not real catalog models; drop them so the
    // sync does not author phantom "anthropic/pioneer/*" TOMLs.
    return parsed.data
      .filter((model) => !model.id.startsWith("anthropic/pioneer/"))
      .map((model) => ({
        ...model,
        metadata: metadata.get(model.id),
      }));
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildPioneerModel(model, context.existing(model.id)),
    };
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) are not present in Pioneer /v1/models and were retained: ${paths.join(", ")}`,
    ];
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} remote model(s) are present in Pioneer /v1/models but were not created because Pioneer sync is update-only for new models: ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<PioneerModel>;

function dateFromModel(model: PioneerModel) {
  if (model.created !== undefined) return new Date(model.created * 1000).toISOString().slice(0, 10);
  if (model.created_at !== undefined) return model.created_at.slice(0, 10);
  return "2024-01-01";
}

function supported(model: PioneerModel, capability: keyof PioneerModel["capabilities"]) {
  return model.capabilities[capability]?.supported === true;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ReasoningEfforts.has(value);
}

function pioneerReasoningOptions(model: PioneerModel): SyncedFullModel["reasoning_options"] {
  const levels = model.metadata?.supported_reasoning_levels ?? [];
  if (levels.length === 0) return undefined;

  const unsupported = levels
    .map((level) => level.effort)
    .filter((effort) => !isReasoningEffort(effort));
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Pioneer reasoning effort(s) for ${model.id}: ${[...new Set(unsupported)].join(", ")}`,
    );
  }

  const values = [...new Set(levels.map((level) => level.effort).filter(isReasoningEffort))];
  return values.length > 0 ? [{ type: "effort", values }] : undefined;
}

function pioneerCost(
  model: PioneerModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] {
  // Preserve any hand-authored cost; otherwise derive from the API's
  // per-1M-token prices (which are already in the catalog's per-1M unit).
  if (existing?.cost !== undefined) return existing.cost;
  if (model.input_price_per_million === undefined || model.output_price_per_million === undefined) {
    return undefined;
  }
  return {
    input: model.input_price_per_million,
    output: model.output_price_per_million,
    ...(model.cache_read_price_per_million !== undefined
      ? { cache_read: model.cache_read_price_per_million }
      : {}),
    ...(model.cache_write_price_per_million !== undefined
      ? { cache_write: model.cache_write_price_per_million }
      : {}),
  };
}

function buildPioneerModel(
  model: PioneerModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const status = model.deprecated === true ? "deprecated" : existing?.status;
  const baseModel = existing?.base_model ?? BaseModels[model.id];
  const apiReasoningOptions = pioneerReasoningOptions(model);
  const reasoning = apiReasoningOptions !== undefined || supported(model, "thinking") || existing?.reasoning === true;
  const reasoningOptions = apiReasoningOptions ?? (reasoning ? existing?.reasoning_options : undefined);
  const interleaved = reasoning ? (existing?.interleaved ?? { field: "reasoning_content" as const }) : undefined;

  if (baseModel !== undefined) {
    const limit = {
      context: model.max_input_tokens,
      input: existing?.limit?.input,
      output: model.max_tokens,
    };
    // Pioneer reports identical boilerplate reasoning levels for every model,
    // so it is not a reliable reasoning signal. Trust the base model's authored
    // metadata: only mark reasoning / attach reasoning_options when the base
    // model is genuinely a reasoning model.
    const baseReasoning = baseModelReasoning(baseModel);
    return factorBaseModel(baseModel, {
      cost: pioneerCost(model, existing),
      reasoning: undefined,
      reasoning_options: baseReasoning
        ? (apiReasoningOptions ?? existing?.reasoning_options)
        : undefined,
      status,
      interleaved: baseReasoning ? interleaved : undefined,
      limit,
    }, limit, existing?.base_model_omit);
  }

  const input = [
    "text",
    supported(model, "image_input") ? "image" : undefined,
    supported(model, "pdf_input") ? "pdf" : undefined,
  ].filter((value): value is "text" | "image" | "pdf" => value !== undefined);

  return {
    name: existing?.name ?? model.display_name,
    description: existing?.description ?? describeModel({
      id: model.id,
      providerId: "pioneer",
      name: model.display_name,
      family: existing?.family,
      reasoning,
      tool_call: existing?.tool_call ?? true,
      structured_output: supported(model, "structured_outputs") || undefined,
      open_weights: existing?.open_weights ?? false,
      modalities: { input, output: ["text"] },
    }),
    family: existing?.family,
    release_date: existing?.release_date ?? dateFromModel(model),
    last_updated: existing?.last_updated ?? dateFromModel(model),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? true,
    tool_call: existing?.tool_call ?? true,
    structured_output: supported(model, "structured_outputs") || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status,
    interleaved,
    cost: pioneerCost(model, existing),
    limit: {
      context: model.max_input_tokens,
      input: existing?.limit?.input,
      output: model.max_tokens,
    },
    modalities: { input, output: ["text"] },
  };
}
