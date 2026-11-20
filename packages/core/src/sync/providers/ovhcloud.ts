import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { exactModalities, inheritedOutput, type CortecsModel } from "./cortecs.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

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
    const id = model.id.toLowerCase();
    const existing = context.existing(id);
    if (existing !== undefined) {
      return { id, model: buildOvhcloudModel(model, existing, context.authored(id)) };
    }
    // A model with no published price isn't on sale yet, and its catalog
    // `created` is a placeholder, so it isn't written until the catalog is real.
    if (!hasPrice(model)) return undefined;
    const canonical = resolveOvhcloudBaseModel(model);
    // The catalog lists no reasoning controls, so a new reasoning model needs
    // them researched before it's created.
    const labReasons = canonical !== undefined && modelMetadata(canonical).reasoning === true;
    if (model.supported_features?.includes("reasoning") || labReasons) {
      throw new MissingReasoningOptionsError(model.id, "OVHcloud lists no reasoning controls; author them before creating this model");
    }
    return {
      id,
      model: buildOvhcloudModel(model, canonical === undefined ? undefined : { base_model: canonical }, undefined),
      v2Set: canonical === undefined ? undefined : exactModalities(asCortecs(model, id)),
    };
  },
} satisfies SyncProvider<OvhcloudModel>;

function hasPrice(model: OvhcloudModel) {
  return price(model.pricing?.prompt) !== undefined && price(model.pricing?.completion) !== undefined;
}

function resolveOvhcloudBaseModel(model: OvhcloudModel) {
  const byID = resolveModelMetadataBaseModel(model.id.toLowerCase());
  if (byID !== undefined) return byID;
  const repo = model.hugging_face_id?.split("/").at(-1);
  return repo === undefined ? undefined : resolveModelMetadataBaseModel(repo.toLowerCase());
}

// exactModalities only reads the id and the modality kinds.
function asCortecs(model: OvhcloudModel, id: string) {
  return {
    id,
    input_modalities: modalities(model.input_modalities ?? ["text"], ["text"]),
    output_modalities: modalities(model.output_modalities ?? ["text"], ["text"]),
  } as unknown as CortecsModel;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
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
  authored?: ExistingModel,
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
  // A catalog row without prices keeps the authored ones instead of writing 0.
  const cost = inputCost === undefined && outputCost === undefined ? existing?.cost : {
    input: inputCost ?? existing?.cost?.input,
    output: outputCost ?? existing?.cost?.output,
    cache_read: cacheRead !== undefined && cacheRead > 0 ? cacheRead : undefined,
    cache_write: cacheWrite !== undefined && cacheWrite > 0 ? cacheWrite : undefined,
  };

  const limit = {
    context: model.context_length,
    input: existing?.limit?.input,
    output: existing?.base_model !== undefined
      ? model.max_output_length !== undefined && model.max_output_length < model.context_length
        ? model.max_output_length
        : authored?.limit?.output ?? inheritedOutput(existing.base_model, model.context_length)
      : model.max_output_length ?? existing?.limit?.output ?? model.context_length,
  };
  const modalitiesValue = { input, output };

  if (existing?.base_model !== undefined) {
    // Model facts belong to the lab file; a base_model file only carries host fields.
    return factorBaseModel(
      existing.base_model,
      {
        name: model.name,
        description: existing.description,
        attachment,
        reasoning,
        reasoning_options: reasoning ? existing.reasoning_options : undefined,
        temperature: temperature || undefined,
        tool_call: toolCall,
        structured_output: structuredOutput || undefined,
        status: existing.status,
        interleaved: existing.interleaved,
        cost,
        limit,
        modalities: modalitiesValue,
      },
      limit,
      existing.base_model_omit,
    );
  }

  return {
    name: model.name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name: model.name,
      family: existing?.family,
      reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput || undefined,
      open_weights: openWeights,
      limit: {
        context: model.context_length,
        input: existing?.limit?.input,
        output: model.max_output_length ?? existing?.limit?.output ?? model.context_length,
      },
      modalities: { input, output },
    }),
    family: existing?.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoning ? existing?.reasoning_options : undefined,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output: structuredOutput || undefined,
    knowledge: existing?.knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: modalitiesValue,
  } satisfies SyncedModel;
}
