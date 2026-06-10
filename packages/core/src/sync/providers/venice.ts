import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.venice.ai/api/v1/models?type=text";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const Capabilities = z.object({
  supportsAudioInput: z.boolean().optional(),
  supportsFunctionCalling: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  reasoningEffortOptions: z.array(z.string()).optional(),
  supportsResponseSchema: z.boolean().optional(),
  supportsVideoInput: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
}).passthrough();

const PricingTier = z.object({
  usd: z.number().nonnegative(),
}).passthrough();

const ExtendedPricing = z.object({
  context_token_threshold: z.number().int().nonnegative(),
  input: PricingTier,
  output: PricingTier,
  cache_input: PricingTier.optional(),
  cache_write: PricingTier.optional(),
}).passthrough();

const Pricing = z.object({
  input: PricingTier,
  output: PricingTier,
  cache_input: PricingTier.optional(),
  cache_write: PricingTier.optional(),
  extended: ExtendedPricing.optional(),
}).passthrough();

const ModelSpec = z.object({
  pricing: Pricing.optional(),
  availableContextTokens: z.number().int().nonnegative(),
  maxCompletionTokens: z.number().int().nonnegative().optional(),
  capabilities: Capabilities,
  name: z.string().min(1),
  modelSource: z.string().optional(),
}).passthrough();

export const VeniceModel = z.object({
  created: z.number(),
  id: z.string().min(1),
  model_spec: ModelSpec,
}).passthrough();

export const VeniceResponse = z.object({
  data: z.array(VeniceModel),
}).passthrough();

export type VeniceModel = z.infer<typeof VeniceModel>;

type ReasoningEffort = "default" | "max" | "low" | "high" | "none" | "medium" | "minimal" | "xhigh";

interface MetadataEntry {
  id: string;
  filename: string;
  normalizedFull: string;
  normalizedFilename: string;
}

let metadataEntries: MetadataEntry[] | undefined;

export const venice = {
  id: "venice",
  name: "Venice",
  modelsDir: "providers/venice/models",
  deleteMissing: false,
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Venice models were absent from the API response and were retained because model visibility can depend on API-key access.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const headers = process.env.VENICE_API_KEY
      ? { Authorization: `Bearer ${process.env.VENICE_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Venice models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return VeniceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const id = model.id.replaceAll("/", "-");
    const existing = context.existing(id);
    const baseModel = existing?.base_model ?? resolveVeniceBaseModel(model.id, model.model_spec.name);
    return {
      id,
      model: buildVeniceModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<VeniceModel>;

export function buildVeniceModel(
  model: VeniceModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveVeniceBaseModel(model.id, model.model_spec.name),
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const spec = model.model_spec;
  const capabilities = spec.capabilities;
  const input = [
    "text" as const,
    ...(capabilities.supportsVision ? ["image" as const] : []),
    ...(capabilities.supportsAudioInput ? ["audio" as const] : []),
    ...(capabilities.supportsVideoInput ? ["video" as const] : []),
    ...(existing?.modalities?.input.includes("pdf") ? ["pdf" as const] : []),
  ];
  const limit = {
    context: spec.availableContextTokens,
    input: existing?.limit?.input,
    output: spec.maxCompletionTokens ?? Math.floor(spec.availableContextTokens / 4),
  };
  const reasoningEfforts = capabilities.reasoningEffortOptions?.filter(isReasoningEffort);
  const reasoningOptions = reasoningEfforts?.length
    ? [{ type: "effort" as const, values: reasoningEfforts }]
    : existing?.reasoning_options;
  const cost = spec.pricing === undefined
    ? existing?.cost
    : {
        input: spec.pricing.input.usd,
        output: spec.pricing.output.usd,
        reasoning: existing?.cost?.reasoning,
        cache_read: spec.pricing.cache_input?.usd,
        cache_write: spec.pricing.cache_write?.usd,
        input_audio: existing?.cost?.input_audio,
        output_audio: existing?.cost?.output_audio,
        tiers: spec.pricing.extended === undefined
          ? existing?.cost?.tiers
          : [{
              tier: { type: "context" as const, size: spec.pricing.extended.context_token_threshold },
              input: spec.pricing.extended.input.usd,
              output: spec.pricing.extended.output.usd,
              cache_read: spec.pricing.extended.cache_input?.usd,
              cache_write: spec.pricing.extended.cache_write?.usd,
            }],
      };
  const authoritative = {
    name: spec.name,
    attachment: input.some((value) => value !== "text"),
    reasoning: capabilities.supportsReasoning === true,
    reasoning_options: reasoningOptions,
    tool_call: capabilities.supportsFunctionCalling === true,
    structured_output: capabilities.supportsResponseSchema === true ? true : undefined,
    temperature: true,
    cost,
    limit,
    modalities: { input: [...new Set(input)], output: ["text" as const] },
  };
  const changed = existing !== undefined && Object.entries(authoritative).some(([key, value]) => {
    return stable(value) !== stable(existing[key as keyof ExistingModel]);
  });
  const releaseDate = new Date(model.created * 1000).toISOString().slice(0, 10);
  const values: SyncedFullModel = {
    ...authoritative,
    family: inferFamily(model.id, spec.name) ?? existing?.family,
    release_date: releaseDate,
    last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
    knowledge: existing?.knowledge,
    open_weights: spec.modelSource?.toLowerCase().includes("huggingface")
      ?? existing?.open_weights
      ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
  };

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

export function resolveVeniceBaseModel(id: string, name: string) {
  const entries = getMetadataEntries();
  const normalizedID = normalize(id);
  const normalizedName = normalize(name);
  const ranked = [
    entries.filter((entry) => entry.normalizedFull === normalizedID),
    entries.filter((entry) => entry.normalizedFilename === normalizedID),
    entries.filter((entry) => entry.normalizedFilename === normalizedName),
  ];
  return ranked.find((matches) => matches.length === 1)?.[0]?.id;
}

function getMetadataEntries() {
  if (metadataEntries !== undefined) return metadataEntries;
  metadataEntries = [];
  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const filename = file.name.slice(0, -5);
      metadataEntries.push({
        id: `${provider.name}/${filename}`,
        filename,
        normalizedFull: normalize(`${provider.name}/${filename}`),
        normalizedFilename: normalize(filename),
      });
    }
  }
  return metadataEntries;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["default", "max", "low", "high", "none", "medium", "minimal", "xhigh"].includes(value);
}

function inferFamily(id: string, name: string) {
  const target = normalize(`${id} ${name}`);
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => isSubsequence(target, normalize(family)));
}

function isSubsequence(target: string, candidate: string) {
  let index = 0;
  for (const character of target) {
    if (character === candidate[index]) index++;
  }
  return index === candidate.length;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
