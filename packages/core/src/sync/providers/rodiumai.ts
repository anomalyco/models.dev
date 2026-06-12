import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.rodiumai.io/v1/models";
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const MODELS_DIR = path.join(REPO_ROOT, "models");
const ANTHROPIC_PROVIDER_DIR = path.join(REPO_ROOT, "providers", "anthropic", "models");
const OPENROUTER_PROVIDER_DIR = path.join(REPO_ROOT, "providers", "openrouter", "models");

const EXCLUDED_SLUG_PARTS = [
  "embed",
  "embedding",
  "veo",
  "imagen",
  "sora",
  "tts",
  "whisper",
  "dall",
  "image-",
  "audio",
];

const BASE_MODEL_ALIASES: Record<string, string> = {
  "meta/llama-4-maverick-17b-128e": "meta/llama-4-maverick-17b-instruct",
  "minimax/minimax-m2-7": "minimax/MiniMax-M2.7",
  "minimax/minimax-m2-5": "minimax/MiniMax-M2.5",
  "mistral/mistral-large-3": "mistral/mistral-large-latest",
  "moonshot-ai/kimi-k2.5": "moonshotai/kimi-k2.5",
  "moonshot-ai/kimi-k2.6": "moonshotai/kimi-k2.6",
  "xai/grok-4-20-reasoning": "xai/grok-4.20-0309-reasoning",
  "xai/grok-4-20-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
};

export const RodiumCapabilities = z.object({
  context_window: z.number().int().nonnegative().nullable().optional(),
  max_output_tokens: z.number().int().nonnegative().nullable().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supports_streaming: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_json_mode: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
}).passthrough();

export const RodiumPricing = z.object({
  pricing_unit: z.string().optional(),
  per_image: z.string().nullable().optional(),
}).passthrough();

export const RodiumApiModel = z.object({
  id: z.string().min(1),
  created: z.number(),
  rodiumai_display_name: z.string().optional(),
  rodiumai_capabilities: RodiumCapabilities.optional(),
  rodiumai_pricing: RodiumPricing.optional(),
}).passthrough();

export const RodiumResponse = z.object({
  data: z.array(RodiumApiModel),
}).passthrough();

export type RodiumApiModel = z.infer<typeof RodiumApiModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type ReasoningOption = NonNullable<SyncedFullModel["reasoning_options"]>[number];
type ModelCost = NonNullable<SyncedFullModel["cost"]>;

const metadataFilesByProvider = new Map<string, Set<string>>();
const anthropicProviderModels = new Map<string, Record<string, unknown>>();
const openRouterProviderModels = new Map<string, Record<string, unknown> | null>();

export const rodiumai = {
  id: "rodiumai",
  name: "RodiumAi",
  modelsDir: "providers/rodiumai/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`RodiumAi request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return RodiumResponse.parse(raw).data.filter(isCodingApiModel);
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildRodiumVendorModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<RodiumApiModel>;

export function isCodingApiModel(model: RodiumApiModel): boolean {
  const id = model.id.toLowerCase();
  if (EXCLUDED_SLUG_PARTS.some((part) => id.includes(part))) return false;

  const pricing = model.rodiumai_pricing ?? {};
  if (pricing.per_image) return false;
  if (pricing.pricing_unit === "per_image") return false;

  const caps = model.rodiumai_capabilities ?? {};
  const outputs = caps.output_modalities ?? [];
  if (!outputs.includes("text")) return false;
  if (outputs.includes("video")) return false;
  if (caps.supports_tools !== true) return false;

  return true;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "document" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(modelSlug: string, name: string) {
  const target = `${modelSlug} ${name}`.toLowerCase();
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

function metadataFileExists(modelID: string) {
  const [provider, ...parts] = modelID.split("/");
  if (provider === undefined || parts.length === 0) return false;
  let files = metadataFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(MODELS_DIR, provider)));
    } catch {
      files = new Set();
    }
    metadataFilesByProvider.set(provider, files);
  }
  return files.has(`${parts.join("/")}.toml`);
}

export function resolveRodiumBaseModel(apiID: string): string | undefined {
  const alias = BASE_MODEL_ALIASES[apiID];
  if (alias !== undefined && metadataFileExists(alias)) return alias;

  const canonical = resolveCanonicalBaseModel(apiID);
  if (canonical !== undefined && metadataFileExists(canonical)) return canonical;

  const [brand, ...parts] = apiID.split("/");
  if (brand === undefined || parts.length === 0) return undefined;
  const slug = parts.join("/");
  const directCandidates = [
    `${brand}/${slug}`,
    brand === "moonshot-ai" ? `moonshotai/${slug}` : undefined,
    brand === "minimax" ? `minimax/${slug.replace(/^minimax-m/, "MiniMax-M")}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return directCandidates.find((candidate) => metadataFileExists(candidate));
}

function openRouterProviderModel(apiID: string): Record<string, unknown> | undefined {
  if (openRouterProviderModels.has(apiID)) {
    return openRouterProviderModels.get(apiID) ?? undefined;
  }

  const filePath = path.join(OPENROUTER_PROVIDER_DIR, `${apiID}.toml`);
  try {
    const parsed = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    openRouterProviderModels.set(apiID, parsed);
    return parsed;
  } catch {
    openRouterProviderModels.set(apiID, null);
    return undefined;
  }
}

function anthropicDirectProviderModel(baseModel: string): Record<string, unknown> | undefined {
  if (!baseModel.startsWith("anthropic/")) return undefined;
  const slug = baseModel.slice("anthropic/".length);
  let cached = anthropicProviderModels.get(slug);
  if (cached === undefined) {
    try {
      cached = Bun.TOML.parse(
        readFileSync(path.join(ANTHROPIC_PROVIDER_DIR, `${slug}.toml`), "utf8"),
      ) as Record<string, unknown>;
      anthropicProviderModels.set(slug, cached);
    } catch {
      return undefined;
    }
  }
  return cached;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveReasoningOptions(
  apiID: string,
  baseModel: string | undefined,
  existing: ExistingModel | undefined,
): ReasoningOption[] | undefined {
  if (existing?.reasoning_options !== undefined && existing.reasoning_options.length > 0) {
    return existing.reasoning_options;
  }

  const fromOpenRouter = openRouterProviderModel(apiID)?.reasoning_options;
  if (Array.isArray(fromOpenRouter) && fromOpenRouter.length > 0) {
    return fromOpenRouter as ReasoningOption[];
  }

  if (baseModel === undefined) return undefined;
  const direct = anthropicDirectProviderModel(baseModel);
  const options = direct?.reasoning_options;
  if (Array.isArray(options) && options.length > 0) return options as ReasoningOption[];
  return undefined;
}

function resolveProviderTemperature(
  apiID: string,
  baseModel: string | undefined,
): boolean | undefined {
  const fromOpenRouter = openRouterProviderModel(apiID)?.temperature;
  if (typeof fromOpenRouter === "boolean") return fromOpenRouter;
  if (baseModel === undefined) return undefined;
  const direct = anthropicDirectProviderModel(baseModel);
  return typeof direct?.temperature === "boolean" ? direct.temperature : undefined;
}

function resolveReasoningFlag(
  apiID: string,
  baseModel: string | undefined,
  supportsReasoning: boolean | undefined,
): boolean | undefined {
  const fromOpenRouter = openRouterProviderModel(apiID)?.reasoning;
  if (typeof fromOpenRouter === "boolean") return fromOpenRouter;
  if (supportsReasoning === true) return true;
  if (baseModel !== undefined) return undefined;
  return supportsReasoning === true ? true : false;
}

function resolveProviderCost(apiID: string, existing: ExistingModel | undefined): ModelCost | undefined {
  if (existing?.cost?.input !== undefined && existing.cost.output !== undefined) {
    return existing.cost;
  }
  const fromOpenRouter = openRouterProviderModel(apiID)?.cost;
  if (isPlainObject(fromOpenRouter)
    && typeof fromOpenRouter.input === "number"
    && typeof fromOpenRouter.output === "number") {
    return fromOpenRouter as ModelCost;
  }
  return existing?.cost;
}

function resolveOpenRouterBaseModel(apiID: string): string | undefined {
  const reference = openRouterProviderModel(apiID);
  return typeof reference?.base_model === "string" ? reference.base_model : undefined;
}

function openRouterFactoredOverrides(apiID: string): Partial<SyncedFullModel> {
  const reference = openRouterProviderModel(apiID);
  if (reference === undefined) return {};

  const overrides: Partial<SyncedFullModel> = {};
  if (typeof reference.structured_output === "boolean") {
    overrides.structured_output = reference.structured_output;
  }
  if (typeof reference.tool_call === "boolean") overrides.tool_call = reference.tool_call;
  if (reference.interleaved !== undefined) {
    overrides.interleaved = reference.interleaved as SyncedFullModel["interleaved"];
  }
  return overrides;
}

export function buildRodiumVendorModel(
  model: RodiumApiModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const caps = model.rodiumai_capabilities ?? {};
  const name = model.rodiumai_display_name ?? model.id.split("/").slice(1).join("/") ?? model.id;
  const input = modalities(caps.input_modalities ?? ["text"], ["text"]);
  const output = modalities(caps.output_modalities ?? ["text"], ["text"]);
  const attachment = input.some((value) => value !== "text") || caps.supports_vision === true;
  const baseModel = existing?.base_model
    ?? resolveRodiumBaseModel(model.id)
    ?? resolveOpenRouterBaseModel(model.id);
  const openRouterRef = openRouterProviderModel(model.id);
  const reasoning = resolveReasoningFlag(model.id, baseModel, caps.supports_reasoning);
  const toolCall = caps.supports_tools === true;
  const structuredOutput = caps.supports_json_mode === true ? true : undefined;
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const limit = {
    context: caps.context_window
      ?? existing?.limit?.context
      ?? (isPlainObject(openRouterRef?.limit) && typeof openRouterRef.limit.context === "number"
        ? openRouterRef.limit.context
        : 128_000),
    input: existing?.limit?.input,
    output: caps.max_output_tokens
      ?? existing?.limit?.output
      ?? (isPlainObject(openRouterRef?.limit) && typeof openRouterRef.limit.output === "number"
        ? openRouterRef.limit.output
        : 32_768),
  };
  const reasoningOptions = resolveReasoningOptions(model.id, baseModel, existing);
  const temperature = resolveProviderTemperature(model.id, baseModel);
  const cost = resolveProviderCost(model.id, existing);
  const referenceOverrides = openRouterFactoredOverrides(model.id);
  const changed = existing !== undefined && (
    existing.name !== name
    || existing.reasoning !== reasoning
    || existing.tool_call !== toolCall
    || existing.attachment !== attachment
    || existing.limit?.context !== limit.context
    || existing.limit?.output !== limit.output
  );

  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        ...referenceOverrides,
        name,
        attachment: typeof openRouterRef?.attachment === "boolean" ? openRouterRef.attachment : attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature,
        tool_call: referenceOverrides.tool_call ?? toolCall,
        structured_output: referenceOverrides.structured_output ?? structuredOutput,
        last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
        cost,
        limit,
        modalities: { input, output },
      },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  if (openRouterRef !== undefined && openRouterRef.base_model === undefined) {
    return {
      name: typeof openRouterRef.name === "string" ? openRouterRef.name : name,
      family: existing?.family
        ?? (typeof openRouterRef.family === "string" ? openRouterRef.family : inferFamily(model.id.split("/").slice(1).join("/"), name)),
      release_date: typeof openRouterRef.release_date === "string" ? openRouterRef.release_date : releaseDate,
      last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
      attachment: typeof openRouterRef.attachment === "boolean" ? openRouterRef.attachment : attachment,
      reasoning: typeof openRouterRef.reasoning === "boolean" ? openRouterRef.reasoning : (reasoning ?? false),
      reasoning_options: reasoningOptions ?? (Array.isArray(openRouterRef.reasoning_options)
        ? openRouterRef.reasoning_options as ReasoningOption[]
        : []),
      temperature: typeof openRouterRef.temperature === "boolean" ? openRouterRef.temperature : (temperature ?? true),
      tool_call: typeof openRouterRef.tool_call === "boolean" ? openRouterRef.tool_call : toolCall,
      structured_output: typeof openRouterRef.structured_output === "boolean"
        ? openRouterRef.structured_output
        : structuredOutput,
      knowledge: typeof openRouterRef.knowledge === "string" ? openRouterRef.knowledge : existing?.knowledge,
      open_weights: typeof openRouterRef.open_weights === "boolean" ? openRouterRef.open_weights : false,
      cost: cost ?? (isPlainObject(openRouterRef.cost) ? openRouterRef.cost as ModelCost : undefined),
      limit,
      modalities: { input, output },
    } satisfies SyncedFullModel;
  }

  return {
    name,
    family: existing?.family ?? inferFamily(model.id.split("/").slice(1).join("/"), name),
    release_date: releaseDate,
    last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
    attachment,
    reasoning: reasoning ?? false,
    reasoning_options: reasoningOptions ?? [],
    temperature: temperature ?? true,
    tool_call: toolCall,
    structured_output: structuredOutput,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}
