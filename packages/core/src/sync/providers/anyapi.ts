import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.anyapi.ai/v1/models";

export const AnyApiModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative().optional(),
  owned_by: z.string().optional(),
}).passthrough();

const AnyApiResponse = z.object({
  object: z.literal("list"),
  data: z.array(AnyApiModel),
}).passthrough();

export type AnyApiModel = z.infer<typeof AnyApiModel>;

export function parseAnyApiModels(raw: unknown) {
  return AnyApiResponse.parse(raw).data;
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "anyapi", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchAnyApiModels(key: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`AnyAPI models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const anyapi = {
  id: "anyapi",
  name: "AnyAPI",
  modelsDir: "providers/anyapi/models",
  // The catalog endpoint exposes no pricing and no lifecycle metadata, and it
  // lists every resold route (chat, image, embedding, free variants), so it is
  // not authoritative enough to author complete provider TOMLs. It is used to
  // monitor catalog availability: existing TOMLs are preserved byte-for-byte
  // and remote-only IDs are reported for hand-authored metadata.
  skipCreates: true,
  trackMissingModels: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AnyAPI models returned by the API are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.ANYAPI_API_KEY;
    if (key === undefined || key === "") throw new Error("AnyAPI sync requires ANYAPI_API_KEY");
    return fetchAnyApiModels(key);
  },
  parseModels: parseAnyApiModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<AnyApiModel>;
