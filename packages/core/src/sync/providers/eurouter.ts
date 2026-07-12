import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.eurouter.ai/api/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const baseModelReasoningByID = new Map<string, boolean | undefined>();

const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]);

export const EUrouterModel = z.object({
  id: z.string(),
  canonical_slug: z.string().nullable().optional(),
  name: z.string(),
  created: z.number().nullable(),
  description: z.string().optional(),
  hugging_face_id: z.string().nullable().optional(),
  knowledge_cutoff: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  context_length: z.number().nullable(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough().nullable().optional(),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }).passthrough(),
  supported_parameters: z.array(z.string()),
  reasoning: z.object({
    mandatory: z.boolean(),
    supported_efforts: z.array(ReasoningEffort),
    supports_max_tokens: z.boolean(),
  }).passthrough().optional(),
  author: z.string().optional(),
}).passthrough();

export const EUrouterResponse = z.object({
  data: z.array(EUrouterModel),
}).passthrough();

export type EUrouterModel = z.infer<typeof EUrouterModel>;

export const eurouter = {
  id: "eurouter",
  name: "EUrouter",
  modelsDir: "providers/eurouter/models",
  async fetchModels() {
    const headers = process.env.EUROUTER_API_KEY
      ? { Authorization: `Bearer ${process.env.EUROUTER_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`EUrouter request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return EUrouterResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildEUrouterModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<EUrouterModel>;

function dateFromTimestamp(timestamp: number | null) {
  return timestamp === null
    ? undefined
    : new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(model: EUrouterModel, name: string) {
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${model.id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function reasoningOptions(
  reasoning: EUrouterModel["reasoning"],
): SyncedFullModel["reasoning_options"] {
  if (reasoning === undefined) return undefined;

  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  const efforts = reasoning.mandatory
    ? reasoning.supported_efforts.filter((value) => value !== "none")
    : reasoning.supported_efforts;

  if (efforts.length > 0) options.push({ type: "effort", values: efforts });
  if (reasoning.supports_max_tokens) options.push({ type: "budget_tokens" });
  return options.length > 0 ? options : undefined;
}

function reasoningCapability(model: EUrouterModel, params: Set<string>) {
  if (model.reasoning !== undefined) {
    return model.reasoning.mandatory
      || model.reasoning.supported_efforts.length > 0
      || model.reasoning.supports_max_tokens;
  }

  const hasReasoningParameter = params.has("reasoning")
    || params.has("include_reasoning")
    || params.has("reasoning_effort");
  return hasReasoningParameter ? true : undefined;
}

export function resolveEUrouterBaseModel(canonicalSlug: string | null | undefined) {
  if (canonicalSlug === undefined || canonicalSlug === null) return undefined;

  const [author, ...modelParts] = canonicalSlug.split("/");
  if (author === undefined || modelParts.length === 0) return undefined;
  const aliases: Record<string, string> = {
    mistral: "mistralai",
    moonshot: "moonshotai",
    zhipu: "zai",
  };
  const resolved = resolveCanonicalBaseModel(`${aliases[author] ?? author}/${modelParts.join("/")}`);
  if (resolved !== undefined) return resolved;

  const metadataPath = path.join(MODELS_DIR, `${canonicalSlug}.toml`);
  try {
    return readdirSync(path.dirname(metadataPath)).includes(path.basename(metadataPath))
      ? canonicalSlug
      : undefined;
  } catch {
    return undefined;
  }
}

function baseModelReasoning(modelID: string | undefined) {
  if (modelID === undefined) return undefined;
  if (baseModelReasoningByID.has(modelID)) return baseModelReasoningByID.get(modelID);

  let reasoning: boolean | undefined;
  try {
    const metadata = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
    ) as Record<string, unknown>;
    reasoning = typeof metadata.reasoning === "boolean" ? metadata.reasoning : undefined;
  } catch {
    reasoning = undefined;
  }
  baseModelReasoningByID.set(modelID, reasoning);
  return reasoning;
}

export function buildEUrouterModel(
  model: EUrouterModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const params = new Set(model.supported_parameters);
  const name = model.name;
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing?.prompt);
  const completion = price(model.pricing?.completion);
  const advertisedReasoning = model.reasoning;
  const reasoning = reasoningCapability(model, params);
  const apiReasoningOptions = reasoningOptions(advertisedReasoning);
  const reasoning_options = existing?.reasoning_options?.length
    ? existing.reasoning_options
    : apiReasoningOptions ?? existing?.reasoning_options ?? (reasoning === true ? [] : undefined);
  const context = model.context_length ?? model.top_provider.context_length ?? existing?.limit?.context ?? 0;
  const family = inferFamily(model, name);
  const releaseDate = model.release_date ?? existing?.release_date ?? dateFromTimestamp(model.created);
  if (releaseDate === undefined) {
    throw new Error(`EUrouter model has no release date: ${model.id}`);
  }
  const lastUpdated = model.last_updated ?? existing?.last_updated ?? releaseDate;
  const familyValue = existing?.family === "o" && family !== "o"
    ? family
    : (existing?.family ?? family);
  const attachment = input.some((value) => value !== "text");
  const toolCall = params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("response_format") || params.has("structured_outputs");
  const knowledge = model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge;
  const openWeights = Boolean(model.hugging_face_id);
  const routeCanonical = model.author === undefined ? undefined : `${model.author}/${model.id}`;
  const canonical = existing?.base_model
    ?? resolveEUrouterBaseModel(model.canonical_slug)
    ?? resolveEUrouterBaseModel(routeCanonical);
  const effectiveReasoning = reasoning ?? existing?.reasoning ?? baseModelReasoning(canonical);
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: effectiveReasoning === true
          ? price(model.pricing?.internal_reasoning)
          : undefined,
        cache_read: price(model.pricing?.input_cache_read),
        cache_write: price(model.pricing?.input_cache_write),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.top_provider.max_completion_tokens ?? existing?.limit?.output ?? context,
  };
  const description = existing?.description
    ?? model.description?.replaceAll(/\s+/g, " ").trim()
    ?? describeModel({
      id: model.id,
      name,
      family: familyValue,
      reasoning: effectiveReasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: openWeights,
      limit,
      modalities: { input, output },
    });

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        description,
        attachment,
        reasoning,
        reasoning_options,
        temperature: params.has("temperature"),
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
        cost,
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  const fullReasoningOptions = reasoning_options === undefined ? {} : { reasoning_options };
  return {
    name,
    description,
    family: familyValue,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning: effectiveReasoning ?? false,
    ...fullReasoningOptions,
    temperature: params.has("temperature"),
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}
