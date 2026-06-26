import path from "node:path";
import { z } from "zod";

import { inferKimiFamily, ModelFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://trace.wandb.ai/inference/modelsdev/models";

const WandbCost = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  input_audio: z.number().optional(),
  output_audio: z.number().optional(),
}).passthrough();

const WandbLimit = z.object({
  context: z.number(),
  input: z.number().optional(),
  output: z.number(),
}).passthrough();

const WandbModalities = z.object({
  input: z.array(z.string()),
  output: z.array(z.string()),
}).passthrough();

export const WandbModel = z.object({
  id: z.string(),
  name: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string(),
  last_updated: z.string(),
  open_weights: z.boolean(),
  status: z.string().optional(),
  interleaved: z.union([z.boolean(), z.object({ field: z.string() }).passthrough()]).optional(),
  cost: WandbCost.optional(),
  limit: WandbLimit.optional(),
  modalities: WandbModalities.optional(),
}).passthrough();

const WandbProvider = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string(),
  env: z.array(z.string()),
  doc: z.string(),
  api: z.string().optional(),
  models: z.record(z.string(), WandbModel),
}).passthrough();

const WandbResponse = z.record(z.string(), WandbProvider);

export type WandbModel = z.infer<typeof WandbModel>;

type SupportedModality = "text" | "audio" | "image" | "video" | "pdf";
type InterleavedObject = Exclude<SyncedFullModel["interleaved"], true | undefined>;

const modalityMap: Record<string, SupportedModality | undefined> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  pdf: "pdf",
  file: "pdf",
  files: "pdf",
};

export const wandb = {
  id: "wandb",
  name: "Weights & Biases",
  modelsDir: "providers/wandb/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local W&B models were absent from the W&B Inference catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`W&B Inference request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return Object.values(WandbResponse.parse(raw)).flatMap((provider) => Object.values(provider.models));
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildWandbModel(model, context.existing(model.id)),
    };
  },
  sameModel(current, desired) {
    return sameWandbModel(current, desired);
  },
} satisfies SyncProvider<WandbModel>;

export function buildWandbModel(
  model: WandbModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedFullModel {
  const inputModalities = normalizeModalities(model.modalities?.input ?? []);
  const outputModalities = normalizeModalities(model.modalities?.output ?? []);

  return {
    name: existing?.name ?? normalizeName(model),
    family: resolveFamily(existing, model),
    attachment: existing?.attachment ?? model.attachment,
    reasoning: existing?.reasoning ?? model.reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature: existing?.temperature ?? model.temperature ?? true,
    tool_call: existing?.tool_call ?? model.tool_call,
    structured_output: existing?.structured_output !== undefined
      ? existing.structured_output
      : model.structured_output === true
      ? true
      : undefined,
    knowledge: existing?.knowledge ?? model.knowledge,
    release_date: existing?.release_date ?? model.release_date,
    last_updated: today,
    open_weights: existing?.open_weights ?? model.open_weights,
    status: resolveStatus(existing, model.status),
    interleaved: existing?.interleaved ?? normalizeInterleaved(model.interleaved),
    cost: buildCost(model.cost, existing?.cost),
    limit: {
      context: model.limit?.context ?? existing?.limit?.context ?? 0,
      output: model.limit?.output ?? existing?.limit?.output ?? 0,
      input: existing?.limit?.input,
    },
    modalities: {
      input: inputModalities.length > 0
        ? inputModalities
        : existing?.modalities?.input ?? ["text"],
      output: outputModalities.length > 0
        ? outputModalities
        : existing?.modalities?.output ?? ["text"],
    },
  };
}

function buildCost(
  cost: WandbModel["cost"],
  existing: ExistingModel["cost"] | undefined,
): SyncedFullModel["cost"] | undefined {
  if (cost !== undefined) {
    return {
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read !== undefined && cost.cache_read > 0
        ? cost.cache_read
        : undefined,
      cache_write: cost.cache_write !== undefined && cost.cache_write > 0
        ? cost.cache_write
        : undefined,
    };
  }

  if (existing?.input === undefined || existing.output === undefined) return undefined;
  return {
    input: existing.input,
    output: existing.output,
    cache_read: existing.cache_read,
    cache_write: existing.cache_write,
  };
}

function normalizeName(model: WandbModel): string {
  const stripped = model.name.replace(/^[^:]+:\s*/, "").trim();
  return stripped || path.basename(model.id);
}

function normalizeModalities(values: string[]): SupportedModality[] {
  const normalized = values
    .map((value) => modalityMap[value.toLowerCase()])
    .filter((value): value is SupportedModality => value !== undefined);
  return [...new Set(normalized)];
}

function normalizeInterleaved(
  value: WandbModel["interleaved"],
): SyncedFullModel["interleaved"] | undefined {
  if (value === true) return true;
  if (value !== undefined && value !== false) {
    return { field: value.field as InterleavedObject["field"] };
  }
  return undefined;
}

function resolveStatus(
  existing: ExistingModel | undefined,
  status: string | undefined,
): SyncedFullModel["status"] | undefined {
  return existing?.status ?? (status as SyncedFullModel["status"] | undefined);
}

function resolveFamily(
  existing: ExistingModel | undefined,
  model: WandbModel,
): SyncedFullModel["family"] | undefined {
  if (existing?.family !== undefined) return existing.family;
  const inferred = inferFamily(model.id, model.name);
  return isValidFamily(inferred) ? inferred : undefined;
}

function isValidFamily(family: string | undefined): family is ModelFamily {
  return family !== undefined && ModelFamily.safeParse(family).success;
}

function inferFamily(modelID: string, modelName: string): string | undefined {
  const kimiFamily = inferKimiFamily(modelID, modelName);
  if (kimiFamily !== undefined) return kimiFamily;

  const sortedFamilies = [...ModelFamilyValues].sort((a, b) => b.length - a.length);

  for (const family of sortedFamilies) {
    if (includesIgnoreCase(modelID, family) || includesIgnoreCase(modelName, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (isSubsequence(modelID, family) || isSubsequence(modelName, family)) {
      return family;
    }
  }

  return undefined;
}

function includesIgnoreCase(target: string, value: string) {
  return target.toLowerCase().includes(value.toLowerCase());
}

function isSubsequence(target: string, value: string) {
  const targetLower = target.toLowerCase();
  const valueLower = value.toLowerCase();
  let valueIndex = 0;

  for (const character of targetLower) {
    if (character === valueLower[valueIndex]) valueIndex++;
  }

  return valueIndex === valueLower.length;
}

function sameWandbModel(current: ExistingModel, desired: SyncedModel) {
  const desiredModel = desired as SyncedFullModel;
  const fields: Array<[unknown, unknown, boolean?]> = [
    [current.name, desiredModel.name],
    [current.family, desiredModel.family],
    [current.release_date, desiredModel.release_date],
    [current.attachment, desiredModel.attachment],
    [current.reasoning, desiredModel.reasoning],
    [current.structured_output, desiredModel.structured_output],
    [current.temperature, desiredModel.temperature],
    [current.tool_call, desiredModel.tool_call],
    [current.open_weights, desiredModel.open_weights],
    [current.cost?.input, desiredModel.cost?.input, true],
    [current.cost?.output, desiredModel.cost?.output, true],
    [current.cost?.cache_read, desiredModel.cost?.cache_read, true],
    [current.cost?.cache_write, desiredModel.cost?.cache_write, true],
    [current.limit?.context, desiredModel.limit?.context],
    [current.limit?.output, desiredModel.limit?.output],
    [current.modalities?.input, desiredModel.modalities?.input],
    [current.modalities?.output, desiredModel.modalities?.output],
  ];

  return fields.every(([currentValue, desiredValue, cost]) => {
    if (cost && currentValue === undefined && desiredValue === undefined) return true;
    if (cost && (currentValue === undefined || desiredValue === undefined)) return false;
    if (cost && typeof currentValue === "number" && typeof desiredValue === "number") {
      return Math.abs(currentValue - desiredValue) <= 0.001;
    }
    return JSON.stringify(currentValue) === JSON.stringify(desiredValue);
  });
}
