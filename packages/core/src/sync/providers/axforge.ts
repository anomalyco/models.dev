import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

// AxForge's model list, public and without a key: each serving model once, by the id it is called by.
const API_ENDPOINT = "https://api.axforge.ai/v1/public/models";

export const AxForgeModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
  display_name: z.string().optional(),
  // chat, decision, embeddings, rerank, image, speech, transcription, ocr, music
  type: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  input: z.array(z.string()).optional(),
  tools: z.boolean().optional(),
}).passthrough();

const AxForgeResponse = z.object({
  object: z.literal("list"),
  data: z.array(AxForgeModel),
}).passthrough();

export type AxForgeModel = z.infer<typeof AxForgeModel>;

export function parseAxForgeModels(raw: unknown) {
  return AxForgeResponse.parse(raw).data;
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "axforge", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchAxForgeModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`AxForge models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Chat models only: the list's other kinds (embeddings, OCR, speech, ...) are not catalogued here yet.
// A chat model the list has and the catalog lacks becomes a missing-model issue (its metadata is hand-authored);
// one the list drops keeps its file, so a model reloading at sync time is never removed. AxForge removes a retired
// model by its own pull request.
export const axforge = {
  id: "axforge",
  name: "AxForge",
  modelsDir: "providers/axforge/models",
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    return model.type === undefined || model.type === "chat" ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AxForge chat models returned by the API are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchAxForgeModels();
  },
  parseModels: parseAxForgeModels,
  translateModel(model, context) {
    if (model.type !== undefined && model.type !== "chat") return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<AxForgeModel>;
