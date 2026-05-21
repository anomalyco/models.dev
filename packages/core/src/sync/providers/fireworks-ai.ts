import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const API_BASE = "https://api.fireworks.ai/v1";

const FireworksModel = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  createTime: z.string().optional(),
  state: z.string().optional(),
  kind: z.string().optional(),
  huggingFaceUrl: z.string().optional(),
  contextLength: z.number().int().nonnegative().optional(),
  supportsImageInput: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsServerless: z.boolean().optional(),
}).passthrough();

const FireworksResponse = z.object({
  models: z.array(FireworksModel).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();

type FireworksModel = z.infer<typeof FireworksModel>;

export const fireworksAi = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  modelsDir: "providers/fireworks-ai/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.name;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Fireworks AI models returned by the API were not created because the Models API does not provide pricing, output token limits, release dates, or complete capability metadata. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.FIREWORKS_AI_API_KEY ?? process.env.FIREWORKS_API_KEY;
    if (key === undefined) {
      throw new Error("Fireworks AI sync requires FIREWORKS_AI_API_KEY or FIREWORKS_API_KEY");
    }

    const models: FireworksModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${API_BASE}/accounts/fireworks/models`);
      url.searchParams.set("pageSize", "200");
      url.searchParams.set("filter", "supports_serverless = true");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        throw new Error(`Fireworks AI models request failed: ${response.status} ${response.statusText}`);
      }

      const page = FireworksResponse.parse(await response.json());
      models.push(...page.models ?? []);
      pageToken = page.nextPageToken || undefined;
    } while (pageToken !== undefined);

    return { models };
  },
  parseModels(raw) {
    return FireworksResponse.parse(raw).models ?? [];
  },
  translateModel(model, context) {
    const existing = context.existing(model.name);
    if (existing === undefined) return undefined;

    return {
      id: model.name,
      model: buildModel(model, existing),
    };
  },
} satisfies SyncProvider<FireworksModel>;

function buildModel(model: FireworksModel, existing: ExistingModel): SyncedModel {
  if (existing.extends !== undefined) {
    const input = existing.modalities?.input === undefined
      ? undefined
      : model.supportsImageInput === true
        ? addModality(existing.modalities.input, "image")
        : existing.modalities.input;

    return {
      ...existing,
      attachment: input === undefined ? existing.attachment : input.some((value) => value !== "text"),
      tool_call: model.supportsTools ?? existing.tool_call,
      open_weights: existing.open_weights,
      modalities: input === undefined || existing.modalities === undefined
        ? existing.modalities
        : {
            input,
            output: existing.modalities.output,
          },
      limit: existing.limit === undefined
        ? existing.limit
        : {
            input: existing.limit.input,
            context: model.contextLength && model.contextLength > 0 ? model.contextLength : existing.limit.context,
            output: existing.limit.output,
          },
    };
  }

  const name = existing.name;
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;
  const attachment = existing.attachment;
  const reasoning = existing.reasoning;
  const toolCall = existing.tool_call;
  const openWeights = existing.open_weights;
  const limit = existing.limit;
  const modalities = existing.modalities;

  if (
    name === undefined
    || releaseDate === undefined
    || lastUpdated === undefined
    || attachment === undefined
    || reasoning === undefined
    || toolCall === undefined
    || openWeights === undefined
    || limit === undefined
    || modalities === undefined
  ) {
    throw new Error(`Fireworks AI model ${model.name} has incomplete local TOML metadata required for sync`);
  }

  const input = model.supportsImageInput === true ? addModality(modalities.input, "image") : modalities.input;

  return {
    name,
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    temperature: existing.temperature,
    tool_call: model.supportsTools ?? toolCall,
    structured_output: existing.structured_output,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    cost: existing.cost,
    limit: {
      input: limit.input,
      context: model.contextLength && model.contextLength > 0 ? model.contextLength : limit.context,
      output: limit.output,
    },
    modalities: {
      input,
      output: modalities.output,
    },
  };
}

function addModality(values: Array<"text" | "audio" | "image" | "video" | "pdf">, value: "image") {
  return values.includes(value) ? values : [...values, value];
}
