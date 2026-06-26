import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// EmpirioLabs exposes a public, unauthenticated OpenAI-compatible model
// catalog, so no API key is needed or used for this sync.
const API_ENDPOINT = "https://api.empiriolabs.ai/v1/models";

const CANONICAL_BASE_MODELS: Record<string, string> = {
  "qwen3-5-9b": "alibaba/qwen3.5-9b",
  "qwen3-7-max": "alibaba/qwen3.7-max",
  "qwen3-7-plus": "alibaba/qwen3.7-plus",
};

const EmpiriolabsParameter = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();

const EmpiriolabsPricingTier = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_read: z.string().optional(),
  })
  .passthrough();

// Pricing is returned either as a single tier object or as an array of tier
// objects (tiered/context-priced models). Accept both shapes.
const EmpiriolabsPricing = z.union([
  z.array(EmpiriolabsPricingTier),
  EmpiriolabsPricingTier,
]);

const EmpiriolabsModel = z
  .object({
    id: z.string(),
    display_name: z.string().optional(),
    name: z.string().optional(),
    category: z.string().optional(),
    context_length: z.number().nullable().optional(),
    context_window: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    model_released_at: z.string().optional(),
    pricing: EmpiriolabsPricing.optional(),
    capabilities: z.record(z.unknown()).optional(),
    features: z.array(z.string()).optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    supported_parameters: z.array(EmpiriolabsParameter).optional(),
  })
  .passthrough();

const EmpiriolabsResponse = z
  .object({
    data: z.array(EmpiriolabsModel),
  })
  .passthrough();

export type EmpiriolabsModel = z.infer<typeof EmpiriolabsModel>;

export const empiriolabs = {
  id: "empiriolabs",
  name: "EmpirioLabs AI",
  modelsDir: "providers/empiriolabs/models",
  skipCreates: true,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} EmpirioLabs AI models returned by the API were not created because the API does not provide authoritative release date, open-weight, or canonical base model metadata. `
        + "Existing models are still updated from API-authoritative fields.",
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`EmpirioLabs request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Text chat models only. Skip non-text categories (image, video, audio,
    // 3D, research, tools) and regional/capability variant lanes (id has ":").
    return EmpiriolabsResponse.parse(raw).data.filter(
      (model) => (model.category ?? "").toLowerCase() === "text" && !model.id.includes(":"),
    );
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? CANONICAL_BASE_MODELS[model.id];
    const built = buildEmpiriolabsModel(model, existing, baseModel);
    // A model with no resolvable context window cannot produce a valid TOML
    // (limit.context is required), so skip it rather than fail the whole sync.
    if (built === undefined) return undefined;
    return {
      id: model.id,
      model: built,
    };
  },
} satisfies SyncProvider<EmpiriolabsModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type EffortValue =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

const EFFORT_VALUES: EffortValue[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
];

function firstPricingTier(pricing: EmpiriolabsModel["pricing"]) {
  if (pricing === undefined) return undefined;
  return Array.isArray(pricing) ? pricing[0] : pricing;
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  // Per-token string converted to a per-1M-token number.
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function modalities(values: string[] | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function reasoningOptions(model: EmpiriolabsModel) {
  const params = model.supported_parameters ?? [];
  const effort = params.find((parameter) => parameter.name === "reasoning_effort");
  if (effort?.options?.length) {
    const values = effort.options.filter((value): value is EffortValue =>
      (EFFORT_VALUES as string[]).includes(value),
    );
    if (values.length > 0) return [{ type: "effort" as const, values }];
  }
  if (params.some((parameter) => parameter.name === "enable_thinking")) {
    return [{ type: "toggle" as const }];
  }
  // Reasoning model that exposes no effort or toggle control.
  return [];
}

export function buildEmpiriolabsModel(
  model: EmpiriolabsModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? CANONICAL_BASE_MODELS[model.id],
): SyncedModel | undefined {
  const features = new Set(model.features ?? []);
  const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
  const input = modalities(model.input_modalities, ["text"]);
  const output = modalities(model.output_modalities, ["text"]);
  const attachment = input.some((value) => value !== "text");
  const reasoning =
    capabilities.reasoning === true || features.has("reasoning") || existing?.reasoning === true;
  const toolCall =
    features.has("function_calling") || features.has("tools") || existing?.tool_call === true;
  const structuredOutput = features.has("structured_output") || existing?.structured_output === true;
  const temperature =
    (model.supported_parameters ?? []).some((parameter) => parameter.name === "temperature")
    || existing?.temperature === true;

  const tier = firstPricingTier(model.pricing);
  const inputCost = price(tier?.prompt) ?? existing?.cost?.input;
  const outputCost = price(tier?.completion) ?? existing?.cost?.output;
  const cacheRead = price(tier?.input_cache_read) ?? existing?.cost?.cache_read;
  const cost = inputCost !== undefined && outputCost !== undefined
    ? {
        input: inputCost,
        output: outputCost,
        reasoning: existing?.cost?.reasoning,
        cache_read: cacheRead !== undefined && cacheRead > 0 ? cacheRead : undefined,
        cache_write: existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  const context =
    model.context_length ?? model.context_window ?? existing?.limit?.context;
  // No usable context window: cannot build a valid model TOML, so skip.
  if (context === undefined || context === null) return undefined;

  const releaseDate = baseModel === undefined
    ? model.model_released_at ?? existing?.release_date
    : existing?.release_date;
  const lastUpdated = baseModel === undefined
    ? model.model_released_at ?? existing?.last_updated ?? releaseDate
    : existing?.last_updated ?? releaseDate;
  const output_tokens = model.max_output_tokens ?? existing?.limit?.output ?? context;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: output_tokens,
  };
  const values: Partial<SyncedFullModel> = {
    name: model.display_name ?? model.name ?? model.id,
    family: existing?.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoning ? reasoningOptions(model) : undefined,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output: structuredOutput || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  if (existing === undefined) return undefined;
  const required = z.object({
    name: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`EmpirioLabs model ${model.id} has incomplete local metadata required for sync`);
  }

  return values as SyncedFullModel;
}
