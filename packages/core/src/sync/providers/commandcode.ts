import { z } from "zod";
import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.commandcode.ai/provider/v1/models";

export const CommandCodeModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  context_length: z.number(),
}).passthrough();

export const CommandCodeResponse = z.object({
  data: z.array(CommandCodeModel),
}).passthrough();

export type CommandCodeModel = z.infer<typeof CommandCodeModel>;

export const commandcode = {
  id: "commandcode",
  name: "Command Code",
  modelsDir: "providers/commandcode/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Command Code request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return CommandCodeResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildCommandCodeModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<CommandCodeModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function buildCommandCodeModel(
  model: CommandCodeModel,
  existing: ExistingModel | undefined,
  baseModel?: string,
): SyncedModel {
  const name = model.name;
  const reasoning = true;
  const reasoning_options = existing?.reasoning_options ?? [
    { type: "effort" as const, values: ["low", "medium", "high"] },
  ];
  const context = model.context_length;
  const limit = {
    context,
    output: Math.floor(context / 4),
  };
  const releaseDate = dateFromTimestamp(model.created);
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
          limit,
        }),
        reasoning_options,
        release_date: releaseDate,
        last_updated: releaseDate,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit: { context },
      },
      { context },
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
      limit,
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
    limit,
    modalities: { input: ["text"], output: ["text"] },
  } satisfies SyncedFullModel;
}
