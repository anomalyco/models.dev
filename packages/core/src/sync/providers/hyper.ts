import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";
import { resolveVeniceBaseModel } from "./venice.js";

const API_ENDPOINT = "https://hyper.charm.land/v1/models";

const ReasoningEffort = z.enum([
  "default",
  "max",
  "low",
  "high",
  "none",
  "medium",
  "minimal",
  "xhigh",
]);

export const HyperModel = z.object({
  id: z.string(),
  created: z.number(),
  display_name: z.string(),
  supports_reasoning: z.boolean(),
  supports_reasoning_effort: z.boolean(),
  reasoning_effort_levels: z.array(z.string()).optional(),
  supports_attachments: z.boolean(),
  context_window: z.number(),
  max_output_tokens: z.number(),
}).passthrough();

export const HyperResponse = z.object({
  data: z.array(HyperModel),
}).passthrough();

export type HyperModel = z.infer<typeof HyperModel>;

const BASE_MODEL_ALIASES: Record<string, string> = {
  "llama-4-maverick-17b-128e-instruct-fp8": "meta/llama-4-maverick-17b-instruct",
  "minimax-m2.7": "minimax/MiniMax-M2.7",
  "qwen3-coder-480b-a35b-instruct-int4-mixed-ar": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3.6-max": "alibaba/qwen3.6-max-preview",
};

export const hyper = {
  id: "hyper",
  name: "Charm Hyper",
  modelsDir: "providers/hyper/models",
  preserveBaseModels: false,
  async fetchModels() {
    const headers = process.env.HYPER_API_KEY !== undefined
      ? { Authorization: `Bearer ${process.env.HYPER_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Hyper models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HyperResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model
      ?? BASE_MODEL_ALIASES[model.id]
      ?? resolveVeniceBaseModel(model.id, model.display_name)
      ?? undefined;
    return {
      id: model.id,
      model: buildHyperModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<HyperModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function reasoningOptions(model: HyperModel) {
  if (!model.supports_reasoning) return [];
  if (model.supports_reasoning_effort) {
    const values = model.reasoning_effort_levels?.filter(isReasoningEffort) ?? [];
    if (values.length > 0) return [{ type: "effort" as const, values }];
  }
  return [{ type: "toggle" as const }];
}

function isReasoningEffort(value: string): value is z.infer<typeof ReasoningEffort> {
  return ReasoningEffort.safeParse(value).success;
}

export function buildHyperModel(
  model: HyperModel,
  existing: ExistingModel | undefined,
  baseModel: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const limit = {
    context: model.context_window,
    input: existing?.limit?.input,
    output: model.max_output_tokens,
  };
  const values: Partial<SyncedFullModel> = {
    attachment: model.supports_attachments,
    reasoning: model.supports_reasoning,
    reasoning_options: reasoningOptions(model),
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? today,
    interleaved: existing?.interleaved,
    cost: existing?.cost,
    limit,
  };

  if (baseModel === undefined) {
    throw new Error(`Hyper model ${model.id} has no matching base_model metadata`);
  }

  return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}
