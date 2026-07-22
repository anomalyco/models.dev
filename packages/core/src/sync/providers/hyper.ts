import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://hyper.charm.land/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const EffortLevel = z.object({ value: z.string() }).passthrough();
const HyperModel = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  created: z.number().int().nonnegative(),
  context_window: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative(),
  capabilities: z.object({ vision: z.boolean().optional() }).passthrough(),
  reasoning: z.object({
    effort_levels: z.array(EffortLevel),
    default_effort_level: z.string().optional(),
  }).nullable().optional(),
  pricing: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_create: z.number().nonnegative().optional(),
    cache_hit: z.number().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

const HyperResponse = z.object({ data: z.array(HyperModel) }).passthrough();
export type HyperModel = z.infer<typeof HyperModel>;

export const hyper = {
  id: "hyper",
  name: "Charm Hyper",
  modelsDir: "providers/hyper/models",
  async fetchModels() {
    const key = process.env.HYPER_API_KEY;
    const response = await fetch(API_ENDPOINT, key
      ? { headers: { Authorization: `Bearer ${key}` } }
      : undefined);
    if (!response.ok) {
      throw new Error(`Hyper models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HyperResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveBaseModel(model.id);
    if (baseModel === undefined || !baseModelExists(baseModel)) return undefined;
    return {
      id: model.id,
      model: buildHyperModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<HyperModel>;

function buildHyperModel(
  model: HyperModel,
  existing: ExistingModel | undefined,
  baseModel: string,
): SyncedModel {
  const input = model.capabilities.vision === true ? ["text" as const, "image" as const] : ["text" as const];
  const effortValues = model.reasoning?.effort_levels
    .map((level) => level.value)
    .filter(isReasoningEffort);
  const reasoning = model.reasoning !== null && model.reasoning !== undefined;
  const cost = {
    input: model.pricing.input,
    output: model.pricing.output,
    cache_read: model.pricing.cache_hit,
    cache_write: model.pricing.cache_create,
    reasoning: existing?.cost?.reasoning,
    tiers: existing?.cost?.tiers,
  };

  return factorBaseModel(baseModel, {
    name: model.display_name ?? existing?.name,
    attachment: input.length > 1,
    reasoning,
    reasoning_options: reasoning && effortValues !== undefined && effortValues.length > 0
      ? [{ type: "effort", values: effortValues }]
      : reasoning ? [] : undefined,
    tool_call: existing?.tool_call,
    structured_output: existing?.structured_output,
    temperature: existing?.temperature,
    cost,
    limit: {
      context: model.context_window,
      input: existing?.limit?.input,
      output: model.max_output_tokens,
    },
    modalities: { input, output: ["text"] },
    status: existing?.status,
    interleaved: existing?.interleaved,
    provider: existing?.provider,
    experimental: existing?.experimental,
  }, {
    context: model.context_window,
    input: existing?.limit?.input,
    output: model.max_output_tokens,
  }, existing?.base_model_omit);
}

function baseModelExists(modelID: string) {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

const BASE_MODEL_ALIASES: Record<string, string> = {
  "llama-4-maverick-17b-128e-instruct-fp8": "meta/llama-4-maverick-17b-instruct",
  "qwen3-coder-480b-a35b-instruct-int4-mixed-ar": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3.6-max": "alibaba/qwen3.6-max-preview",
};

const BASE_MODEL_PREFIXES: Array<[string, string]> = [
  ["deepseek-v4-", "deepseek"],
  ["glm-", "zhipuai"],
  ["gpt-oss-", "openai"],
  ["kimi-", "moonshotai"],
  ["gemma-", "google"],
  ["llama-", "meta"],
  ["minimax-", "minimax"],
  ["qwen", "alibaba"],
];

function resolveBaseModel(id: string) {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) return alias;
  const prefix = BASE_MODEL_PREFIXES.find(([value]) => id.startsWith(value));
  if (prefix === undefined) return undefined;
  const candidate = `${prefix[1]}/${id}`;
  return baseModelExists(candidate) ? candidate : undefined;
}

function isReasoningEffort(value: string): value is "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"].includes(value);
}
