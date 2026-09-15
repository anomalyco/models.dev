import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.novita.ai/openai/v1/models";

export const NovitaAIModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
}).passthrough();

export const NovitaAIResponse = z.object({
  // Novita's endpoint currently omits the OpenAI-compatible top-level object.
  // Keep accepting the standard value if the API adds it later.
  object: z.literal("list").optional(),
  data: z.array(NovitaAIModel),
}).passthrough();

export type NovitaAIModel = z.infer<typeof NovitaAIModel>;

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "novita-ai", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchNovitaAIModels(key: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Novita AI models request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const novitaAi = {
  id: "novita-ai",
  name: "Novita AI",
  modelsDir: "providers/novita-ai/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Novita AI models returned by the API were not created because the catalog requires hand-authored metadata for new models.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.NOVITA_API_KEY;
    if (key === undefined) throw new Error("Novita AI sync requires NOVITA_API_KEY");
    return fetchNovitaAIModels(key);
  },
  parseModels(raw) {
    return NovitaAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<NovitaAIModel>;
