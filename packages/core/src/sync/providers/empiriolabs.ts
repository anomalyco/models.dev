import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// EmpirioLabs exposes a public, unauthenticated OpenAI-compatible model
// catalog, so no API key is needed or used for this sync.
const API_ENDPOINT = "https://api.empiriolabs.ai/v1/models";

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

const EmpiriolabsModel = z
  .object({
    id: z.string(),
    display_name: z.string().optional(),
    name: z.string().optional(),
    category: z.string().optional(),
    context_length: z.number().optional(),
    context_window: z.number().optional(),
    max_output_tokens: z.number().optional(),
    pricing: z.array(EmpiriolabsPricingTier).optional(),
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
    return {
      id: model.id,
      model: buildEmpiriolabsModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<EmpiriolabsModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type EffortValue = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default";

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function buildEmpiriolabsModel(
  model: EmpiriolabsModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const features = new Set(model.features ?? []);
  const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
  const input = modalities(model.input_modalities, ["text"]);
  const output = modalities(model.output_modalities, ["text"]);
  const attachment = input.some((value) => value !== "text");
  const reasoning = capabilities.reasoning === true || features.has("reasoning");
  const toolCall = features.has("function_calling") || features.has("tools");
  const structuredOutput = features.has("structured_output");
  const temperature = (model.supported_parameters ?? []).some(
    (parameter) => parameter.name === "temperature",
  );

  const tier = model.pricing?.[0];
  const inputCost = price(tier?.prompt) ?? 0;
  const outputCost = price(tier?.completion) ?? 0;
  const cacheRead = price(tier?.input_cache_read);

  const context = model.context_length ?? model.context_window ?? 0;
  const releaseDate = existing?.release_date ?? existing?.last_updated ?? today();

  return {
    base_model: existing?.base_model,
    base_model_omit: existing?.base_model_omit,
    name: model.display_name ?? model.name ?? model.id,
    family: existing?.family,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment,
    reasoning,
    reasoning_options: reasoning ? reasoningOptions(model) : undefined,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output: structuredOutput || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost: {
      input: inputCost,
      output: outputCost,
      cache_read: cacheRead !== undefined && cacheRead > 0 ? cacheRead : undefined,
    },
    limit: {
      context,
      input: existing?.limit?.input,
      output: model.max_output_tokens ?? existing?.limit?.output ?? context,
    },
    modalities: { input, output },
  } satisfies SyncedModel;
}
