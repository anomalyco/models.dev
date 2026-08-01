import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import type {
  ExistingModel,
  SyncProvider,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.edenai.run/v3/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Eden's `owned_by` is a mix of cloud gateways (which proxy someone else's model)
// and direct model creators. For direct creators we can attempt `<creator>/<model>`
// resolution; for gateways the model_name already contains the upstream prefix.
const DIRECT_METADATA_PROVIDER: Record<string, string> = {
  anthropic: "anthropic",
  bytedance: "bytedance",
  cohere: "cohere",
  deepseek: "deepseek",
  google: "google",
  microsoft: "microsoft",
  minimax: "minimax",
  mistral: "mistral",
  moonshot: "moonshotai",
  openai: "openai",
  perplexityai: "perplexity",
  qwen: "alibaba",
  xai: "xai",
};

const OPEN_WEIGHT_OWNERS = new Set([
  "bytedance",
  "deepseek",
  "minimax",
  "mistral",
  "moonshot",
  "qwen",
]);

const Pricing = z
  .object({
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    output_cost_per_reasoning_token: z.number().optional(),
    input_cost_per_audio_token: z.number().optional(),
    output_cost_per_image_token: z.number().optional(),
  })
  .passthrough();

const Capabilities = z
  .object({
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    supports_reasoning: z.boolean().optional(),
    supports_tool_choice: z.boolean().optional(),
    supports_function_calling: z.boolean().optional(),
    supports_response_schema: z.boolean().optional(),
    supports_prompt_caching: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_video_input: z.boolean().optional(),
    supports_audio_input: z.boolean().optional(),
    supports_pdf_input: z.boolean().optional(),
  })
  .passthrough();

export const EdenAIModel = z
  .object({
    id: z.string(),
    created: z.number().optional(),
    owned_by: z.string(),
    model_name: z.string(),
    context_length: z.number().nullable().optional(),
    description: z.string().nullable().optional(),
    capabilities: Capabilities,
    pricing: Pricing.nullable().optional(),
    alias_of: z.string().nullable().optional(),
  })
  .passthrough();

export const EdenAIResponse = z
  .object({
    data: z.array(EdenAIModel),
  })
  .passthrough();

export type EdenAIModel = z.infer<typeof EdenAIModel>;

export const edenai = {
  id: "edenai",
  name: "Eden AI",
  modelsDir: "providers/edenai/models",
  preserveBaseModels: false,
  async fetchModels() {
    const key = process.env.EDENAI_API_KEY;
    const response = await fetch(
      API_ENDPOINT,
      key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
    );
    if (!response.ok) {
      throw new Error(
        `Eden AI request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    // Aliases duplicate a canonical model under a second ID; skip them so the
    // catalog stays deduped. The canonical entry still syncs.
    return EdenAIResponse.parse(raw).data.filter((model) => !model.alias_of);
  },
  translateModel(model, context) {
    if (!isSyncable(model)) return undefined;
    return {
      id: model.id,
      model: buildEdenAIModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<EdenAIModel>;

function isSyncable(model: EdenAIModel): boolean {
  // Eden's /v3/models catalog is text-output today. Guard against future entries
  // (image-gen, TTS) that would need first-class categories in models.dev.
  const output = model.capabilities.output_modalities;
  if (output !== undefined && output.length > 0 && !output.includes("text")) {
    return false;
  }
  if (model.context_length == null || model.context_length <= 0) return false;
  return true;
}

function baseModelExists(modelID: string): boolean {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

function stripRegion(value: string): string {
  return value.replace(/@[a-z0-9-]+$/i, "");
}

function candidateBaseModels(model: EdenAIModel): string[] {
  const cleanModelName = stripRegion(model.model_name);
  const cleanID = stripRegion(model.id);
  const suffix = cleanID.startsWith(`${model.owned_by}/`)
    ? cleanID.slice(model.owned_by.length + 1)
    : cleanID;

  const candidates: string[] = [];
  const directMeta = DIRECT_METADATA_PROVIDER[model.owned_by];
  if (directMeta !== undefined) {
    candidates.push(`${directMeta}/${cleanModelName}`);
    candidates.push(`${directMeta}/${suffix}`);
  }
  candidates.push(cleanModelName);
  candidates.push(suffix);
  return [...new Set(candidates)];
}

function resolveEdenBaseModel(
  model: EdenAIModel,
  existingBase: string | undefined,
): string | undefined {
  if (existingBase !== undefined && baseModelExists(existingBase)) {
    return existingBase;
  }
  for (const candidate of candidateBaseModels(model)) {
    if (baseModelExists(candidate)) return candidate;
    const resolved = resolveModelMetadataBaseModel(candidate);
    if (resolved !== undefined && baseModelExists(resolved)) return resolved;
  }
  return undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function normalizeModalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const mapped = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(mapped.length > 0 ? mapped : fallback)];
}

function inputModalitiesFromCapabilities(caps: EdenAIModel["capabilities"]): Modality[] {
  if (caps.input_modalities !== undefined && caps.input_modalities.length > 0) {
    return normalizeModalities(caps.input_modalities, ["text"]);
  }
  const inferred: Modality[] = ["text"];
  if (caps.supports_vision) inferred.push("image");
  if (caps.supports_video_input) inferred.push("video");
  if (caps.supports_audio_input) inferred.push("audio");
  if (caps.supports_pdf_input) inferred.push("pdf");
  return [...new Set(inferred)];
}

function price(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000_000_000) / 1_000_000;
}

function positivePrice(value: number | undefined): number | undefined {
  const rounded = price(value);
  return rounded !== undefined && rounded > 0 ? rounded : undefined;
}

function dateFromTimestamp(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function buildCost(
  model: EdenAIModel,
  reasoning: boolean,
  existing: ExistingModel["cost"] | undefined,
): SyncedFullModel["cost"] | undefined {
  const pricing = model.pricing;
  const input = price(pricing?.input_cost_per_token);
  const output = price(pricing?.output_cost_per_token);
  if (input === undefined || output === undefined) return existing;
  return {
    input,
    output,
    cache_read: positivePrice(pricing?.cache_read_input_token_cost),
    cache_write: positivePrice(pricing?.cache_creation_input_token_cost),
    reasoning: reasoning
      ? positivePrice(pricing?.output_cost_per_reasoning_token) ?? existing?.reasoning
      : undefined,
    input_audio: positivePrice(pricing?.input_cost_per_audio_token),
  };
}

export function buildEdenAIModel(
  model: EdenAIModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const caps = model.capabilities;
  const input = inputModalitiesFromCapabilities(caps);
  const output = normalizeModalities(caps.output_modalities ?? [], ["text"]);
  const reasoning = caps.supports_reasoning === true;
  const toolCall =
    caps.supports_function_calling === true || caps.supports_tool_choice === true;
  const structuredOutput = caps.supports_response_schema === true;
  const attachment = input.some((value) => value !== "text");
  const openWeights =
    existing?.open_weights ?? OPEN_WEIGHT_OWNERS.has(model.owned_by);
  const context = model.context_length ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output ?? context,
  };
  const releaseDate =
    existing?.release_date ?? dateFromTimestamp(model.created) ?? today;
  const cost = buildCost(model, reasoning, existing?.cost);

  const values: Partial<SyncedFullModel> = {
    attachment,
    modalities: { input, output },
    reasoning,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? today,
    tool_call: toolCall,
    structured_output: structuredOutput,
    temperature: existing?.temperature,
    knowledge: existing?.knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
  };
  // Eden's API reports reasoning support but not the control surface
  // (effort levels / budget tokens). Preserve any authored options; otherwise
  // emit an empty array per AGENTS.md guidance for reasoning models with no
  // verified control.
  if (reasoning) {
    values.reasoning_options = existing?.reasoning_options ?? [];
  }

  const resolvedBase = resolveEdenBaseModel(model, existing?.base_model);
  if (resolvedBase !== undefined) {
    return factorBaseModel(
      resolvedBase,
      values,
      limit,
      existing?.base_model === resolvedBase ? existing.base_model_omit : undefined,
    );
  }

  const name = existing?.name ?? model.model_name;
  const description =
    existing?.description ??
    (model.description?.trim() ||
      describeModel({
        id: model.id,
        name,
        family: existing?.family,
        reasoning,
        tool_call: toolCall,
        structured_output: structuredOutput,
        open_weights: openWeights,
        limit,
        modalities: { input, output },
      }));

  return {
    name,
    description,
    family: existing?.family,
    ...values,
    provider: existing?.provider,
    experimental: existing?.experimental,
  } satisfies SyncedFullModel;
}
