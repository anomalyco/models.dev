import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://nano-gpt.com/api/v1/models?detailed=true";

// NanoGPT accepts these exact request values, including `max`:
// https://github.com/Nano-GPT-com/nanogpt/blob/073b25b07e9af619333c679e694de664bf1ceb30/lib/utils/reasoningInput.ts#L12-L28
const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
  preserveDescriptions: false,
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
    const existing = context.existing(id);
    const baseModel = existing?.base_model ?? resolveNanoGptBaseModel(model.id);
    const translated = buildNanoGptModel(model, existing, baseModel);
    if (translated === undefined) return undefined;
    return {
      id,
      model: translated,
    };
  },
} satisfies SyncProvider<NanoGptModel>;

const ORG_ID_NORMALIZATION: Record<string, string | undefined> = {
  nousresearch: "NousResearch",
  qwen: "qwen",
  thedrummer: "TheDrummer",
};

const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "claude-opus-4": "anthropic/claude-opus-4-0",
  "claude-sonnet-4": "anthropic/claude-sonnet-4-0",
  "cohere/north-mini-code": "cohere/north-mini-code-1-0",
};

const NANO_GPT_VARIANT_SUFFIX = /(?::(?:thinking|none|minimal|low|medium|high|xhigh|max|\d+)|-thinking)$/i;

const KNOWN_OPEN_WEIGHT_IDS = new Set([
  "nex-agi/nex-n2-pro",
]);

export function buildNanoGptModel(
  model: NanoGptModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveNanoGptBaseModel(model.id),
): SyncedModel | undefined {
  const capabilities = model.capabilities ?? {};
  const explicitInputModalities = model.architecture?.input_modalities;
  const hasInputCapabilityMetadata = capabilities.vision !== undefined
    || capabilities.audio_input !== undefined
    || capabilities.video_input !== undefined
    || capabilities.pdf_upload !== undefined;
  const addedInputModalities = [
    ...(capabilities.vision ? ["image"] : []),
    ...(capabilities.audio_input ? ["audio"] : []),
    ...(capabilities.video_input ? ["video"] : []),
    ...(capabilities.pdf_upload ? ["pdf"] : []),
  ];
  const hasInputMetadata = explicitInputModalities !== undefined || hasInputCapabilityMetadata;
  const hasOutputMetadata = model.architecture?.output_modalities !== undefined;
  const input = normalizeModalities([
    ...explicitInputModalities
      ?? (hasInputCapabilityMetadata ? ["text"] : existing?.modalities?.input)
      ?? ["text"],
    ...addedInputModalities,
  ]);
  const output = normalizeModalities(
    model.architecture?.output_modalities ?? existing?.modalities?.output ?? ["text"],
  );
  const sourceContext = positive(model.context_length);
  const sourceOutputLimit = positive(model.max_output_tokens);
  const context = sourceContext ?? existing?.limit?.context;
  const inputLimit = sourceContext ?? existing?.limit?.input;
  const outputLimit = sourceOutputLimit ?? existing?.limit?.output;
  const releaseDate = dateFromTimestamp(model.created) ?? existing?.release_date;
  const inferredSourceReasoning = capabilities.reasoning
    ?? (model.reasoning_efforts != null ? true : undefined);
  const reasoning = inferredSourceReasoning ?? existing?.reasoning ?? false;
  const cost = buildCost(model.pricing, existing);
  if (baseModel !== undefined) {
    const existingAlreadyFactored = existing?.base_model === baseModel;
    const factoredModalities = {
      input: hasInputMetadata || existing !== undefined ? input : undefined,
      output: hasOutputMetadata || existing !== undefined ? output : undefined,
    };
    const factoredLimit = {
      context: sourceContext ?? existing?.limit?.context,
      input: sourceContext ?? existing?.limit?.input,
      output: sourceOutputLimit ?? existing?.limit?.output,
    };
    const sourceReasoning = inferredSourceReasoning;
    const sourceReasoningOptions = reasoningOptions(model, sourceReasoning, existing?.reasoning_options);

    return factorBaseModel(
      baseModel,
      {
        name: existing?.name ?? model.name ?? undefined,
        description: existingAlreadyFactored ? existing?.description : undefined,
        family: existingAlreadyFactored ? existing?.family : undefined,
        release_date: existingAlreadyFactored ? existing?.release_date : undefined,
        last_updated: existingAlreadyFactored ? existing?.last_updated : undefined,
        attachment: hasInputMetadata
          ? input.some((value) => value !== "text")
          : existing?.attachment,
        reasoning: sourceReasoning ?? existing?.reasoning,
        reasoning_options: sourceReasoningOptions,
        temperature: existing?.temperature,
        tool_call: capabilities.tool_calling ?? existing?.tool_call,
        structured_output: capabilities.structured_output ?? existing?.structured_output,
        knowledge: existing?.knowledge,
        status: existing?.status,
        interleaved: existing?.interleaved,
        provider: existing?.provider,
        experimental: existing?.experimental,
        cost,
        limit: factoredLimit,
        modalities: factoredModalities,
      },
      factoredLimit,
      existingAlreadyFactored ? existing?.base_model_omit : undefined,
    );
  }

  if (context === undefined || outputLimit === undefined || releaseDate === undefined) {
    return undefined;
  }

  const values = {
    name: existing?.name ?? model.name ?? humanizeModelName(model.id),
    description: existing?.description ?? model.description ?? `${model.name ?? humanizeModelName(model.id)} on NanoGPT.`,
    family: existing?.family ?? inferFamily(model.id, model.name ?? ""),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions(model, reasoning, existing?.reasoning_options),
    temperature: existing?.temperature,
    tool_call: capabilities.tool_calling ?? existing?.tool_call ?? false,
    structured_output: capabilities.structured_output ?? existing?.structured_output,
    knowledge: existing?.knowledge,
    status: existing?.status,
    interleaved: existing?.interleaved,
    provider: existing?.provider,
    experimental: existing?.experimental,
    cost,
    limit: { context, input: inputLimit ?? context, output: outputLimit },
    modalities: { input, output },
  };

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
  if (pricing.note === "varies_by_modality") return existing?.cost;

  const input = pricing.input ?? pricing.prompt;
  const output = pricing.output ?? pricing.completion;
  if (!validPrice(input) || !validPrice(output)) return existing?.cost;

  return {
    input: price(input),
    output: price(output),
    reasoning: existing?.cost?.reasoning,
    cache_read: !validPrice(pricing.cacheReadInputPer1kTokens)
      ? existing?.cost?.cache_read
      : price(pricing.cacheReadInputPer1kTokens * 1_000),
    cache_write: !validPrice(pricing.cacheWriteInputPer1kTokens)
      ? existing?.cost?.cache_write
      : price(pricing.cacheWriteInputPer1kTokens * 1_000),
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: existing?.cost?.tiers,
  };
}

function reasoningOptions(
  model: NanoGptModel,
  reasoning: boolean | undefined,
  existing: SyncedFullModel["reasoning_options"],
): SyncedFullModel["reasoning_options"] {
  if (reasoning === false) return undefined;
  if (reasoning === undefined) return existing;
  if (model.reasoning_efforts == null) return existing ?? [];
  if (model.reasoning_efforts.length === 0) return [];
  return [{ type: "effort", values: [...model.reasoning_efforts] }];
}

export function resolveNanoGptBaseModel(modelID: string) {
  let normalized = normalizeModelID(modelID);
  if (normalized.toLowerCase().startsWith("tee/")) {
    normalized = normalizeModelID(normalized.slice("TEE/".length));
  }

  const exact = resolveNanoGptCanonicalCandidate(normalized);
  if (exact !== undefined) return exact;

  const stripped = stripNanoGptVariantSuffixes(normalized);
  return stripped === normalized ? undefined : resolveNanoGptCanonicalCandidate(stripped);
}

function resolveNanoGptCanonicalCandidate(modelID: string) {
  return BASE_MODEL_ALIASES[modelID.toLowerCase()] ?? resolveModelMetadataBaseModel(modelID);
}

function stripNanoGptVariantSuffixes(modelID: string) {
  let normalized = modelID;
  while (true) {
    const stripped = normalized.replace(NANO_GPT_VARIANT_SUFFIX, "");
    if (stripped === normalized) return normalized;
    normalized = stripped;
  }
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
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d)`).test(target);
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

function validPrice(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value >= 0;
}
