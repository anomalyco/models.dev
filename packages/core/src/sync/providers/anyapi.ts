import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.anyapi.ai/v1/models";

const AnyAPIModel = z.object({
  id: z.string(),
});

const AnyAPIResponse = z.object({
  data: z.array(AnyAPIModel.passthrough()),
}).passthrough();

export type AnyAPIModel = z.infer<typeof AnyAPIModel>;

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "anyapi", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export const anyapi = {
  id: "anyapi",
  name: "AnyAPI",
  modelsDir: "providers/anyapi/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AnyAPI models returned by the API were not created because the /v1/models endpoint is not authoritative beyond model IDs. Existing models are still updated while new models require hand-authored metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.ANYAPI_API_KEY;
    if (!key) {
      throw new Error("ANYAPI_API_KEY environment variable is required");
    }
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: "Bearer " + key },
    });
    if (!response.ok) {
      throw new Error("AnyAPI request failed: " + response.status + " " + response.statusText);
    }
    return response.json();
  },
  parseModels(raw) {
    return AnyAPIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<AnyAPIModel>;
