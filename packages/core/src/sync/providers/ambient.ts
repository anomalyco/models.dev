import { z } from "zod";

import type { SyncProvider } from "../index.js";
import { buildOpenRouterModel, type OpenRouterModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.ambient.xyz/v1/models";

export const AmbientModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number(),
  hugging_face_id: z.string().nullable().optional(),
  context_length: z.number(),
  max_output_length: z.number(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough(),
  supported_features: z.array(z.string()).default([]),
  supported_sampling_parameters: z.array(z.string()).default([]),
  openrouter: z.object({ slug: z.string() }).nullable().optional(),
  is_ready: z.boolean().default(false),
}).passthrough();

export const AmbientResponse = z.object({
  object: z.literal("list"),
  data: z.array(AmbientModel),
}).passthrough();

export type AmbientModel = z.infer<typeof AmbientModel>;

function toOpenRouterShape(model: AmbientModel): OpenRouterModel {
  return {
    id: model.openrouter?.slug ?? model.id,
    name: model.name,
    created: model.created,
    hugging_face_id: model.hugging_face_id ?? null,
    knowledge_cutoff: null,
    context_length: model.context_length,
    architecture: {
      input_modalities: model.input_modalities,
      output_modalities: model.output_modalities,
    },
    pricing: {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
      input_cache_read: model.pricing.input_cache_read,
      input_cache_write: model.pricing.input_cache_write,
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_output_length,
    },
    supported_parameters: [...model.supported_features, ...model.supported_sampling_parameters],
  };
}

export const ambient = {
  id: "ambient",
  name: "Ambient",
  modelsDir: "providers/ambient/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Ambient models were skipped because the catalog reports them as not ready (is_ready=false).`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Ambient models were absent from the catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Ambient request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AmbientResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!model.is_ready) return undefined;
    const built = buildOpenRouterModel(toOpenRouterShape(model), context.existing(model.id));
    const reasoning = model.supported_features.includes("reasoning");
    const withOptions = reasoning ? { ...built, reasoning_options: [] } : built;
    const aliasName = ambientAliasName(model.id);
    return {
      id: model.id,
      model: aliasName === undefined ? withOptions : { ...withOptions, name: aliasName },
    };
  },
} satisfies SyncProvider<AmbientModel>;

function ambientAliasName(id: string): string | undefined {
  if (!id.startsWith("ambient/")) return undefined;
  const label = id.slice("ambient/".length)
    .split(/[/-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return `Ambient ${label}`;
}
