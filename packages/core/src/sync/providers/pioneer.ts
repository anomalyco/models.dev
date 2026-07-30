import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.pioneer.ai/v1/models";

const BaseModels: Record<string, string> = {
  "Qwen/Qwen3.5-9B": "alibaba/qwen3.5-9b",
  "google/gemma-4-E2B-it": "google/gemma-4-E2B-it",
  "google/gemma-4-E4B-it": "google/gemma-4-E4B-it",
  "mistral-medium-3.5": "mistral/mistral-medium-2604",
  "moonshotai/Kimi-K2.7-Code": "moonshotai/kimi-k2.7-code",
  "openai/gpt-oss-120b": "openai/gpt-oss-120b",
  "openai/gpt-oss-20b": "openai/gpt-oss-20b",
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
  // Pioneer reports 2024-01-01 for every model, so its creation dates cannot
  // support a meaningful age cutoff for remote-only model notifications.
  trackMissingModels: false,
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
    return parsed.data.map((model) => ({
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
    return factorBaseModel(baseModel, {
      cost: existing?.cost,
      reasoning: apiReasoningOptions !== undefined ? true : undefined,
      reasoning_options: reasoningOptions,
      status,
      interleaved,
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
    cost: existing?.cost,
    limit: {
      context: model.max_input_tokens,
      input: existing?.limit?.input,
      output: model.max_tokens,
    },
    modalities: { input, output: ["text"] },
  };
}
