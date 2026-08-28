import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const BASE_MODEL_ALIASES: Record<string, string> = {
  "meta-llama/llama-3.3-70b-instruct": "meta/llama-3.3-70b-instruct",
  "phala/gemma-4-26b-a4b-uncensored": "cloud19/gemma-4-26b-a4b-it-heretic-fp8-static",
  "phala/qwen3.6-35b-a3b-uncensored": "lamianlbe/qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive-fp8",
  "qwen/qwen-2.5-7b-instruct": "alibaba/qwen2.5-7b-instruct",
};

const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

const Pricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
}).passthrough();

export const AciModelSchema = z.object({
  id: z.string().min(1).refine(
    (id) => !id.includes("\\")
      && !id.includes("\0")
      && id.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Model ID must be a safe relative path",
  ),
  name: z.string().min(1),
  created: z.number().int().nonnegative(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive(),
  pricing: Pricing,
  supported_parameters: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
  supported_features: z.array(z.string()),
  hugging_face_id: z.string().min(1).nullable().optional(),
  is_tee: z.boolean(),
  providers: z.array(z.string()),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

const AciResponse = z.object({
  data: z.array(AciModelSchema),
}).passthrough();

const AciCatalogs = z.object({
  chat: AciResponse,
  embeddings: AciResponse,
}).strict();

export type AciModel = z.infer<typeof AciModelSchema> & {
  catalog: "chat" | "embedding";
};

interface AciCatalogProviderConfig {
  id: string;
  name: string;
  modelsDir: string;
  chatEndpoint: string;
  embeddingEndpoint: string;
}

export function createAciCatalogProvider(
  config: AciCatalogProviderConfig,
): SyncProvider<AciModel> {
  return {
    id: config.id,
    name: config.name,
    modelsDir: config.modelsDir,
    skipCreates: true,
    trackMissingModels: false,
    preserveBaseModels: false,
    deleteMissing: true,
    async fetchModels() {
      return fetchAciModels(
        config.name,
        config.chatEndpoint,
        config.embeddingEndpoint,
      );
    },
    parseModels(raw) {
      return parseAciModels(raw, config.name);
    },
    sourceID(model) {
      return model.id;
    },
    skippedNotice(ids) {
      if (ids.length === 0) return [];
      return [
        `${ids.length} ${config.name} models were skipped because new provider entries require reviewed canonical metadata and provider controls.`,
        `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      ];
    },
    translateModel(model, context) {
      const existing = context.existing(model.id);
      const built = buildAciCatalogModel(model, existing, config.name);
      return built === undefined ? undefined : { id: model.id, model: built };
    },
  };
}

async function fetchAciModels(
  provider: string,
  chatEndpoint: string,
  embeddingEndpoint: string,
  fetcher: typeof fetch = fetch,
) {
  const [chat, embeddings] = await Promise.all([
    fetchCatalog(provider, chatEndpoint, "chat", fetcher),
    fetchCatalog(provider, embeddingEndpoint, "embedding", fetcher),
  ]);
  return { chat, embeddings };
}

async function fetchCatalog(
  provider: string,
  endpoint: string,
  label: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(endpoint);
  if (!response.ok) {
    throw new Error(`${provider} ${label} models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseAciModels(raw: unknown, provider: string): AciModel[] {
  const catalogs = AciCatalogs.parse(raw);
  const models: AciModel[] = [
    ...catalogs.chat.data.map((model) => ({ ...model, catalog: "chat" as const })),
    ...catalogs.embeddings.data.map((model) => ({ ...model, catalog: "embedding" as const })),
  ];
  if (models.length === 0) throw new Error(`${provider} catalog returned no models`);

  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Duplicate ${provider} model ID: ${model.id}`);
    seen.add(model.id);
  }
  return models;
}

export function buildAciCatalogModel(
  model: AciModel,
  existing: ExistingModel | undefined,
  provider: string,
): SyncedModel | undefined {
  const baseModel = existing?.base_model ?? resolveAciBaseModel(model.id);
  if (baseModel === undefined) return buildExistingStandaloneModel(model, existing, provider);

  const features = new Set(model.supported_features);
  const sampling = new Set(model.supported_sampling_parameters);
  const modalities = modelModalities(model);
  const reasoning = sourceFlag(features, "reasoning", existing?.reasoning);
  const limit = sourceLimits(model);

  return factorBaseModel(
    baseModel,
    {
      name: existing?.name,
      description: existing?.description,
      attachment: modalities.input.some((value) => value !== "text"),
      reasoning,
      reasoning_options: reasoningOptions(existing, reasoning),
      temperature: sourceFlag(sampling, "temperature", existing?.temperature),
      tool_call: sourceFlag(features, "tools", existing?.tool_call),
      structured_output: features.size > 0
        ? features.has("structured_outputs") || features.has("json_mode")
        : existing?.structured_output,
      status: existing?.status,
      interleaved: existing?.interleaved,
      provider: existing?.provider,
      experimental: existing?.experimental,
      cost: modelCost(model, provider),
      limit,
      modalities,
    },
    limit,
    existing?.base_model === baseModel ? existing.base_model_omit : undefined,
  );
}

export function resolveAciBaseModel(modelID: string) {
  const normalizedID = modelID.toLowerCase();
  return BASE_MODEL_ALIASES[normalizedID] ?? resolveModelMetadataBaseModel(modelID);
}

function buildExistingStandaloneModel(
  model: AciModel,
  existing: ExistingModel | undefined,
  provider: string,
): SyncedFullModel | undefined {
  if (existing === undefined) return undefined;
  const output = trustworthyOutputLimit(model) ?? existing.limit?.output;
  if (output === undefined) return undefined;

  const features = new Set(model.supported_features);
  const sampling = new Set(model.supported_sampling_parameters);
  const modalities = modelModalities(model);
  const reasoning = sourceFlag(features, "reasoning", existing.reasoning) ?? false;
  const toolCall = sourceFlag(features, "tools", existing.tool_call) ?? false;
  const structuredOutput = features.size > 0
    ? features.has("structured_outputs") || features.has("json_mode")
    : existing.structured_output ?? false;
  const openWeights = model.hugging_face_id != null || existing.open_weights === true;
  const date = dateFromTimestamp(model.created);
  const name = existing.name ?? model.name;
  const family = existing.family;
  const limit = { context: model.context_length, input: existing.limit?.input, output };

  return {
    name,
    description: existing.description ?? model.description ?? describeModel({
      id: model.id,
      name,
      family,
      reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: openWeights,
      limit,
      modalities,
    }),
    family,
    release_date: existing.release_date ?? date,
    last_updated: existing.last_updated ?? date,
    attachment: modalities.input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions(existing, reasoning),
    temperature: sourceFlag(sampling, "temperature", existing.temperature) ?? false,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    provider: existing.provider,
    experimental: existing.experimental,
    cost: modelCost(model, provider),
    limit,
    modalities,
  };
}

function modelCost(model: AciModel, provider: string): SyncedFullModel["cost"] {
  return {
    input: perMillion(model.pricing.prompt, provider, model.id, "prompt"),
    output: perMillion(model.pricing.completion, provider, model.id, "completion"),
    cache_read: optionalPrice(model.pricing.input_cache_read, provider, model.id, "input_cache_read"),
    cache_write: optionalNonZeroPrice(model.pricing.input_cache_write, provider, model.id, "input_cache_write"),
  };
}

function optionalNonZeroPrice(
  value: string | undefined,
  provider: string,
  modelID: string,
  field: string,
) {
  const price = optionalPrice(value, provider, modelID, field);
  return price === 0 ? undefined : price;
}

function optionalPrice(value: string | undefined, provider: string, modelID: string, field: string) {
  if (value === undefined) return undefined;
  return perMillion(value, provider, modelID, field);
}

function perMillion(value: string, provider: string, modelID: string, field: string) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${provider} ${field} price for ${modelID}: ${value}`);
  }
  return Math.round(parsed * 1_000_000 * 1_000_000_000) / 1_000_000_000;
}

function sourceLimits(model: AciModel) {
  return {
    context: model.context_length,
    output: model.catalog === "embedding" ? undefined : trustworthyOutputLimit(model),
  };
}

function trustworthyOutputLimit(model: AciModel) {
  return model.max_output_length === model.context_length ? undefined : model.max_output_length;
}

function modelModalities(model: AciModel) {
  return {
    input: normalizeModalities(model.input_modalities),
    output: normalizeModalities(model.output_modalities),
  };
}

function sourceFlag(values: Set<string>, key: string, fallback: boolean | undefined) {
  return values.size > 0 ? values.has(key) : fallback;
}

function normalizeModalities(values: string[]): Array<z.infer<typeof Modality>> {
  const normalized = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value) => Modality.safeParse(value).success)
    .map((value) => Modality.parse(value));
  return [...new Set(normalized.length > 0 ? normalized : ["text" as const])];
}

function reasoningOptions(
  existing: ExistingModel | undefined,
  reasoning: boolean | undefined,
): ExistingModel["reasoning_options"] {
  if (reasoning !== true) return undefined;
  return existing?.reasoning_options;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}
