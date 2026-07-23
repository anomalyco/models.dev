import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://hyper.charm.land/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

function baseModelExists(modelID: string) {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

function baseModelReasons(baseModel: string) {
  const metadata = Bun.TOML.parse(
    readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
  ) as { reasoning?: boolean };
  return metadata.reasoning === true;
}

const ReasoningEffort = z.enum([
  "default",
  "max",
  "low",
  "high",
  "none",
  "medium",
  "minimal",
  "xhigh",
]);

export const HyperModel = z.object({
  id: z.string(),
  created: z.number(),
  display_name: z.string(),
  context_window: z.number(),
  max_output_tokens: z.number(),
  capabilities: z.object({
    vision: z.boolean().optional(),
  }).optional(),
  reasoning: z.object({
    effort_levels: z.array(z.object({
      value: z.string(),
      display: z.string().optional(),
    })).optional(),
  }).optional(),
  pricing: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_hit: z.number().optional(),
    cache_create: z.number().optional(),
  }).optional(),
}).passthrough();

const HyperResponse = z.object({
  data: z.array(HyperModel),
}).passthrough();

export type HyperModel = z.infer<typeof HyperModel>;

export const hyper = {
  id: "hyper",
  name: "Charm Hyper",
  modelsDir: "providers/hyper/models",
  preserveBaseModels: false,
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
    const baseModel = existing?.base_model;
    if (baseModel === undefined || !baseModelExists(baseModel)) return undefined;
    return {
      id: model.id,
      model: buildHyperModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<HyperModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function reasoningOptions(model: HyperModel) {
  const effortLevels = model.reasoning?.effort_levels?.map((level) => level.value) ?? [];
  if (effortLevels.length === 0) return [];
  const values = effortLevels.filter(isReasoningEffort);
  if (values.length === 0) return [{ type: "toggle" as const }];
  return [{ type: "effort" as const, values }];
}

function isReasoningEffort(value: string): value is z.infer<typeof ReasoningEffort> {
  return ReasoningEffort.safeParse(value).success;
}

function price(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function positivePrice(value: number | undefined) {
  return value !== undefined && value > 0 ? price(value) : undefined;
}

function buildCost(model: HyperModel, existing: ExistingModel["cost"] | undefined) {
  const pricing = model.pricing;
  if (pricing?.input === undefined || pricing.output === undefined) return existing;

  return {
    input: price(pricing.input),
    output: price(pricing.output),
    cache_read: positivePrice(pricing.cache_hit)
      ?? (pricing.cache_hit === undefined ? existing?.cache_read : undefined),
    cache_write: positivePrice(pricing.cache_create)
      ?? (pricing.cache_create === undefined ? existing?.cache_write : undefined),
    reasoning: existing?.reasoning,
  };
}

export function buildHyperModel(
  model: HyperModel,
  existing: ExistingModel | undefined,
  baseModel: string,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const limit = {
    context: model.context_window,
    input: existing?.limit?.input,
    output: model.max_output_tokens,
  };
  const values: Partial<SyncedFullModel> = {
    attachment: model.capabilities?.vision ?? false,
    reasoning: model.reasoning != null ? true : undefined,
    reasoning_options: model.reasoning != null
      ? reasoningOptions(model)
      : baseModelReasons(baseModel)
        ? []
        : undefined,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? today,
    interleaved: existing?.interleaved,
    cost: buildCost(model, existing?.cost),
    limit,
  };

  return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}
