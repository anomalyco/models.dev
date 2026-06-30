import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.pioneer.ai/v1/models";

const Capability = z
  .object({
    supported: z.boolean(),
  })
  .passthrough();

export const PioneerModel = z
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

export const PioneerResponse = z
  .object({
    data: z.array(PioneerModel),
  })
  .passthrough();

export type PioneerModel = z.infer<typeof PioneerModel>;

export const pioneer = {
  id: "pioneer",
  name: "Pioneer",
  modelsDir: "providers/pioneer/models",
  skipCreates: true,
  deleteMissing: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Pioneer request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return PioneerResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildPioneerModel(
        model,
        context.existing(model.id),
        context.authored(model.id),
      ),
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

function buildPioneerModel(
  model: PioneerModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
): SyncedModel {
  const status = model.deprecated === true ? "deprecated" : existing?.status;

  if (existing?.base_model !== undefined) {
    return stripInheritedMetadata({
      ...existing,
      reasoning_options: authored?.reasoning_options,
      status,
      limit: {
        context: model.max_input_tokens,
        input: existing.limit?.input,
        output: model.max_tokens,
      },
    });
  }

  const input = [
    "text",
    supported(model, "image_input") ? "image" : undefined,
    supported(model, "pdf_input") ? "pdf" : undefined,
  ].filter((value): value is "text" | "image" | "pdf" => value !== undefined);

  return {
    name: existing?.name ?? model.display_name,
    family: existing?.family,
    release_date: existing?.release_date ?? dateFromModel(model),
    last_updated: existing?.last_updated ?? dateFromModel(model),
    attachment: input.some((value) => value !== "text"),
    reasoning: supported(model, "thinking"),
    reasoning_options: authored?.reasoning_options ?? existing?.reasoning_options,
    temperature: existing?.temperature ?? true,
    tool_call: existing?.tool_call ?? true,
    structured_output: supported(model, "structured_outputs") || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status,
    interleaved: existing?.interleaved,
    cost: existing?.cost,
    limit: {
      context: model.max_input_tokens,
      input: existing?.limit?.input,
      output: model.max_tokens,
    },
    modalities: { input, output: ["text"] },
  };
}

function stripInheritedMetadata(model: SyncedModel): SyncedModel {
  const {
    name: _name,
    family: _family,
    release_date: _releaseDate,
    last_updated: _lastUpdated,
    attachment: _attachment,
    reasoning: _reasoning,
    temperature: _temperature,
    tool_call: _toolCall,
    structured_output: _structuredOutput,
    knowledge: _knowledge,
    open_weights: _openWeights,
    modalities: _modalities,
    ...providerOverrides
  } = model;

  return providerOverrides;
}
