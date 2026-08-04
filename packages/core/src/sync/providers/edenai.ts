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

// Bedrock/gateway names bury the underlying model under provider prefixes and
// version suffixes: `anthropic.claude-opus-4-6-v1`, `meta.llama3-70b-instruct-v1:0`.
// Emit progressively-stripped candidates so resolveModelMetadataBaseModel can
// match the canonical `<lab>/<model>` id.
function normalizeGatewayName(name: string): string[] {
  const out = new Set<string>([name]);
  let s = name.replace(/:\d+$/, "");
  s = s.replace(/-v\d+$/, "");
  if (s !== name) out.add(s);

  for (const current of [...out]) {
    const dotted = current.match(/^([a-z][a-z0-9-]*)\.(.+)$/);
    if (dotted) {
      out.add(`${dotted[1]}/${dotted[2]}`);
      out.add(dotted[2]!);
    }
  }
  return [...out];
}

function candidateBaseModels(model: EdenAIModel): string[] {
  const cleanModelName = stripRegion(model.model_name);
  const cleanID = stripRegion(model.id);
  const suffix = cleanID.startsWith(`${model.owned_by}/`)
    ? cleanID.slice(model.owned_by.length + 1)
    : cleanID;

  const candidates = new Set<string>();
  const directMeta = DIRECT_METADATA_PROVIDER[model.owned_by];
  if (directMeta !== undefined) {
    candidates.add(`${directMeta}/${cleanModelName}`);
    candidates.add(`${directMeta}/${suffix}`);
  }
  candidates.add(cleanModelName);
  candidates.add(suffix);

  for (const base of [cleanModelName, suffix]) {
    for (const normalized of normalizeGatewayName(base)) {
      candidates.add(normalized);
      if (directMeta !== undefined) {
        candidates.add(`${directMeta}/${normalized}`);
      }
    }
  }
  return [...candidates];
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
  const reasoningReported = typeof caps.supports_reasoning === "boolean";
  const reasoning = caps.supports_reasoning === true;
  const toolCallReported =
    typeof caps.supports_function_calling === "boolean" ||
    typeof caps.supports_tool_choice === "boolean";
  const toolCall =
    caps.supports_function_calling === true || caps.supports_tool_choice === true;
  const structuredOutputReported = typeof caps.supports_response_schema === "boolean";
  const structuredOutput = caps.supports_response_schema === true;
  const attachment = input.some((value) => value !== "text");
  const context = model.context_length ?? 0;
  // Eden's /v3/models does not return max output tokens. Leave output undefined
  // for factored files so base_model inheritance provides the authoritative
  // value; inline files fall back to `context` below to satisfy the schema.
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  };
  const inlineReleaseDate =
    existing?.release_date ?? dateFromTimestamp(model.created) ?? today;
  const cost = buildCost(model, reasoning, existing?.cost);

  const resolvedBase = resolveEdenBaseModel(model, existing?.base_model);
  if (resolvedBase !== undefined) {
    const factored: Partial<SyncedFullModel> = {
      release_date: existing?.release_date,
      last_updated: existing?.last_updated ?? today,
      status: existing?.status,
      interleaved: existing?.interleaved,
      cost,
      limit,
      modalities: { input, output },
      attachment,
    };
    if (reasoning || existing?.reasoning_options !== undefined) {
      factored.reasoning_options = existing?.reasoning_options ?? [];
    }
    return factorBaseModel(
      resolvedBase,
      factored,
      limit,
      existing?.base_model === resolvedBase ? existing.base_model_omit : undefined,
    );
  }

  // Inline: schema requires the capability booleans, open_weights, and
  // limit.output. Fall back to safe defaults when Eden is silent.
  const inlineReasoning = reasoningReported ? reasoning : existing?.reasoning ?? false;
  const inlineToolCall = toolCallReported ? toolCall : existing?.tool_call ?? false;
  const inlineStructuredOutput = structuredOutputReported
    ? structuredOutput
    : existing?.structured_output;
  const openWeights = existing?.open_weights ?? false;
  const name = existing?.name ?? model.model_name;
  const description =
    existing?.description ??
    (model.description?.trim() ||
      describeModel({
        id: model.id,
        name,
        family: existing?.family,
        reasoning: inlineReasoning,
        tool_call: inlineToolCall,
        structured_output: inlineStructuredOutput,
        open_weights: openWeights,
        limit,
        modalities: { input, output },
      }));

  return {
    name,
    description,
    family: existing?.family,
    attachment,
    modalities: { input, output },
    reasoning: inlineReasoning,
    reasoning_options: inlineReasoning
      ? existing?.reasoning_options ?? []
      : undefined,
    tool_call: inlineToolCall,
    structured_output: inlineStructuredOutput,
    temperature: existing?.temperature,
    knowledge: existing?.knowledge,
    open_weights: openWeights,
    release_date: inlineReleaseDate,
    last_updated: existing?.last_updated ?? today,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit: { ...limit, output: limit.output ?? context },
    provider: existing?.provider,
    experimental: existing?.experimental,
  } satisfies SyncedFullModel;
}
