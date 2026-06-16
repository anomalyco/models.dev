import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.moonshot.ai/v1/models";

const MoonshotModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  context_length: z.number().int().positive(),
  supports_image_in: z.boolean().optional(),
  supports_video_in: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
}).passthrough();

export const MoonshotResponse = z.object({
  data: z.array(MoonshotModel),
}).passthrough();

export type MoonshotModel = z.infer<typeof MoonshotModel>;

export const moonshotai = {
  id: "moonshotai",
  name: "Moonshot AI",
  modelsDir: "providers/moonshotai/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Moonshot models returned by the API were not created because the Models API does not provide required pricing, output token limits, tool calling, structured output, or open-weight metadata. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Moonshot models were not returned by the API and were retained because the China provider references global model TOMLs through symlinks. Remove discontinued models from both providers in one reviewed change.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.MOONSHOTAI_SYNC_API_KEY;
    if (key === undefined) throw new Error("Moonshot AI sync requires MOONSHOTAI_SYNC_API_KEY");
    return fetchMoonshotModels(API_ENDPOINT, key);
  },
  parseModels(raw) {
    return MoonshotResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;
    return { id: model.id, model: buildMoonshotModel(model, existing) };
  },
} satisfies SyncProvider<MoonshotModel>;

export async function fetchMoonshotModels(
  endpoint: string,
  key: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Moonshot models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function buildMoonshotModel(model: MoonshotModel, existing: ExistingModel): SyncedModel {
  const name = existing.name;
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;
  const toolCall = existing.tool_call;
  const openWeights = existing.open_weights;
  const output = existing.limit?.output;
  const outputModalities = existing.modalities?.output;

  if (
    name === undefined
    || releaseDate === undefined
    || lastUpdated === undefined
    || toolCall === undefined
    || openWeights === undefined
    || output === undefined
    || outputModalities === undefined
  ) {
    throw new Error(`Moonshot model ${model.id} has incomplete local TOML metadata required for sync`);
  }

  const input = [
    "text" as const,
    ...(model.supports_image_in === true ? ["image" as const] : []),
    ...(model.supports_video_in === true ? ["video" as const] : []),
  ];
  const synced: SyncedFullModel = {
    name,
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment: input.length > 1,
    reasoning: model.supports_reasoning === true,
    reasoning_options: model.supports_reasoning === true ? existing.reasoning_options : undefined,
    tool_call: toolCall,
    interleaved: model.supports_reasoning === true ? existing.interleaved : undefined,
    structured_output: existing.structured_output,
    temperature: existing.temperature,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    cost: existing.cost,
    limit: {
      context: model.context_length,
      input: existing.limit?.input,
      output,
    },
    modalities: { input, output: outputModalities },
  };

  return existing.base_model === undefined
    ? synced
    : factorBaseModel(existing.base_model, synced, synced.limit, existing.base_model_omit);
}
