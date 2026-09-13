import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.fireworks.ai/inference/v1/models";

export const FireworksModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
  context_length: z.number().int().positive().optional(),
  kind: z.string(),
  supports_chat: z.boolean(),
  supports_image_input: z.boolean(),
  supports_tools: z.boolean(),
}).passthrough();

export const FireworksResponse = z.object({
  object: z.literal("list"),
  data: z.array(FireworksModel),
}).passthrough();

export type FireworksModel = z.infer<typeof FireworksModel>;

export const fireworksAi = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  modelsDir: "providers/fireworks-ai/models",
  skipCreates: true,
  // The endpoint is filtered by account model-access policy. Never interpret
  // an absent row as proof that Fireworks removed a public model.
  deleteMissing: false,
  sourceID(model) {
    return supportsCatalogModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Fireworks text/vision models returned by the API were not created because the endpoint does not provide pricing, output limits, reasoning controls, or structured-output metadata. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Fireworks models were absent from this account's model list and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.FIREWORKS_API_KEY;
    if (key === undefined) throw new Error("Fireworks AI sync requires FIREWORKS_API_KEY");
    return fetchFireworksModels(key);
  },
  parseModels(raw) {
    return FireworksResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!supportsCatalogModel(model)) return undefined;
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return {
      id: model.id,
      model: buildFireworksModel(model, existing),
    };
  },
} satisfies SyncProvider<FireworksModel>;

export async function fetchFireworksModels(
  key: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Fireworks AI models request failed: ${response.status} ${response.statusText}`);
  }
  return FireworksResponse.parse(await response.json());
}

function supportsCatalogModel(model: FireworksModel) {
  return model.supports_chat && model.kind !== "EMBEDDING_MODEL";
}

type Modality = SyncedFullModel["modalities"]["input"][number];

function inputModalities(existing: Modality[], supportsImage: boolean): Modality[] {
  if (!supportsImage || existing.includes("image")) return existing;
  return [...existing, "image" as const];
}

export function buildFireworksModel(
  model: FireworksModel,
  existing: ExistingModel,
): SyncedModel {
  const name = existing.name;
  const description = existing.description;
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;
  const reasoning = existing.reasoning;
  const toolCall = existing.tool_call;
  const openWeights = existing.open_weights;
  const limit = existing.limit;
  const modalities = existing.modalities;
  const cost = existing.cost;

  if (
    name === undefined
    || description === undefined
    || releaseDate === undefined
    || lastUpdated === undefined
    || reasoning === undefined
    || toolCall === undefined
    || openWeights === undefined
    || limit === undefined
    || limit.context === undefined
    || limit.output === undefined
    || modalities === undefined
    || cost === undefined
  ) {
    throw new Error(`Fireworks AI model ${model.id} has incomplete local TOML metadata required for sync`);
  }

  const input = inputModalities(modalities.input, model.supports_image_input);
  // Fireworks reports the advertised context window, while some deployments
  // reserve a few prompt tokens. Preserve a smaller verified local cap, but
  // immediately follow any lower ceiling reported by the API.
  const context = model.context_length === undefined
    ? limit.context
    : Math.min(limit.context, model.context_length);
  const output = Math.min(limit.output, context);
  const values = {
    name,
    description,
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment: input.some((modality) => modality !== "text"),
    reasoning,
    reasoning_options: existing.reasoning_options,
    temperature: existing.temperature,
    tool_call: model.supports_tools || toolCall,
    structured_output: existing.structured_output,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    cost,
    limit: {
      context,
      input: limit.input,
      output,
    },
    modalities: {
      input,
      output: modalities.output,
    },
    provider: existing.provider,
    experimental: existing.experimental,
  } satisfies SyncedFullModel;

  return existing.base_model === undefined
    ? values
    : factorBaseModel(existing.base_model, values, values.limit, existing.base_model_omit);
}
