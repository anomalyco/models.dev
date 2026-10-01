import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://ollama.com/v1/models";

export const OllamaCloudModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
}).passthrough();

const OllamaCloudResponse = z.object({
  object: z.literal("list"),
  data: z.array(OllamaCloudModel),
}).passthrough();

export type OllamaCloudModel = z.infer<typeof OllamaCloudModel>;

export function parseOllamaCloudModels(raw: unknown) {
  return OllamaCloudResponse.parse(raw).data;
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "ollama-cloud", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchOllamaCloudModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Ollama Cloud models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const ollamaCloud = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  modelsDir: "providers/ollama-cloud/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Ollama Cloud models returned by the API are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchOllamaCloudModels();
  },
  parseModels: parseOllamaCloudModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<OllamaCloudModel>;
