import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type {
  ExistingModel,
  SyncProvider,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.requesty.ai/v1/models";
const MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "models",
);
const metadataCache = new Map<string, Record<string, unknown>>();
const RESPONSES_MODELS = new Map([
  ["openai-responses/gpt-5.4-mini", "openai/gpt-5.4-mini"],
  ["openai-responses/gpt-5.4-nano", "openai/gpt-5.4-nano"],
  ["openai-responses/gpt-5.5", "openai/gpt-5.5"],
  ["openai-responses/gpt-5.6-luna", "openai/gpt-5.6-luna"],
  ["openai-responses/gpt-5.6-sol", "openai/gpt-5.6-sol"],
  ["openai-responses/gpt-5.6-terra", "openai/gpt-5.6-terra"],
]);
const SKIPPED_MODELS = new Set([
  ...RESPONSES_MODELS.values(),
  "nvidia/nemotron-3.5-content-safety",
]);

export const RequestyModel = z.object({
  id: z.string(),
  api: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  description: z.string().optional(),
  input_price: z.number().nonnegative().optional(),
  output_price: z.number().nonnegative().optional(),
  caching_price: z.number().nonnegative().optional(),
  cached_price: z.number().nonnegative().optional(),
  context_window: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  supports_caching: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_tool_calling: z.boolean().optional(),
  supports_image_generation: z.boolean().optional(),
  supports_output_json_object: z.boolean().optional(),
  supports_output_json_schema: z.boolean().optional(),
}).passthrough();

export const RequestyResponse = z.object({
  data: z.array(RequestyModel),
}).passthrough();

export type RequestyModel = z.infer<typeof RequestyModel>;

export const requesty = {
  id: "requesty",
  name: "Requesty",
  modelsDir: "providers/requesty/models",
  // Retain curated aliases and models missing from the public catalog.
  deleteMissing: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Requesty request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return RequestyResponse.parse(raw).data.filter((model) => {
      if ((model.api ?? "chat") !== "chat") return false;
      if (!model.id.includes("/") || model.id.startsWith("policy/")) return false;
      if (SKIPPED_MODELS.has(model.id)) return false;
      return requestyBaseModel(model.id) !== undefined;
    });
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    const canonical = authored?.base_model ?? requestyBaseModel(model.id);
    if (canonical === undefined) return undefined;
    return {
      id: model.id,
      model: buildRequestyModel(model, existing, authored, canonical),
    };
  },
} satisfies SyncProvider<RequestyModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function price(value: number | undefined) {
  if (value === undefined) return undefined;
  return Math.round(value * 1_000_000_000_000) / 1_000_000;
}

function metadata(modelID: string) {
  let value = metadataCache.get(modelID);
  if (value !== undefined) return value;
  value = Bun.TOML.parse(
    readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
  ) as Record<string, unknown>;
  metadataCache.set(modelID, value);
  return value;
}

function metadataBoolean(modelID: string, field: string) {
  const value = metadata(modelID)[field];
  return typeof value === "boolean" ? value : undefined;
}

function metadataLimit(modelID: string) {
  const value = metadata(modelID).limit;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as { context?: number; input?: number; output?: number }
    : undefined;
}

function metadataModalities(modelID: string) {
  const value = metadata(modelID).modalities;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const modalities = value as { input?: Modality[]; output?: Modality[] };
  return modalities.input !== undefined && modalities.output !== undefined
    ? { input: modalities.input, output: modalities.output }
    : undefined;
}

function append(values: Modality[], value: Modality, enabled: boolean | undefined) {
  return enabled === true && !values.includes(value) ? [...values, value] : values;
}

function requestyBaseModel(modelID: string) {
  return RESPONSES_MODELS.get(modelID) ?? resolveCanonicalBaseModel(modelID);
}

function reasoningOptions(
  model: RequestyModel,
  reasoning: boolean,
  existing: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  if (!reasoning) return undefined;
  const provider = requestyBaseModel(model.id)?.split("/")[0];
  if (provider === "openai" || provider === "anthropic" || provider === "google") {
    return [
      { type: "effort", values: ["none", "low", "medium", "high", "max"] },
      { type: "budget_tokens" },
    ];
  }
  return existing?.reasoning_options ?? [];
}

export function buildRequestyModel(
  model: RequestyModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
  canonical = requestyBaseModel(model.id),
): SyncedModel {
  if (canonical === undefined) {
    throw new Error(`Requesty model ${model.id} does not resolve to shared metadata`);
  }

  const baseLimit = metadataLimit(canonical);
  const baseModalities = metadataModalities(canonical);
  const inputModalities = [...new Set<Modality>([
    ...(baseModalities?.input ?? []),
    ...(existing?.modalities?.input ?? []),
  ])];
  const outputModalities = [...new Set<Modality>([
    ...(baseModalities?.output ?? []),
    ...(existing?.modalities?.output ?? []),
  ])];
  const modalities = {
    input: append(inputModalities.length > 0 ? inputModalities : ["text"], "image", model.supports_vision),
    output: append(outputModalities.length > 0 ? outputModalities : ["text"], "image", model.supports_image_generation),
  };
  const attachment = modalities.input.some((value) => value !== "text");
  const intrinsicReasoning = existing?.reasoning === true
    || metadataBoolean(canonical, "reasoning") === true;
  const reasoning = intrinsicReasoning || model.supports_reasoning === true;
  const toolCall = model.id === "google/gemini-3.1-flash-image-preview"
    ? false
    : model.supports_tool_calling
      ?? existing?.tool_call
      ?? metadataBoolean(canonical, "tool_call");
  const reportedStructuredOutput = model.supports_output_json_schema === undefined
      && model.supports_output_json_object === undefined
    ? undefined
    : model.supports_output_json_schema === true
      || model.supports_output_json_object === true;
  const structuredOutput = reportedStructuredOutput
    ?? existing?.structured_output
    ?? metadataBoolean(canonical, "structured_output");
  const inputPrice = price(model.input_price);
  const outputPrice = price(model.output_price);
  const cost = inputPrice !== undefined && outputPrice !== undefined
    ? {
        input: inputPrice,
        output: outputPrice,
        cache_read: model.supports_caching === false
          ? undefined
          : price(model.cached_price) ?? existing?.cost?.cache_read,
        cache_write: model.supports_caching === false
          ? undefined
          : price(model.caching_price) ?? existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const context = model.context_window ?? existing?.limit?.context ?? baseLimit?.context ?? 0;
  const output = model.max_output_tokens !== undefined && model.max_output_tokens > 0
    ? model.max_output_tokens
    : existing?.limit?.output ?? baseLimit?.output ?? context;
  const limit = {
    context,
    input: existing?.limit?.input ?? baseLimit?.input,
    output,
  };
  const values: Partial<SyncedFullModel> = {
    attachment,
    reasoning,
    reasoning_options: reasoningOptions(model, reasoning, existing),
    temperature: existing?.temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    status: existing?.status,
    interleaved: existing?.interleaved,
    provider: RESPONSES_MODELS.has(model.id)
      ? { npm: "@ai-sdk/openai", shape: "responses" }
      : existing?.provider,
    cost,
    limit,
    modalities,
  };

  // Keep legacy hand-authored models inline, but update fields for which the
  // Requesty API is authoritative. New and already-factored files stay based
  // on shared model metadata.
  if (authored !== undefined && authored.base_model === undefined) {
    return { ...authored, ...values, cost, limit, modalities } as SyncedModel;
  }

  return factorBaseModel(
    canonical,
    values,
    limit,
  );
}
