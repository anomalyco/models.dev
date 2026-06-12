import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.rodiumai.io/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

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

const SMART_PROFILES = [
  {
    id: "auto",
    name: "Auto (RodiumAI Smart Routing)",
    reasoning: false,
    cost: { input: 0.3, output: 2.5 },
    limit: { context: 1_000_000, output: 32_000 },
  },
  {
    id: "basic",
    name: "Basic",
    reasoning: false,
    cost: { input: 0.05, output: 0.08 },
    limit: { context: 128_000, output: 8192 },
  },
  {
    id: "fast",
    name: "Fast",
    reasoning: false,
    cost: { input: 0.11, output: 0.34 },
    limit: { context: 128_000, output: 16_384 },
  },
  {
    id: "pro",
    name: "Pro",
    reasoning: true,
    cost: { input: 0.3, output: 2.5 },
    limit: { context: 1_000_000, output: 32_000 },
  },
  {
    id: "max",
    name: "Max",
    reasoning: true,
    cost: { input: 3.0, output: 15.0 },
    limit: { context: 200_000, output: 16_384 },
  },
] as const;

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
export type SmartProfile = (typeof SMART_PROFILES)[number];

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type ReasoningOption = NonNullable<SyncedFullModel["reasoning_options"]>[number];

const metadataFilesByProvider = new Map<string, Set<string>>();

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
    const data = RodiumResponse.parse(raw).data.filter(isCodingApiModel);
    return [...SMART_PROFILES, ...data];
  },
  translateModel(model, context) {
    if (isSmartProfile(model)) {
      return {
        id: model.id,
        model: buildSmartProfile(model, context.existing(model.id)),
      };
    }
    return {
      id: model.id,
      model: buildRodiumVendorModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<RodiumApiModel | SmartProfile>;

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

function isSmartProfile(model: RodiumApiModel | SmartProfile): model is SmartProfile {
  return !("created" in model);
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

function defaultReasoningOptions(
  baseModel: string | undefined,
  reasoning: boolean,
  existing: ExistingModel | undefined,
): ReasoningOption[] {
  if (existing?.reasoning_options !== undefined) return existing.reasoning_options;
  if (!reasoning) return [];

  if (baseModel === "anthropic/claude-fable-5") {
    return [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }];
  }
  if (baseModel?.startsWith("anthropic/claude-opus-4-8")) {
    return [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ];
  }
  if (baseModel?.startsWith("anthropic/claude-opus-4-7")) {
    return [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ];
  }
  if (baseModel?.startsWith("anthropic/claude-opus-4-6")) {
    return [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "max"] },
      { type: "budget_tokens", min: 1024, max: 127_999 },
    ];
  }
  if (baseModel?.startsWith("anthropic/claude-sonnet-4-6")) {
    return [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "max"] },
      { type: "budget_tokens", min: 1024, max: 127_999 },
    ];
  }
  if (baseModel?.startsWith("anthropic/")) {
    return [{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 63_999 }];
  }

  return [];
}

export function buildSmartProfile(
  profile: SmartProfile,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedFullModel {
  const releaseDate = existing?.release_date ?? today;
  const changed = existing !== undefined && (
    existing.name !== profile.name
    || existing.reasoning !== profile.reasoning
    || existing.cost?.input !== profile.cost.input
    || existing.cost?.output !== profile.cost.output
    || existing.limit?.context !== profile.limit.context
    || existing.limit?.output !== profile.limit.output
  );

  return {
    name: profile.name,
    family: "rodium-smart",
    release_date: releaseDate,
    last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
    attachment: false,
    reasoning: profile.reasoning,
    reasoning_options: existing?.reasoning_options ?? [],
    temperature: true,
    tool_call: true,
    open_weights: false,
    cost: profile.cost,
    limit: profile.limit,
    modalities: { input: ["text"], output: ["text"] },
  };
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
  const reasoning = caps.supports_reasoning === true;
  const toolCall = caps.supports_tools === true;
  const structuredOutput = caps.supports_json_mode === true ? true : undefined;
  const releaseDate = existing?.release_date ?? dateFromTimestamp(model.created);
  const limit = {
    context: caps.context_window ?? existing?.limit?.context ?? 128_000,
    input: existing?.limit?.input,
    output: caps.max_output_tokens ?? existing?.limit?.output ?? 32_768,
  };
  const baseModel = existing?.base_model ?? resolveRodiumBaseModel(model.id);
  const reasoningOptions = defaultReasoningOptions(baseModel, reasoning, existing);
  const cost = existing?.cost;
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
        name,
        attachment,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature: true,
        tool_call: toolCall,
        structured_output: structuredOutput,
        last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
        cost,
        limit,
        modalities: { input, output },
      },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    family: existing?.family ?? inferFamily(model.id.split("/").slice(1).join("/"), name),
    release_date: releaseDate,
    last_updated: existing === undefined || changed ? today : (existing.last_updated ?? today),
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: true,
    tool_call: toolCall,
    structured_output: structuredOutput,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}
