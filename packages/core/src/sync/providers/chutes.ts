import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://llm.chutes.ai/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const CHUTES_ORG_TO_MODEL_PROVIDER: Record<string, string | undefined> = {
  MiniMaxAI: "minimax",
  Qwen: "alibaba",
  XiaomiMiMo: "xiaomi",
  "deepseek-ai": "deepseek",
  google: "google",
  moonshotai: "moonshotai",
  openai: "openai",
  "zai-org": "zhipuai",
};

const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "google/gemma-4-31B-turbo-TEE": "google/gemma-4-31b-it",
  // "unsloth" re-hosts models from many providers, so it has no org mapping; alias the
  // ones whose canonical metadata lives under the original provider's namespace.
  "unsloth/Mistral-Nemo-Instruct-2407-TEE": "mistral/mistral-nemo",
};

const Pricing = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  input_cache_read: z.number().optional(),
}).passthrough();

export const ChutesModel = z.object({
  id: z.string(),
  created: z.number(),
  pricing: Pricing.optional(),
  context_length: z.number().optional(),
  max_output_length: z.number().optional(),
  max_model_len: z.number().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  supported_sampling_parameters: z.array(z.string()).optional(),
  quantization: z.string().optional(),
}).passthrough();

export const ChutesResponse = z.object({
  data: z.array(ChutesModel),
}).passthrough();

export type ChutesModel = z.infer<typeof ChutesModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const chutes = {
  id: "chutes",
  name: "Chutes",
  modelsDir: "providers/chutes/models",
  preserveBaseModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Chutes models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return ChutesResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildChutesModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<ChutesModel>;

export function buildChutesModel(
  model: ChutesModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const features = new Set(model.supported_features ?? []);
  const samplingParams = new Set(model.supported_sampling_parameters ?? []);
  const input = normalizeModalities(model.input_modalities ?? ["text"]);
  const output = normalizeModalities(model.output_modalities ?? ["text"]);

  const attachment = input.some((value) => value !== "text");
  const reasoning = features.has("reasoning");
  const toolCall = features.has("tools");
  const structuredOutput = features.has("structured_outputs");
  // Absent sampling-parameter info, assume temperature is tunable.
  const temperature = samplingParams.size > 0 ? samplingParams.has("temperature") : true;

  const name = existing?.name ?? humanizeModelName(model.id);
  const baseModel = resolveBaseModel(model.id);

  const apiContext = model.context_length ?? model.max_model_len ?? 0;
  const context = apiContext > 0 ? apiContext : existing?.limit?.context ?? 0;
  const apiOutput = model.max_output_length ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: apiOutput > 0 ? apiOutput : existing?.limit?.output ?? 0,
  };

  const cost = model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined
    ? {
        input: model.pricing.prompt,
        output: model.pricing.completion,
        cache_read: model.pricing.input_cache_read,
      }
    : existing?.cost;

  const values: SyncedFullModel = {
    name,
    family: baseModel == null ? (existing?.family ?? inferFamily(model.id, name)) : existing?.family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? today,
    attachment,
    reasoning,
    // Chutes' /v1/models advertises `reasoning` as a capability but exposes no parameter
    // to toggle or set its effort, so there is no provider evidence for a reasoning option.
    reasoning_options: [],
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput ? true : undefined,
    knowledge: existing?.knowledge,
    open_weights: true,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  return baseModel == null
    ? values
    : factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

function resolveBaseModel(modelId: string): string | undefined {
  return baseModelCandidates(modelId).find(canonicalExists);
}

// existsSync is case-insensitive on Windows/macOS; verify the real on-disk filename case
// so the resolved base_model matches the canonical metadata exactly (and CI on Linux).
function canonicalExists(candidate: string): boolean {
  const file = path.join(MODELS_DIR, `${candidate}.toml`);
  if (!existsSync(file)) return false;
  try {
    return readdirSync(path.dirname(file)).includes(path.basename(file));
  } catch {
    return false;
  }
}

function baseModelCandidates(modelId: string): string[] {
  const alias = BASE_MODEL_ALIASES[modelId];
  const [org, ...modelParts] = modelId.split("/");
  if (org === undefined || modelParts.length === 0 || modelParts.join("/").endsWith("-TEE") === false) {
    return alias === undefined ? [] : [alias];
  }

  const provider = CHUTES_ORG_TO_MODEL_PROVIDER[org];
  if (provider === undefined) {
    return alias === undefined ? [] : [alias];
  }

  const withoutTee = modelParts.join("/").slice(0, -"-TEE".length);
  const lower = withoutTee.toLowerCase();
  // Distinct checkpoints (e.g. "-Thinking-2507") keep their own metadata — deliberately
  // not collapsed onto the generic base, which would inherit the wrong capabilities.
  const normalized = [
    withoutTee,
    lower,
    lower.replace(/-turbo$/, "-it"),
    lower.replace(/-turbo$/, ""),
  ];

  return [
    ...new Set([alias, ...normalized.map((candidate) => `${provider}/${candidate}`)]).values(),
  ].filter((candidate): candidate is string => candidate !== undefined);
}

function normalizeModalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  if (result.length === 0) return ["text"];
  return [...new Set(result)];
}

function humanizeModelName(modelId: string): string {
  const modelPart = modelId.split("/").at(-1) ?? modelId;
  return modelPart.replace(/-/g, " ");
}

function dateFromTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}
