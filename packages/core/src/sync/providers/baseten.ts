import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import type {
  ExistingModel,
  SyncProvider,
  SyncedBaseModel,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://inference.baseten.co/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const DECISION_PREFIX = "decision-models/";
const DECISION_HEADER = "# Decision model: POST /v1/systemone (https://docs.baseten.co/inference/model-apis/decision-models)\n";

const Price = z.union([z.string(), z.number()]);

export const BasetenModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_length: z.number().int().positive(),
  // Decision models generate no text, so they list no completion limit.
  max_completion_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  pricing: z.object({
    prompt: Price,
    completion: Price,
    input_cache_read: Price.optional(),
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
    if (model.id.startsWith(DECISION_PREFIX)) {
      const v2 = buildBasetenDecisionModel(model, context.v2?.(model.id));
      return v2 === undefined ? undefined : { id: model.id, v2, header: DECISION_HEADER };
    }
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    const baseModel = existing === undefined
      ? resolveBasetenBaseModel(model.id)
      : existing.base_model;
    if (existing === undefined && baseModel === undefined) return undefined;
    if (
      existing === undefined
      && (price(model.pricing.prompt) === undefined || price(model.pricing.completion) === undefined)
    ) return undefined;

    const built = buildBasetenModel(model, existing, baseModel, authored);
    return {
      id: model.id,
      model: built,
      // Model APIs cache prompt prefixes automatically and bill cached input
      // at the catalog's input_cache_read price.
      v2Set: basetenV2Set(built.cost?.cache_read, context.v2?.(model.id)),
    };
  },
} satisfies SyncProvider<BasetenModel>;

// Model APIs cache prompt prefixes automatically ("Caching is automatic and
// requires no request flags") and bill cached input at input_cache_read.
export function basetenV2Set(cacheRead: number | undefined, current: Record<string, unknown> | undefined) {
  const capabilities = current?.capabilities as Record<string, unknown> | undefined;
  if (cacheRead === undefined && capabilities?.cache === undefined) return undefined;
  return {
    "capabilities.cache": cacheRead === undefined ? undefined : { supported: true, implicit: true },
  };
}

// Decision models are served on POST /v1/systemone, not chat completions, so
// they are v2-only. The catalog's `name` is the Base Labs lab model ID.
export function buildBasetenDecisionModel(
  model: BasetenModel,
  current: Record<string, unknown> | undefined,
) {
  const base = typeof current?.base_model === "string" ? current.base_model : `baseten/${model.name}`;
  const lab = labModel(base);
  const input = price(model.pricing.prompt);
  const output = price(model.pricing.completion);
  if (lab === undefined || input === undefined || output === undefined) return undefined;

  const doc: Record<string, unknown> = { schema: 2, v2_only: true, base_model: base };
  if (current?.status !== undefined) doc.status = current.status;
  if (model.context_length !== (lab.limit as { context?: number } | undefined)?.context) {
    doc.limit = { context: model.context_length };
  }
  doc.cost = { text: { input: { price: input }, output: { price: output } } };
  return doc;
}

function labModel(modelID: string) {
  try {
    return Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

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
  authored?: ExistingModel,
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
        cache_read: price(model.pricing.input_cache_read) ?? existing?.cost?.cache_read,
        cache_write: existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  // Explicit provider limits are serving overrides and sync pins. Baseten's
  // catalog has returned a model's context window as its completion limit.
  const outputLimit = authored?.limit?.output ?? model.max_completion_tokens;
  if (outputLimit === undefined) {
    throw new Error(`Baseten model ${model.id} has incomplete token limits required for sync`);
  }
  const limit = {
    context: model.context_length,
    input: existing?.limit?.input,
    output: outputLimit,
  };
  // Model facts (family, dates, knowledge, open weights) belong to the lab file
  // that a base_model entry inherits; only standalone definitions carry them,
  // and only standalone definitions get a generated description.
  const facts = baseModel === undefined ? existing : undefined;
  const values: Partial<SyncedFullModel> = {
    name: model.name ?? existing?.name,
    description: existing?.description ?? (baseModel !== undefined ? undefined : describeModel({
      id: model.id,
      name: model.name ?? existing?.name,
      family: existing?.family,
      reasoning: features.has("reasoning") || existing?.reasoning,
      tool_call: features.has("tools") || existing?.tool_call,
      structured_output: features.has("structured_outputs") || existing?.structured_output,
      open_weights: existing?.open_weights,
      limit,
      modalities: { input, output },
    })),
    family: facts?.family,
    release_date: facts?.release_date,
    last_updated: facts?.last_updated,
    attachment: input.some((value) => value !== "text"),
    reasoning: features.has("reasoning") || existing?.reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature: samplingParameters.has("temperature"),
    tool_call: features.has("tools") || existing?.tool_call,
    structured_output: features.has("structured_outputs") || existing?.structured_output,
    // A base_model file may keep its own knowledge cutoff (e.g. an unsourced
    // host value where the lab states none); the sync never adds one.
    knowledge: baseModel === undefined ? existing?.knowledge : authored?.knowledge,
    open_weights: facts?.open_weights,
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
    const factored = factorBaseModel(
      baseModel,
      values,
      limit,
      existing?.base_model_omit,
    ) as SyncedBaseModel;
    if (authored?.limit?.output === undefined) return factored;

    return {
      ...factored,
      limit: {
        ...factored.limit,
        output: authored.limit.output,
      },
    };
  }

  const required = z.object({
    name: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    description: z.string(),
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
