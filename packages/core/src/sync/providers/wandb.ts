import path from "node:path";
import { readdirSync } from "node:fs";
import { z } from "zod";

import { inferKimiFamily, ModelFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://trace.wandb.ai/inference/modelsdev/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

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

interface MetadataEntry {
  id: string;
  filename: string;
  normalizedFull: string;
  normalizedFilename: string;
}

const CANONICAL_PREFIXES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  Qwen: "alibaba",
  "zai-org": "zhipuai",
};

let metadataEntries: MetadataEntry[] | undefined;

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
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveWandbBaseModel(model.id);
    return {
      id: model.id,
      model: buildWandbModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<WandbModel>;

export function buildWandbModel(
  model: WandbModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveWandbBaseModel(model.id),
): SyncedModel {
  const inputModalities = normalizeModalities(model.modalities?.input ?? []);
  const outputModalities = normalizeModalities(model.modalities?.output ?? []);
  const limit = {
    context: model.limit?.context ?? existing?.limit?.context ?? 0,
    output: model.limit?.output ?? existing?.limit?.output ?? 0,
  };
  const synced: SyncedFullModel = {
    name: normalizeName(model),
    family: resolveFamily(model),
    attachment: model.attachment,
    reasoning: model.reasoning,
    reasoning_options: model.reasoning ? existing?.reasoning_options ?? [] : undefined,
    temperature: model.temperature ?? true,
    tool_call: model.tool_call,
    structured_output: model.structured_output === true,
    knowledge: model.knowledge ?? existing?.knowledge,
    release_date: model.release_date,
    last_updated: model.last_updated,
    open_weights: model.open_weights,
    status: resolveStatus(existing, model.status),
    interleaved: model.reasoning
      ? normalizeInterleaved(model.interleaved) ?? existing?.interleaved
      : undefined,
    cost: buildCost(model.cost, existing?.cost),
    limit,
    modalities: {
      input: inputModalities.length > 0
        ? inputModalities
        : existing?.modalities?.input ?? ["text"],
      output: outputModalities.length > 0
        ? outputModalities
        : existing?.modalities?.output ?? ["text"],
    },
  };

  if (baseModel === undefined) return synced;
  return factorBaseModel(baseModel, synced, limit, existing?.base_model_omit);
}

function buildCost(
  cost: WandbModel["cost"],
  existing: ExistingModel["cost"] | undefined,
): SyncedFullModel["cost"] | undefined {
  if (cost !== undefined) {
    return {
      input: cost.input,
      output: cost.output,
      reasoning: cost.reasoning,
      cache_read: cost.cache_read !== undefined && cost.cache_read > 0
        ? cost.cache_read
        : undefined,
      cache_write: cost.cache_write !== undefined && cost.cache_write > 0
        ? cost.cache_write
        : undefined,
      input_audio: cost.input_audio,
      output_audio: cost.output_audio,
    };
  }

  if (existing?.input === undefined || existing.output === undefined) return undefined;
  return {
    input: existing.input,
    output: existing.output,
    reasoning: existing.reasoning,
    cache_read: existing.cache_read,
    cache_write: existing.cache_write,
    input_audio: existing.input_audio,
    output_audio: existing.output_audio,
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

function resolveFamily(model: WandbModel): SyncedFullModel["family"] | undefined {
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

function resolveWandbBaseModel(id: string) {
  const [prefix, ...modelParts] = id.split("/");
  if (prefix === undefined || modelParts.length === 0) return undefined;

  const namespace = CANONICAL_PREFIXES[prefix];
  if (namespace === undefined) return undefined;

  const modelID = modelParts.join("/");
  const candidates = canonicalCandidates(namespace, modelID);
  for (const candidate of candidates) {
    const match = metadataMatch(namespace, candidate);
    if (match !== undefined) return match.id;
  }

  return undefined;
}

function canonicalCandidates(namespace: string, modelID: string) {
  const lower = modelID.toLowerCase();
  const candidates = [
    modelID,
    lower,
    lower.replace(/^nvidia-/, ""),
    lower.replace(/^nvidia-/, "").replace(/-fp8$/, ""),
    lower.replace(/-(?:instruct|thinking)-2507$/, ""),
  ];

  if (namespace === "alibaba") {
    candidates.push(lower.replace(/-a22b-(?:instruct|thinking)-2507$/, "-a22b"));
  }

  return [...new Set(candidates)];
}

function metadataMatch(namespace: string, candidate: string) {
  const normalizedCandidate = normalize(candidate);
  const normalizedFull = normalize(`${namespace}/${candidate}`);
  const matches = getMetadataEntries(namespace).filter((entry) =>
    entry.filename === candidate ||
    entry.normalizedFilename === normalizedCandidate ||
    entry.normalizedFull === normalizedFull
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function getMetadataEntries(namespace: string) {
  metadataEntries ??= readMetadataEntries();
  return metadataEntries.filter((entry) => entry.id.startsWith(`${namespace}/`));
}

function readMetadataEntries() {
  const entries: MetadataEntry[] = [];
  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const filename = file.name.slice(0, -5);
      const id = `${provider.name}/${filename}`;
      entries.push({
        id,
        filename,
        normalizedFull: normalize(id),
        normalizedFilename: normalize(filename),
      });
    }
  }
  return entries;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
