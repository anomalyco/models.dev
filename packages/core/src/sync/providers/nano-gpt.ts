import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://nano-gpt.com/api/v1/models?detailed=true";

const ReasoningEffort = z.union([
  z.null(),
  z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]),
]);

const Pricing = z.object({
  prompt: z.number().nullish(),
  completion: z.number().nullish(),
  input: z.number().nullish(),
  output: z.number().nullish(),
  cacheReadInputPer1kTokens: z.number().nullish(),
  cacheWriteInputPer1kTokens: z.number().nullish(),
  note: z.string().optional(),
}).passthrough();

const Architecture = z.object({
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
}).passthrough();

const Capabilities = z.object({
  vision: z.boolean().optional(),
  video_input: z.boolean().optional(),
  audio_input: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_calling: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  pdf_upload: z.boolean().optional(),
}).passthrough();

export const NanoGptModel = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  owned_by: z.string().nullish(),
  context_length: z.number().int().nonnegative().nullish(),
  max_output_tokens: z.number().int().nonnegative().nullish(),
  architecture: Architecture.optional(),
  capabilities: Capabilities.optional(),
  reasoning_efforts: z.array(ReasoningEffort).nullish(),
  open_weights: z.boolean().nullish(),
  pricing: Pricing.optional(),
}).passthrough();

export const NanoGptResponse = z.object({
  data: z.array(NanoGptModel),
}).passthrough();

export type NanoGptModel = z.infer<typeof NanoGptModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const nanoGpt = {
  id: "nano-gpt",
  name: "NanoGPT",
  modelsDir: "providers/nano-gpt/models",
  async fetchModels() {
    const response = await fetch(process.env.NANO_GPT_MODELS_URL ?? API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`NanoGPT models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return NanoGptResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const id = normalizeModelID(model.id);
    return {
      id,
      model: buildNanoGptModel(model, context.existing(id)),
    };
  },
} satisfies SyncProvider<NanoGptModel>;

const ORG_ID_NORMALIZATION: Record<string, string | undefined> = {
  nousresearch: "NousResearch",
  qwen: "qwen",
  thedrummer: "TheDrummer",
};

const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "cohere/north-mini-code": "cohere/north-mini-code-1-0",
  "sakana/fugu-ultra": "sakana/fugu-ultra",
  "xiaomi/mimo-v2.5-pro-ultraspeed": "xiaomi/mimo-v2.5-pro",
};

const KNOWN_OPEN_WEIGHT_IDS = new Set([
  "cohere/north-mini-code",
  "nex-agi/nex-n2-pro",
]);

export function buildNanoGptModel(
  model: NanoGptModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveNanoGptBaseModel(model.id),
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const capabilities = model.capabilities ?? {};
  const input = normalizeModalities([
    ...model.architecture?.input_modalities ?? ["text"],
    ...(capabilities.vision ? ["image"] : []),
    ...(capabilities.audio_input ? ["audio"] : []),
    ...(capabilities.video_input ? ["video"] : []),
    ...(capabilities.pdf_upload ? ["pdf"] : []),
  ]);
  const output = normalizeModalities(model.architecture?.output_modalities ?? ["text"]);
  const context = positive(model.context_length) ?? existing?.limit?.context ?? 0;
  const outputLimit = positive(model.max_output_tokens) ?? existing?.limit?.output ?? 0;
  const releaseDate = dateFromTimestamp(model.created) ?? existing?.release_date ?? today;
  const reasoning = capabilities.reasoning ?? existing?.reasoning ?? false;
  const cost = buildCost(model.pricing, existing);
  const limit = {
    context,
    input: context,
    output: outputLimit,
  };
  const values = {
    name: existing?.name ?? model.name ?? humanizeModelName(model.id),
    description: existing?.description ?? model.description ?? `${model.name ?? humanizeModelName(model.id)} on NanoGPT.`,
    family: existing?.family ?? inferFamily(model.id, model.name ?? ""),
    release_date: existing?.release_date ?? releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions(model, reasoning),
    temperature: existing?.temperature,
    tool_call: capabilities.tool_calling ?? existing?.tool_call ?? false,
    structured_output: capabilities.structured_output ?? existing?.structured_output,
    knowledge: existing?.knowledge,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        ...values,
        open_weights: model.open_weights ?? undefined,
      },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  return {
    ...values,
    open_weights: model.open_weights
      ?? (KNOWN_OPEN_WEIGHT_IDS.has(model.id.toLowerCase()) ? true : existing?.open_weights)
      ?? false,
  } satisfies SyncedFullModel;
}

function buildCost(
  pricing: NanoGptModel["pricing"],
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] {
  if (pricing === undefined) return existing?.cost;
  if (pricing.note === "varies_by_modality") return undefined;

  const input = pricing.input ?? pricing.prompt;
  const output = pricing.output ?? pricing.completion;
  if (input == null || output == null) return existing?.cost;

  return {
    input: price(input),
    output: price(output),
    reasoning: existing?.cost?.reasoning,
    cache_read: pricing.cacheReadInputPer1kTokens == null
      ? existing?.cost?.cache_read
      : price(pricing.cacheReadInputPer1kTokens * 1_000),
    cache_write: pricing.cacheWriteInputPer1kTokens == null
      ? existing?.cost?.cache_write
      : price(pricing.cacheWriteInputPer1kTokens * 1_000),
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: existing?.cost?.tiers,
  };
}

function reasoningOptions(
  model: NanoGptModel,
  reasoning: boolean,
): SyncedFullModel["reasoning_options"] {
  if (!reasoning) return undefined;
  if (model.reasoning_efforts == null || model.reasoning_efforts.length === 0) return [];
  return [{ type: "effort", values: [...model.reasoning_efforts] }];
}

export function resolveNanoGptBaseModel(modelID: string) {
  const normalized = normalizeModelID(modelID).replace(/:thinking$/, "");
  const alias = BASE_MODEL_ALIASES[normalized.toLowerCase()];
  if (alias !== undefined) return alias;

  if (normalized.toLowerCase().startsWith("zai-org/")) {
    return resolveCanonicalBaseModel(`z-ai/${normalized.slice("zai-org/".length)}`);
  }

  if (normalized.startsWith("TEE/")) {
    const model = normalized.slice("TEE/".length);
    const lower = model.toLowerCase();
    if (lower.startsWith("deepseek")) return resolveCanonicalBaseModel(`deepseek/${model}`);
    if (lower.startsWith("qwen")) return resolveCanonicalBaseModel(`qwen/${model}`);
    if (lower.startsWith("glm")) return resolveCanonicalBaseModel(`z-ai/${model}`);
  }

  return resolveCanonicalBaseModel(normalized);
}

function normalizeModalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => normalizeModality(value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : ["text"] as Modality[])];
}

function normalizeModality(value: string) {
  const lower = value.toLowerCase();
  if (lower === "images") return "image";
  if (lower === "videos") return "video";
  if (lower === "audios") return "audio";
  if (lower === "documents") return "pdf";
  return lower;
}

function normalizeModelID(modelId: string) {
  const [org, ...parts] = modelId.split("/");
  if (org === undefined || parts.length === 0) return modelId;
  const normalizedOrg = ORG_ID_NORMALIZATION[org.toLowerCase()];
  return normalizedOrg === undefined ? modelId : `${normalizedOrg}/${parts.join("/")}`;
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function humanizeModelName(modelId: string) {
  const modelPart = modelId.split("/").at(-1) ?? modelId;
  return modelPart
    .replace(/[:/_-]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function dateFromTimestamp(timestamp: number | null | undefined) {
  if (timestamp == null || timestamp <= 0) return undefined;
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function positive(value: number | null | undefined) {
  return value == null || value <= 0 ? undefined : value;
}

function price(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
