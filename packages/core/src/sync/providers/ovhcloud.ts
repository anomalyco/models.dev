import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncProvider, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter";

export const OvhcloudModel = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number(),
    hugging_face_id: z.string().nullable().optional(),
    context_length: z.number(),
    max_output_length: z.number().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
        input_cache_reads: z.string().optional(),
        input_cache_writes: z.string().optional(),
      })
      .passthrough()
      .optional(),
    supported_features: z.array(z.string()).optional(),
    supported_sampling_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

export const OvhcloudResponse = z
  .object({
    data: z.array(OvhcloudModel),
  })
  .passthrough();

export type OvhcloudModel = z.infer<typeof OvhcloudModel>;

export const ovhcloud = {
  id: "ovhcloud",
  name: "OVHcloud AI Endpoints",
  modelsDir: "providers/ovhcloud/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`OVHcloud request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return OvhcloudResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id.toLowerCase(),
      model: buildOvhcloudModel(model, context.existing(model.id.toLowerCase())),
    };
  },
} satisfies SyncProvider<OvhcloudModel>;

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
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

export function buildOvhcloudModel(
  model: OvhcloudModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const features = new Set(model.supported_features ?? []);
  const samplingParameters = new Set(model.supported_sampling_parameters ?? []);
  const input = modalities(model.input_modalities ?? ["text"], ["text"]);
  const output = modalities(model.output_modalities ?? ["text"], ["text"]);
  const attachment = input.some((value) => value !== "text");
  const reasoning = features.has("reasoning");
  const toolCall = features.has("tools");
  const structuredOutput = features.has("structured_outputs");
  const temperature = samplingParameters.has("temperature");
  const openWeights = Boolean(model.hugging_face_id);
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const lastUpdated = existing?.last_updated ?? releaseDate;

  const inputCost = price(model.pricing?.prompt);
  const outputCost = price(model.pricing?.completion);
  const cacheRead = price(model.pricing?.input_cache_reads);
  const cacheWrite = price(model.pricing?.input_cache_writes);
  const cost =
    (inputCost ?? 0) > 0 || (outputCost ?? 0) > 0
      ? {
          input: inputCost ?? 0,
          output: outputCost ?? 0,
          cache_read: cacheRead !== undefined && cacheRead > 0 ? cacheRead : undefined,
          cache_write: cacheWrite !== undefined && cacheWrite > 0 ? cacheWrite : undefined,
        }
      : undefined;

  return {
    name: model.name,
    family: existing?.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output: structuredOutput || undefined,
    knowledge: existing?.knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit: {
      context: model.context_length,
      input: existing?.limit?.input,
      output: model.max_output_length ?? existing?.limit?.output ?? model.context_length,
    },
    modalities: { input, output },
  } satisfies SyncedFullModel;
}
