import { z } from "zod";
import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.openstarry.com/v1/models";

export const OpenStarryModel = z.object({
  id: z.string(),
  created: z.number(),
  supported_endpoint_types: z.array(z.string()).optional(),
}).passthrough();

export const OpenStarryResponse = z.object({
  data: z.array(OpenStarryModel),
}).passthrough();

export type OpenStarryModel = z.infer<typeof OpenStarryModel>;

export const openstarry = {
  id: "openstarry",
  name: "OpenStarry",
  modelsDir: "providers/openstarry/models",
  async fetchModels() {
    const headers = process.env.OPENSTARRY_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENSTARRY_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`OpenStarry request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OpenStarryResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildOpenStarryModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<OpenStarryModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function buildOpenStarryModel(
  model: OpenStarryModel,
  existing: ExistingModel | undefined,
  baseModel?: string,
): SyncedModel {
  const name = model.id;
  const reasoning = true;
  const reasoning_options = existing?.reasoning_options ?? [
    { type: "effort" as const, values: ["low", "medium", "high"] },
  ];
  // OpenStarry returns placeholder timestamps (2021-07-20); keep the authored
  // release date when present, otherwise fall back to today.
  const releaseDate = existing?.release_date ?? new Date().toISOString().slice(0, 10);
  const canonical = existing?.base_model ?? baseModel ?? resolveModelMetadataBaseModel(model.id);

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        name: baseModel !== undefined ? name : undefined,
        description: existing?.description ?? describeModel({
          id: model.id,
          name,
          reasoning,
          tool_call: true,
        }),
        reasoning_options,
        release_date: releaseDate,
        last_updated: releaseDate,
        status: existing?.status,
        interleaved: existing?.interleaved,
      },
      undefined,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name,
      reasoning,
      tool_call: true,
    }),
    release_date: releaseDate,
    last_updated: releaseDate,
    attachment: false,
    reasoning,
    reasoning_options,
    temperature: true,
    tool_call: true,
    open_weights: false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    limit: existing?.limit,
    modalities: { input: ["text"], output: ["text"] },
  } satisfies SyncedFullModel;
}
