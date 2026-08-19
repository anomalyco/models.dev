import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://crof.ai/v1/models";

const Price = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number);

export const CrofModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number().int().nonnegative(),
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  custom_reasoning: z.boolean(),
  reasoning_effort: z.boolean().optional(),
  pricing: z.object({
    prompt: Price,
    completion: Price,
    cache_prompt: Price.optional(),
    discount: z.number().nonnegative().max(100).optional(),
  }).passthrough(),
}).passthrough();

export const CrofResponse = z.object({
  data: z.array(CrofModel),
}).passthrough();

export type CrofModel = z.infer<typeof CrofModel>;

export const crof = {
  id: "crof",
  name: "CrofAI",
  modelsDir: "providers/crof/models",
  skipCreates: true,
  deleteMissing: true,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} CrofAI models returned by the API were not created because the endpoint does not provide authoritative modalities, model capabilities, or descriptions. Existing models are still fully synchronized.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`CrofAI models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return CrofResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildCrofModel(model, existing, context.authored(model.id)),
    };
  },
} satisfies SyncProvider<CrofModel>;

export function buildCrofModel(
  model: CrofModel,
  existing: ExistingModel,
  authored: ExistingModel | undefined,
): SyncedModel {
  const required = {
    name: existing.name,
    description: existing.description,
    release_date: existing.release_date,
    last_updated: existing.last_updated,
    attachment: existing.attachment,
    temperature: existing.temperature,
    tool_call: existing.tool_call,
    open_weights: existing.open_weights,
    modalities: existing.modalities,
  };
  for (const [field, value] of Object.entries(required)) {
    if (value === undefined) throw new Error(`CrofAI model ${model.id} is missing local ${field} metadata`);
  }

  const reasoning = model.custom_reasoning;
  const limit = {
    input: existing.limit?.input,
    context: model.context_length,
    output: model.max_completion_tokens,
  };
  const synced: SyncedFullModel = {
    name: required.name!,
    description: required.description!,
    family: existing.family,
    release_date: required.release_date!,
    last_updated: required.last_updated!,
    attachment: required.attachment!,
    reasoning,
    reasoning_options: reasoning ? existing.reasoning_options ?? [] : undefined,
    temperature: required.temperature!,
    tool_call: required.tool_call!,
    structured_output: existing.structured_output,
    knowledge: existing.knowledge,
    open_weights: required.open_weights!,
    status: existing.status,
    interleaved: reasoning ? existing.interleaved : undefined,
    cost: {
      input: model.pricing.prompt,
      output: model.pricing.completion,
      cache_read: model.pricing.cache_prompt,
      cache_write: existing.cost?.cache_write,
      reasoning: existing.cost?.reasoning,
      tiers: existing.cost?.tiers,
    },
    limit,
    modalities: required.modalities!,
    provider: existing.provider,
  };

  return authored?.base_model === undefined
    ? synced
    : factorBaseModel(authored.base_model, synced, limit, authored.base_model_omit);
}
