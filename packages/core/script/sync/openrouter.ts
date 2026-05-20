import { z } from "zod";

import { ModelFamilyValues } from "../../src/family.js";
import type { ExistingModel, SyncProvider } from "../sync-models.js";

const API_ENDPOINT = "https://openrouter.ai/api/v1/models";

export const OpenRouterModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  hugging_face_id: z.string().nullable(),
  knowledge_cutoff: z.string().nullable(),
  context_length: z.number(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }),
  supported_parameters: z.array(z.string()),
});

export const OpenRouterResponse = z.object({
  data: z.array(OpenRouterModel),
}).passthrough();

export type OpenRouterModel = z.infer<typeof OpenRouterModel>;

export const openrouter = {
  id: "openrouter",
  name: "OpenRouter",
  modelsDir: "providers/openrouter/models",
  async fetchModels() {
    const headers = process.env.OPENROUTER_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OpenRouterResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildOpenRouterModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<OpenRouterModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
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

function inferFamily(model: OpenRouterModel, name: string) {
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

export function buildOpenRouterModel(model: OpenRouterModel, existing: ExistingModel | undefined) {
  const params = new Set(model.supported_parameters);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const context = model.top_provider.context_length ?? model.context_length;
  const family = inferFamily(model, name);

  return {
    name,
    family: existing?.family === "o" && family !== "o"
      ? family
      : (existing?.family ?? family),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    temperature: params.has("temperature"),
    tool_call: params.has("tools") || params.has("tool_choice"),
    structured_output: params.has("structured_outputs"),
    knowledge: model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge,
    open_weights: Boolean(model.hugging_face_id),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost: prompt !== undefined && completion !== undefined
      ? {
          input: prompt,
          output: completion,
          reasoning: reasoning ? price(model.pricing.internal_reasoning) : undefined,
          cache_read: price(model.pricing.input_cache_read),
          cache_write: price(model.pricing.input_cache_write),
          tiers: existing?.cost?.tiers,
        }
      : existing?.cost,
    limit: {
      context,
      input: existing?.limit?.input,
      output: model.top_provider.max_completion_tokens ?? existing?.limit?.output ?? context,
    },
    modalities: { input, output },
  };
}
