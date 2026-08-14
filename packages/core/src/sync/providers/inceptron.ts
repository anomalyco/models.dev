import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = process.env.INCEPTRON_MODELS_URL ?? "https://api.inceptron.io/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const ModelsDevMetadata = z
  .object({
    base_model: z.string().regex(/^[^./\\][^/\\]*\/[^./\\][^/\\]*$/),
    reasoning_options: z.array(ReasoningOption).optional(),
    interleaved: z
      .union([
        z.literal(true),
        z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
      ])
      .optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  })
  .strict();

export const InceptronModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  is_ready: z.boolean().optional(),
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive(),
  input_modalities: z.array(z.string()).min(1),
  output_modalities: z.array(z.string()).min(1),
  supported_features: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_reads: z.string().optional(),
    input_cache_writes: z.string().optional(),
  }),
  models_dev: ModelsDevMetadata.optional(),
});

export const InceptronResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(InceptronModel),
  })
  .strict();

export type InceptronModel = z.infer<typeof InceptronModel>;
export type ReadyInceptronModel = InceptronModel & {
  models_dev: z.infer<typeof ModelsDevMetadata>;
};

export const inceptron = {
  id: "inceptron",
  name: "Inceptron",
  modelsDir: "providers/inceptron/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Inceptron request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels: parseInceptronModels,
  translateModel(model) {
    return { id: model.id, model: buildInceptronModel(model) };
  },
} satisfies SyncProvider<ReadyInceptronModel>;

export function parseInceptronModels(raw: unknown): ReadyInceptronModel[] {
  const models = InceptronResponse.parse(raw).data.filter((model) => model.is_ready !== false);
  const seen = new Set<string>();

  return models.map((model) => {
    if (seen.has(model.id)) throw new Error(`Duplicate ready Inceptron model ID: ${model.id}`);
    seen.add(model.id);
    if (model.models_dev === undefined) {
      throw new Error(`Ready Inceptron model ${model.id} is missing models_dev metadata`);
    }
    if (!baseModelExists(model.models_dev.base_model)) {
      throw new Error(
        `Ready Inceptron model ${model.id} refers to missing base model ${model.models_dev.base_model}`,
      );
    }
    validateReasoningContract(model as ReadyInceptronModel);
    validatePricing(model);
    validateModalities(model);
    return model as ReadyInceptronModel;
  });
}

export function buildInceptronModel(model: ReadyInceptronModel): SyncedModel {
  const features = new Set(model.supported_features);
  const samplingParameters = new Set(model.supported_sampling_parameters);
  const input = validateModalities(model).input;
  const output = validateModalities(model).output;
  const limit = {
    context: model.context_length,
    output: model.max_output_length,
  };

  return factorBaseModel(
    model.models_dev.base_model,
    {
      name: model.name,
      attachment: input.some((modality) => modality !== "text"),
      reasoning: features.has("reasoning"),
      reasoning_options: model.models_dev.reasoning_options,
      interleaved: model.models_dev.interleaved,
      tool_call: features.has("tools"),
      structured_output: features.has("structured_outputs"),
      temperature: samplingParameters.has("temperature"),
      status: model.models_dev.status,
      cost: {
        input: perTokenToPerMillion(model.pricing.prompt),
        output: perTokenToPerMillion(model.pricing.completion),
        cache_read: optionalPrice(model.pricing.input_cache_reads),
        cache_write: optionalPrice(model.pricing.input_cache_writes),
      },
      limit,
      modalities: { input, output },
    },
    limit,
  );
}

function baseModelExists(modelID: string) {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

function validateReasoningContract(model: ReadyInceptronModel) {
  const supportsReasoning = model.supported_features.includes("reasoning");
  const options = model.models_dev.reasoning_options;
  if (supportsReasoning !== (options !== undefined)) {
    throw new Error(
      `Inceptron model ${model.id} must expose reasoning_options exactly when reasoning is supported`,
    );
  }
  if (model.models_dev.interleaved !== undefined && !supportsReasoning) {
    throw new Error(`Inceptron model ${model.id} exposes interleaving without reasoning`);
  }

  const optionTypes = options?.map((option) => option.type) ?? [];
  if (new Set(optionTypes).size !== optionTypes.length) {
    throw new Error(`Inceptron model ${model.id} has duplicate reasoning option types`);
  }
  const exposesEffort = optionTypes.includes("effort");
  const advertisesEffort = model.supported_sampling_parameters.includes("reasoning_effort");
  if (exposesEffort !== advertisesEffort) {
    throw new Error(
      `Inceptron model ${model.id} must advertise reasoning_effort exactly when effort options are exposed`,
    );
  }
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";
const MODALITIES = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);

function validateModalities(model: InceptronModel): { input: Modality[]; output: Modality[] } {
  const parse = (direction: "input" | "output", values: string[]) => {
    const unique = [...new Set(values)];
    for (const value of unique) {
      if (!MODALITIES.has(value as Modality)) {
        throw new Error(`Inceptron model ${model.id} has unsupported ${direction} modality: ${value}`);
      }
    }
    return unique as Modality[];
  };
  return {
    input: parse("input", model.input_modalities),
    output: parse("output", model.output_modalities),
  };
}

function validatePricing(model: InceptronModel) {
  perTokenToPerMillion(model.pricing.prompt);
  perTokenToPerMillion(model.pricing.completion);
  optionalPrice(model.pricing.input_cache_reads);
  optionalPrice(model.pricing.input_cache_writes);
}

function optionalPrice(value: string | undefined) {
  return value === undefined ? undefined : perTokenToPerMillion(value);
}

/** Convert a non-negative decimal USD/token string to USD/million tokens without floating-point multiplication. */
export function perTokenToPerMillion(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new Error(`Invalid Inceptron per-token price: ${value}`);

  const integer = match[1] as string;
  const fraction = match[2] ?? "";
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  const decimalPlaces = fraction.length - 6;
  const scaled = decimalPlaces <= 0
    ? `${digits}${"0".repeat(-decimalPlaces)}`
    : `${digits.slice(0, -decimalPlaces) || "0"}.${digits.slice(-decimalPlaces).padStart(decimalPlaces, "0")}`;
  const result = Number(scaled);
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`Invalid Inceptron per-token price: ${value}`);
  }
  return result;
}
