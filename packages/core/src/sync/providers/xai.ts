import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_BASE = "https://api.x.ai/v1";

const XAIModel = z.object({
  id: z.string(),
  canonical_id: z.string().optional(),
  created: z.number().int().nonnegative(),
  aliases: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  prompt_text_token_price: z.number().int().nonnegative().optional(),
  cached_prompt_text_token_price: z.number().int().nonnegative().optional(),
  completion_text_token_price: z.number().int().nonnegative().optional(),
  max_prompt_length: z.number().int().nonnegative().optional(),
}).passthrough();

const XAIModelList = z.object({
  models: z.array(XAIModel),
}).passthrough();

const XAIResponse = z.object({
  models: z.array(XAIModel),
});

const XAIAPIKey = z.object({
  acls: z.array(z.string()),
}).passthrough();

export type XAIModel = z.infer<typeof XAIModel>;

export const xai = {
  id: "xai",
  name: "xAI",
  modelsDir: "providers/xai/models",
  skipCreates: true,
  sourceID(model) {
    // Alias rows (canonical_id set) exist only to update already-cataloged
    // alias TOMLs; the canonical row carries the missing-model signal, so
    // skipped aliases must not be reported as missing models.
    return model.canonical_id === undefined ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} xAI models returned by the API were not created because the Models API does not provide enough authoritative metadata for the catalog, especially output token limits and some feature/capability flags. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.XAI_API_KEY;
    if (key === undefined) throw new Error("xAI sync requires XAI_API_KEY");
    await assertFullModelAccess(key);

    const models = await Promise.all([
      fetchTypedModels(key, "language-models"),
      fetchTypedModels(key, "image-generation-models"),
      fetchTypedModels(key, "video-generation-models"),
    ]);

    return { models: models.flat() };
  },
  parseModels(raw) {
    const models = XAIResponse.parse(raw).models;
    const seen = new Set<string>();
    const expanded: XAIModel[] = [];

    for (const model of models) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        // Strip any API-provided canonical_id: sourceID relies on it being set
        // exclusively by the synthetic alias expansion below, so an API row
        // carrying it must not be mistaken for an alias and silently skipped.
        expanded.push({ ...model, canonical_id: undefined });
      }
    }

    for (const model of models) {
      for (const alias of model.aliases ?? []) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        expanded.push({ ...model, id: alias, canonical_id: model.id });
      }
    }

    return expanded;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing === undefined) return undefined;

    return {
      id: model.id,
      model: buildXAIModel(model, existing),
    };
  },
} satisfies SyncProvider<XAIModel>;

async function assertFullModelAccess(key: string) {
  const response = await fetch(`${API_BASE}/api-key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`xAI API key metadata request failed: ${response.status} ${response.statusText}`);
  }

  const apiKey = XAIAPIKey.parse(await response.json());
  if (!apiKey.acls.includes("api-key:model:*")) {
    throw new Error("xAI sync requires XAI_API_KEY to include api-key:model:* so the model list is not ACL-filtered");
  }
}

async function fetchTypedModels(key: string, endpoint: string) {
  const response = await fetch(`${API_BASE}/${endpoint}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`xAI ${endpoint} request failed: ${response.status} ${response.statusText}`);
  }

  return XAIModelList.parse(await response.json()).models;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[] | undefined, fallback: Modality[]) {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  if (result.includes("image")) result.push("pdf");
  return [...new Set(result.length > 0 ? result : fallback)];
}

function tokenPrice(value: number | undefined) {
  if (value === undefined) return undefined;
  return value / 10_000;
}

function preservedCostTiers(existing: ExistingModel) {
  // The xAI models API exposes base pricing only; long-context tiers are curated from xAI docs/console.
  return existing.cost?.tiers;
}

function cost(model: XAIModel, existing: ExistingModel) {
  const input = tokenPrice(model.prompt_text_token_price);
  const output = tokenPrice(model.completion_text_token_price);
  if (input === undefined || output === undefined) return existing.cost;

  return {
    input,
    output,
    reasoning: existing.cost?.reasoning,
    cache_read: tokenPrice(model.cached_prompt_text_token_price),
    cache_write: existing.cost?.cache_write,
    input_audio: existing.cost?.input_audio,
    output_audio: existing.cost?.output_audio,
    tiers: preservedCostTiers(existing),
  };
}

export function buildXAIModel(model: XAIModel, existing: ExistingModel): SyncedModel {
  const name = existing.name;
  const description = existing.description;
  const attachment = existing.attachment;
  const reasoning = existing.reasoning;
  const toolCall = existing.tool_call;
  const openWeights = existing.open_weights;
  const limit = existing.limit;
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;

  if (
    name === undefined
    || attachment === undefined
    || reasoning === undefined
    || toolCall === undefined
    || openWeights === undefined
    || limit === undefined
    || releaseDate === undefined
    || lastUpdated === undefined
  ) {
    throw new Error(`xAI model ${model.id} has incomplete local TOML metadata required for sync`);
  }

  const input = modalities(model.input_modalities, existing.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing.modalities?.output ?? ["text"]);

  const values = {
    name,
    description: description ?? describeModel({
      id: model.id,
      name,
      family: existing.family,
      reasoning,
      tool_call: toolCall,
      structured_output: existing.structured_output,
      open_weights: openWeights,
      limit: {
        input: limit.input,
        context: model.max_prompt_length ?? limit.context,
        output: limit.output,
      },
      modalities: { input, output },
    }),
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: existing.reasoning_options,
    temperature: existing.temperature,
    tool_call: toolCall,
    structured_output: existing.structured_output,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    cost: cost(model, existing),
    limit: {
      input: limit.input,
      context: model.max_prompt_length ?? limit.context,
      output: limit.output,
    },
    modalities: { input, output },
  } satisfies SyncedFullModel;

  return existing.base_model === undefined
    ? values
    : factorBaseModel(existing.base_model, values, values.limit, existing.base_model_omit);
}
