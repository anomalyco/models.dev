import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel } from "../index.js";

const API_ENDPOINT = "https://nano-gpt.com/api/v1/models?detailed=true";

const Pricing = z.object({
  prompt: z.number().nullish(),
  completion: z.number().nullish(),
  input: z.number().nullish(),
  output: z.number().nullish(),
  cacheReadInputPer1kTokens: z.number().nullish(),
  cacheWriteInputPer1kTokens: z.number().nullish(),
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
  created: z.number().nullish(),
  owned_by: z.string().nullish(),
  context_length: z.number().int().nonnegative().nullish(),
  max_output_tokens: z.number().int().nonnegative().nullish(),
  architecture: Architecture.optional(),
  capabilities: Capabilities.optional(),
  pricing: Pricing.optional(),
}).passthrough();

export const NanoGptResponse = z.object({
  data: z.array(NanoGptModel),
}).passthrough();

export type NanoGptModel = z.infer<typeof NanoGptModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null;

const GLM52_REASONING_EFFORTS: ReasoningEffort[] = ["high", "xhigh"];

export const nanoGpt = {
  id: "nano-gpt",
  name: "NanoGPT",
  modelsDir: "providers/nano-gpt/models",
  deleteMissing: false,
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
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `Retained ${paths.length} local NanoGPT model TOMLs that are missing from the live catalog; review manually before deleting.`,
    ];
  },
} satisfies SyncProvider<NanoGptModel>;

const ORG_ID_NORMALIZATION: Record<string, string | undefined> = {
  nousresearch: "NousResearch",
  qwen: "qwen",
  thedrummer: "TheDrummer",
};

export function buildNanoGptModel(
  model: NanoGptModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedFullModel {
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
  const pricing = model.pricing;
  const cost = pricing === undefined
    ? existing?.cost
    : {
        input: price(pricing.input ?? pricing.prompt ?? existing?.cost?.input ?? 0),
        output: price(pricing.output ?? pricing.completion ?? existing?.cost?.output ?? 0),
        reasoning: existing?.cost?.reasoning,
        cache_read: pricing.cacheReadInputPer1kTokens === undefined
          ? existing?.cost?.cache_read
          : price(pricing.cacheReadInputPer1kTokens * 1_000),
        cache_write: pricing.cacheWriteInputPer1kTokens === undefined
          ? existing?.cost?.cache_write
          : price(pricing.cacheWriteInputPer1kTokens * 1_000),
        input_audio: existing?.cost?.input_audio,
        output_audio: existing?.cost?.output_audio,
        tiers: existing?.cost?.tiers,
      };

  return {
    name: existing?.name ?? model.name ?? humanizeModelName(model.id),
    family: existing?.family ?? inferFamily(model.id, model.name ?? ""),
    release_date: existing?.release_date ?? releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: inferReasoningOptions(model, existing, reasoning),
    temperature: existing?.temperature,
    tool_call: capabilities.tool_calling ?? existing?.tool_call ?? false,
    structured_output: capabilities.structured_output ?? existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? inferOpenWeights(model),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit: {
      context,
      input: existing?.limit?.input ?? context,
      output: outputLimit,
    },
    modalities: { input, output },
  };
}

function normalizeModalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => normalizeModality(value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  if (result.length === 0) return ["text"];
  return [...new Set(result)];
}

function normalizeModality(value: string) {
  const lower = value.toLowerCase();
  if (lower === "images") return "image";
  if (lower === "videos") return "video";
  if (lower === "audios") return "audio";
  if (lower === "documents") return "pdf";
  return lower;
}

function inferReasoningOptions(
  model: NanoGptModel,
  existing: ExistingModel | undefined,
  reasoning: boolean,
): ExistingModel["reasoning_options"] {
  if (!reasoning) return undefined;
  if (existing?.reasoning_options !== undefined) return existing.reasoning_options;
  const normalized = model.id.toLowerCase();
  if (normalized.includes("glm-5.2")) {
    return [{ type: "effort", values: GLM52_REASONING_EFFORTS }];
  }
  if (normalized.endsWith(":thinking") || normalized.includes("-thinking") || normalized.includes("reasoner")) {
    return [];
  }
  return [{ type: "toggle" }];
}

function inferOpenWeights(model: NanoGptModel) {
  const id = model.id.toLowerCase();
  const owner = model.owned_by?.toLowerCase();
  if (id.startsWith("tee/")) return false;
  return owner === "zhipu" || owner === "zhipuai" || id.includes("glm-5") || id.includes("zai-org/");
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
