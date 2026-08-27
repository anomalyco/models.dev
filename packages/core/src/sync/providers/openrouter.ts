import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://openrouter.ai/api/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const modelMetadataByID = new Map<string, Record<string, unknown>>();
const modelMetadataFilesByProvider = new Map<string, Set<string>>();
let allModelMetadataIDs: string[] | undefined;

const CANONICAL_BASE_MODEL_OVERRIDES = {
  "bytedance/dola-seed-2.0-code": "bytedance-seed/seed-2.0-code",
  "openai/gpt-5.6-luna-pro": "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol-pro": "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra-pro": "openai/gpt-5.6-terra",
  "anthropic/claude-opus-4.7-fast": "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4.8-fast": "anthropic/claude-opus-4-8",
} as const;

const CANONICAL_PROVIDER_PREFIXES = {
  alibaba: { provider: "alibaba", metadata: "alibaba" },
  anthropic: { provider: "anthropic", metadata: "anthropic" },
  "bytedance-seed": { provider: "bytedance-seed", metadata: "bytedance-seed" },
  cohere: { provider: "cohere", metadata: "cohere" },
  deepseek: { provider: "deepseek", metadata: "deepseek" },
  google: { provider: "google", metadata: "google" },
  meta: { provider: "llama", metadata: "meta" },
  "meta-llama": { provider: "llama", metadata: "meta" },
  minimax: { provider: "minimax", metadata: "minimax" },
  mistralai: { provider: "mistral", metadata: "mistral" },
  moonshot: { provider: "moonshotai", metadata: "moonshotai" },
  moonshotai: { provider: "moonshotai", metadata: "moonshotai" },
  openai: { provider: "openai", metadata: "openai" },
  nvidia: { provider: "nvidia", metadata: "nvidia" },
  qwen: { provider: "alibaba", metadata: "alibaba" },
  sakana: { provider: "sakana", metadata: "sakana" },
  stepfun: { provider: "stepfun", metadata: "stepfun" },
  "stepfun-ai": { provider: "stepfun", metadata: "stepfun" },
  tencent: { provider: "tencent", metadata: "tencent" },
  thinkingmachines: { provider: "thinkingmachines", metadata: "thinkingmachines" },
  "x-ai": { provider: "xai", metadata: "xai" },
  xai: { provider: "xai", metadata: "xai" },
  xiaomi: { provider: "xiaomi", metadata: "xiaomi" },
  zai: { provider: "zai", metadata: "zhipuai" },
  "z-ai": { provider: "zai", metadata: "zhipuai" },
  "zai-org": { provider: "zai", metadata: "zhipuai" },
} as const;

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
    overrides: z.array(z.object({
      min_prompt_tokens: z.number().optional(),
      prompt: z.string().optional(),
      completion: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
    }).passthrough()).optional(),
  }),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }),
  supported_parameters: z.array(z.string()),
  reasoning: z
    .object({
      mandatory: z.boolean(),
      supported_efforts: z
        .array(z.enum(["max", "xhigh", "high", "medium", "low", "minimal", "none"]))
        .nullable()
        .optional(),
      supports_max_tokens: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
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
    // Temporarily skip batch routes (`*:batch`) — they are not catalog targets.
    return OpenRouterResponse.parse(raw).data.filter((model) => !model.id.endsWith(":batch"));
  },
  translateModel(model, context) {
    // OpenRouter serves deprecated/unavailable routes as degraded stubs:
    // negative pricing (`"-1"`) and an empty `supported_parameters` array. Syncing
    // those would wrongly flip `reasoning`/`tool_call`/`structured_output` to false
    // and strip `reasoning_options`. Leave the authored file untouched instead, and
    // skip the model entirely when we have nothing to preserve.
    if (isUnavailable(model)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    return {
      id: model.id,
      model: buildOpenRouterModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<OpenRouterModel>;

function isUnavailable(model: OpenRouterModel) {
  return (
    model.supported_parameters.length === 0 ||
    Number(model.pricing.prompt) < 0 ||
    Number(model.pricing.completion) < 0
  );
}

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

function costTiers(model: OpenRouterModel, existing: ExistingModel | undefined) {
  const tiers = (model.pricing.overrides ?? [])
    .flatMap((o) => {
      const input = price(o.prompt);
      const output = price(o.completion);
      if (o.min_prompt_tokens === undefined || input === undefined || output === undefined) return [];
      return [{
        tier: { type: "context" as const, size: o.min_prompt_tokens },
        input,
        output,
        cache_read: price(o.input_cache_read),
        cache_write: price(o.input_cache_write),
      }];
    })
    .sort((a, b) => a.tier.size - b.tier.size);
  return tiers.length > 0 ? tiers : existing?.cost?.tiers;
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
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;

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

export function buildOpenRouterModel(
  model: OpenRouterModel,
  existing: ExistingModel | undefined,
  baseModel?: string,
): SyncedModel {
  const params = new Set(model.supported_parameters);
  const name = model.name.replace(/^[^:]+:\s+/, "");
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  // Prefer OpenRouter's live reasoning metadata over authored options so aliases
  // and rotated models pick up new efforts/budget support. Fall back to authored
  // only when the API omits a reasoning object.
  const reasoning_options = openRouterReasoningOptions(model.reasoning)
    ?? (reasoning ? existing?.reasoning_options : undefined);
  const context = model.context_length;
  const family = inferFamily(model, name);
  const releaseDate = dateFromTimestamp(model.created);
  const familyValue = existing?.family === "o" && family !== "o"
    ? family
    : (existing?.family ?? family);
  const attachment = input.some((value) => value !== "text");
  const toolCall = params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const knowledge = model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge;
  const openWeights = Boolean(model.hugging_face_id);
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning ? price(model.pricing.internal_reasoning) : undefined,
        cache_read: price(model.pricing.input_cache_read),
        cache_write: price(model.pricing.input_cache_write),
        tiers: costTiers(model, existing),
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.top_provider.max_completion_tokens ?? existing?.limit?.output ?? context,
  };
  const canonical = existing?.base_model ?? baseModel ?? resolveCanonicalBaseModel(model.id);

  if (canonical !== undefined) {
    const canonicalOverride = canonicalBaseModelOverride(model.id);
    return factorBaseModel(
      canonical,
      {
        name: shouldPreserveFactoredName(model.id, canonical, baseModel, canonicalOverride)
          ? name
          : undefined,
        description: existing?.description ?? describeModel({
          id: model.id,
          name,
          family: familyValue,
          reasoning,
          tool_call: toolCall,
          structured_output: structuredOutput,
          open_weights: openWeights,
          limit,
          modalities: { input, output },
        }),
        attachment,
        reasoning,
        reasoning_options,
        temperature: params.has("temperature"),
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
        cost,
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name,
      family: familyValue,
      reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: openWeights,
      limit,
      modalities: { input, output },
    }),
    family: familyValue,
    release_date: releaseDate,
    last_updated: releaseDate,
    attachment,
    reasoning,
    reasoning_options,
    temperature: params.has("temperature"),
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function openRouterReasoningOptions(reasoning: OpenRouterModel["reasoning"]): SyncedFullModel["reasoning_options"] {
  if (reasoning === undefined) return undefined;

  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  const efforts = reasoning.supported_efforts === null
    ? ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const
    : reasoning.supported_efforts;

  if (efforts !== undefined) {
    if (!reasoning.mandatory && !efforts.includes("none")) {
      options.push({ type: "toggle" });
    }
    options.push({
      type: "effort",
      values: reasoning.mandatory ? efforts.filter((value) => value !== "none") : [...efforts],
    });
  }

  if (reasoning.supports_max_tokens === true) {
    options.push({ type: "budget_tokens" });
  }

  return options.length > 0 ? options : undefined;
}

export function resolveCanonicalBaseModel(openrouterID: string) {
  const override = canonicalBaseModelOverride(openrouterID);
  if (override !== undefined) return override;

  const [prefix, ...modelParts] = openrouterID.split("/");
  if (prefix === undefined || modelParts.length === 0) return undefined;
  if (openrouterID.startsWith("~/") || prefix.startsWith("~")) return undefined;

  const canonical = CANONICAL_PROVIDER_PREFIXES[
    prefix.toLowerCase() as keyof typeof CANONICAL_PROVIDER_PREFIXES
  ];
  if (canonical === undefined) return undefined;

  const modelID = modelParts.join("/").replace(/:free$/, "");
  const candidates = canonicalCandidates(canonical.provider, modelID);
  const match = matchingModelMetadataFile(canonical.metadata, candidates);

  return match === undefined ? undefined : `${canonical.metadata}/${match}`;
}

/**
 * Resolve provider IDs that are not OpenRouter-shaped against the same canonical
 * metadata tree. Exact paths win; bare IDs only resolve when their filename is
 * unique across every metadata provider.
 */
export function resolveModelMetadataBaseModel(modelID: string) {
  const routed = resolveCanonicalBaseModel(modelID);
  if (routed !== undefined) return routed;

  const normalized = modelID.replace(/:free$/, "");
  const ids = modelMetadataIDs();
  const exact = ids.find((candidate) => candidate.toLowerCase() === normalized.toLowerCase());
  if (exact !== undefined) return exact;
  if (normalized.includes("/")) return undefined;

  const lower = normalized.toLowerCase();
  const matches = ids.filter((candidate) => candidate.split("/").at(-1)?.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

function matchingModelMetadataFile(provider: string, candidates: string[]) {
  let files = modelMetadataFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(MODELS_DIR, provider)));
    } catch {
      files = new Set();
    }
    modelMetadataFilesByProvider.set(provider, files);
  }

  for (const candidate of candidates) {
    const expected = `${candidate}.toml`.toLowerCase();
    const match = [...files].find((file) => file.toLowerCase() === expected);
    if (match !== undefined) return match.slice(0, -".toml".length);
  }
  return undefined;
}

function modelMetadataIDs() {
  if (allModelMetadataIDs !== undefined) return allModelMetadataIDs;

  try {
    allModelMetadataIDs = readdirSync(MODELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        return readdirSync(path.join(MODELS_DIR, entry.name))
          .filter((file) => file.endsWith(".toml"))
          .map((file) => `${entry.name}/${file.slice(0, -".toml".length)}`);
      });
  } catch {
    allModelMetadataIDs = [];
  }
  return allModelMetadataIDs;
}

function canonicalBaseModelOverride(openrouterID: string) {
  return CANONICAL_BASE_MODEL_OVERRIDES[
    openrouterID as keyof typeof CANONICAL_BASE_MODEL_OVERRIDES
  ];
}

function shouldPreserveFactoredName(
  modelID: string,
  canonical: string,
  baseModel: string | undefined,
  canonicalOverride: string | undefined,
) {
  if (baseModel !== undefined) return true;
  if (modelID.endsWith(":free")) return true;
  if (canonicalOverride === canonical) return true;
  const modelSlug = modelID.split("/").slice(1).join("/").replace(/:free$/, "");
  const canonicalSlug = canonical.split("/").slice(1).join("/");
  return normalizeModelSlug(modelSlug) !== normalizeModelSlug(canonicalSlug);
}

function normalizeModelSlug(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

type BaseModelOverrides = Omit<Partial<SyncedFullModel>, "limit" | "modalities"> & {
  limit?: Partial<SyncedFullModel["limit"]>;
  modalities?: {
    input?: SyncedFullModel["modalities"]["input"];
    output?: SyncedFullModel["modalities"]["output"];
  };
};

export function factorBaseModel(
  modelID: string,
  values: BaseModelOverrides,
  limit?: Partial<SyncedFullModel["limit"]>,
  existingOmit?: string[],
): SyncedModel {
  return {
    base_model: modelID,
    base_model_omit: existingOmit ?? baseModelOmit(modelID, limit),
    ...baseModelOverrides(modelID, values),
  };
}

function baseModelOmit(
  modelID: string,
  limit: Partial<SyncedFullModel["limit"]> | undefined,
) {
  if (limit === undefined) return undefined;
  const metadata = modelMetadata(modelID);
  const omit: string[] = [];
  const baseLimit = metadata.limit;
  if (
    isPlainObject(baseLimit) &&
    baseLimit.input !== undefined &&
    limit.context !== undefined &&
    limit.input === undefined &&
    baseLimit.context !== limit.context
  ) {
    omit.push("limit.input");
  }

  return omit.length > 0 ? omit : undefined;
}

function baseModelOverrides(
  modelID: string,
  values: BaseModelOverrides,
) {
  const metadata = modelMetadata(modelID);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    const override = inheritedOverride(value, metadata[key]);
    if (override !== undefined) result[key] = override;
  }

  return result;
}

function inheritedOverride(value: unknown, inherited: unknown): unknown {
  if (value === undefined) return undefined;
  if (sameInheritedValue(value, inherited)) return undefined;
  if (isPlainObject(value) && isPlainObject(inherited)) {
    const overrides = Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, inheritedOverride(item, inherited[key])])
        .filter(([, item]) => item !== undefined),
    );
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }
  return stripUndefined(value);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }
  return value;
}

function sameInheritedValue(value: unknown, inherited: unknown) {
  return stableInheritedValue(value) === stableInheritedValue(inherited);
}

function stableInheritedValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(stableInheritedValue);
    const ordered = value.every((item) => item === null || typeof item !== "object")
      ? items.sort()
      : items;
    return `[${ordered.join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableInheritedValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelMetadata(modelID: string) {
  let metadata = modelMetadataByID.get(modelID);
  if (metadata === undefined) {
    const filePath = path.join(MODELS_DIR, `${modelID}.toml`);
    metadata = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    modelMetadataByID.set(modelID, metadata);
  }
  return metadata;
}

function canonicalCandidates(provider: string, modelID: string) {
  const candidates = [modelID];
  if (modelID.endsWith("-fast")) candidates.push(modelID.slice(0, -"-fast".length));

  if (provider === "anthropic") {
    for (const candidate of [...candidates]) {
      candidates.push(candidate.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/, "$1-$2"));
      candidates.push(candidate.replace(/^claude-3\.5-/, "claude-3-5-"));
    }
  }

  if (provider === "llama") {
    candidates.push(modelID.replace(/^llama-(\d+)-(\d+)/, "llama-$1.$2"));
    candidates.push(modelID.replace(/^llama-(4)-(maverick|scout)$/, "llama-$1-$2-17b"));
  }

  if (provider === "mistral") {
    candidates.push(modelID.replace(/-latest$/, ""));
  }

  if (provider === "minimax") {
    candidates.push(modelID.replace(/^minimax-m/, "MiniMax-M"));
  }

  return [...new Set(candidates)];
}
