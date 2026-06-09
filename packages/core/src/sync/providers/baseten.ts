import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://inference.baseten.co/v1/models";

const Price = z.union([z.string(), z.number()]);

export const BasetenModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  pricing: z.object({
    prompt: Price,
    completion: Price,
  }).passthrough(),
  supported_features: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
}).passthrough();

export const BasetenResponse = z.object({
  data: z.array(BasetenModel),
}).passthrough();

export type BasetenModel = z.infer<typeof BasetenModel>;

export const baseten = {
  id: "baseten",
  name: "Baseten",
  modelsDir: "providers/baseten/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Baseten models were not created because their slugs could not be mapped exactly to provider-agnostic metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Baseten models were absent from the catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.BASETEN_API_KEY;
    if (key === undefined) throw new Error("Baseten sync requires BASETEN_API_KEY");
    return fetchBasetenModels(key);
  },
  parseModels(raw) {
    return BasetenResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing === undefined
      ? resolveBasetenBaseModel(model.id)
      : existing.base_model;
    if (existing === undefined && baseModel === undefined) return undefined;
    if (
      existing === undefined
      && (price(model.pricing.prompt) === undefined || price(model.pricing.completion) === undefined)
    ) return undefined;

    return {
      id: model.id,
      model: buildBasetenModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<BasetenModel>;

export async function fetchBasetenModels(
  key: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Api-Key ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Baseten models request failed: ${response.status} ${response.statusText}`);
  }
  return BasetenResponse.parse(await response.json());
}

function price(value: string | number | undefined) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

export function buildBasetenModel(
  model: BasetenModel,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveBasetenBaseModel(model.id) : existing.base_model,
): SyncedModel {
  const features = new Set(model.supported_features);
  const samplingParameters = new Set(model.supported_sampling_parameters);
  const input = modalities(model.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing?.modalities?.output ?? ["text"]);
  const inputCost = price(model.pricing.prompt);
  const outputCost = price(model.pricing.completion);
  const cost = inputCost !== undefined && outputCost !== undefined
    ? {
        input: inputCost,
        output: outputCost,
        reasoning: existing?.cost?.reasoning,
        cache_read: existing?.cost?.cache_read,
        cache_write: existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const limit = {
    context: model.context_length,
    input: existing?.limit?.input,
    output: model.max_completion_tokens,
  };
  const values: Partial<SyncedFullModel> = {
    name: model.name ?? existing?.name,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment: input.some((value) => value !== "text"),
    reasoning: features.has("reasoning") || existing?.reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature: samplingParameters.has("temperature"),
    tool_call: features.has("tools") || existing?.tool_call,
    structured_output: features.has("structured_outputs") || existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    if (limit.context === undefined || limit.output === undefined) {
      throw new Error(`Baseten model ${model.id} has incomplete token limits required for sync`);
    }
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  const required = z.object({
    name: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`Baseten model ${model.id} has incomplete local metadata required for sync`);
  }
  return values as SyncedFullModel;
}

export function resolveBasetenBaseModel(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const canonicalPrefix = {
    "deepseek-ai": "deepseek",
    MiniMaxAI: "minimax",
    moonshotai: "moonshotai",
    nvidia: "nvidia",
    "zai-org": "zai",
  }[prefix];
  if (canonicalPrefix === undefined) return resolveCanonicalBaseModel(id);
  return resolveCanonicalBaseModel(`${canonicalPrefix}/${parts.join("/").toLowerCase()}`);
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}
