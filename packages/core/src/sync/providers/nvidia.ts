import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://integrate.api.nvidia.com/v1/models";

export const NvidiaModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
}).passthrough();

const NvidiaResponse = z.object({
  object: z.literal("list"),
  data: z.array(NvidiaModel),
}).passthrough();

export type NvidiaModel = z.infer<typeof NvidiaModel>;

export function parseNvidiaModels(raw: unknown) {
  return NvidiaResponse.parse(raw).data;
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "nvidia", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchNvidiaModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Nvidia models request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const nvidia = {
  id: "nvidia",
  name: "Nvidia",
  modelsDir: "providers/nvidia/models",
  skipCreates: true,
  // /v1/models is a public availability listing with no lifecycle or pricing
  // metadata. Mirror the OpenAI sync: preserve hand-authored TOMLs byte for
  // byte, never create or delete, and surface remote/local deltas as notices.
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Nvidia models are served by the API but missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchNvidiaModels();
  },
  parseModels: parseNvidiaModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<NvidiaModel>;