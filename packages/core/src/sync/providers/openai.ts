import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://api.openai.com/v1/models";

export const OpenAIModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
}).passthrough();

const OpenAIResponse = z.object({
  object: z.literal("list"),
  data: z.array(OpenAIModel),
}).passthrough();

export type OpenAIModel = z.infer<typeof OpenAIModel>;

function isFirstPartyModel(model: OpenAIModel) {
  return !model.id.startsWith("ft:")
    && (model.owned_by === "system" || model.owned_by.startsWith("openai"));
}

export function parseOpenAIModels(raw: unknown) {
  return OpenAIResponse.parse(raw).data.filter(isFirstPartyModel);
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "openai", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchOpenAIModels(key: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`OpenAI models request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export const openai = {
  id: "openai",
  name: "OpenAI",
  modelsDir: "providers/openai/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} first-party OpenAI models returned by the API are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.OPENAI_API_KEY;
    if (key === undefined) throw new Error("OpenAI sync requires OPENAI_API_KEY");
    return fetchOpenAIModels(key);
  },
  parseModels: parseOpenAIModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<OpenAIModel>;
