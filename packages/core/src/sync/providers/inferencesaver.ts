import { z } from "zod";

import type { SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// ========================================
// Endpoints
// ========================================

// Public pricing + capability catalog (no auth). This is the source of
// truth for the sync: every model InferenceSaver serves, with pricing,
// context window, output limit, and modality capability. A gateway key
// (INFERENCESAVER_API_KEY) is optional and only adds account-scoped
// availability; the public catalog works without it.
const PUBLIC_CATALOG_URL = "https://inferencesaver.com/api/public/models";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Catalog-wide default context/output reported for models whose real limits
// InferenceSaver does not expose. The lab metadata for those models (tiny
// non-token contexts, e.g. gpt-image-2, veo-3.1-generate-preview,
// grok-imagine-video-1.5) is authoritative, so we omit the override and let
// the lab limits inherit.
const FILLER_CONTEXT = 200_000;
const FILLER_OUTPUT = 16_384;

// ========================================
// Schemas
// ========================================

export const InferenceSaverModel = z
  .object({
    rawName: z.string().min(1),
    label: z.string().min(1),
    provider: z.string().optional(),
    family: z.string().optional(),
    tier: z.string().optional(),
    capability: z.string().optional(),
    supportedEndpoints: z.array(z.string()).optional(),
    contextWindow: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    inputPricePerMillionUsd: z.number().optional(),
    outputPricePerMillionUsd: z.number().optional(),
    originalInputPricePerMillionUsd: z.number().optional(),
    originalOutputPricePerMillionUsd: z.number().optional(),
    savingsPercent: z.number().optional(),
    cacheReadPricePerMillionUsd: z.number().optional(),
    cacheWritePricePerMillionUsd: z.number().optional(),
    enableGroups: z.array(z.string()).optional(),
    pricingVersion: z.string().nullish(),
    slug: z.string().optional(),
    route: z.string().optional(),
  })
  .passthrough();

// The public catalog endpoint returns a bare array of models.
export const InferenceSaverResponse = z.array(InferenceSaverModel);

export type InferenceSaverModel = z.infer<typeof InferenceSaverModel>;

// ========================================
// Gateway model id -> models.dev lab model
// ========================================

const BASE_MODELS: Record<string, string> = {
  "claude-fable-5": "anthropic/claude-fable-5",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5-20251001",
  "claude-opus-4-6": "anthropic/claude-opus-4-6",
  "claude-opus-4-7": "anthropic/claude-opus-4-7",
  "claude-opus-4-8": "anthropic/claude-opus-4-8",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "glm-5.2": "zhipuai/glm-5.2",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4-mini": "openai/gpt-5.4-mini",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.5-openai-compact": "openai/gpt-5.5",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "gpt-image-2": "openai/gpt-image-2",
  "grok-4.5": "xai/grok-4.5",
  "grok-imagine-video": "xai/grok-imagine-video-1.5",
  "kimi-k3": "moonshotai/kimi-k3",
  "Nano-Banana": "google/gemini-2.5-flash-image",
  "nano-banana-2": "google/gemini-3.1-flash-image",
  "veo-3.1": "google/veo-3.1-generate-preview",
};

// Reasoning controls required by the strict provider refine when the merged
// base model declares reasoning = true. Each set is copied from the
// underlying model's lab metadata / first-party provider entry (not a
// blanket shape). Claude 4.7+/5/Fable are effort-only (AGENTS forbids budget
// on 4.7+ adaptive); GPT/Gemini/GLM/Kimi/Grok use effort; DeepSeek Flash
// toggles via enable_thinking plus effort.
const REASONING_OPTIONS: Record<string, NonNullable<SyncedFullModel["reasoning_options"]>> = {
  "claude-fable-5": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "claude-haiku-4-5-20251001": [{ type: "budget_tokens", min: 1_024 }],
  "claude-opus-4-6": [
    { type: "effort", values: ["low", "medium", "high", "max"] },
    { type: "budget_tokens", min: 1_024 },
  ],
  "claude-opus-4-7": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "claude-opus-4-8": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "claude-opus-5": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "claude-sonnet-4-6": [
    { type: "effort", values: ["low", "medium", "high", "max"] },
    { type: "budget_tokens", min: 1_024 },
  ],
  "claude-sonnet-5": [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  "deepseek-v4-flash": [
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ],
  "gemini-3.1-pro-preview": [{ type: "effort", values: ["low", "medium", "high"] }],
  "gemini-3.5-flash": [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  "glm-5.2": [{ type: "effort", values: ["high", "max"] }],
  "gpt-5.4": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "gpt-5.4-mini": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "gpt-5.5": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "gpt-5.5-openai-compact": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  "gpt-5.6-luna": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "gpt-5.6-sol": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "gpt-5.6-terra": [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  "grok-4.5": [{ type: "effort", values: ["low", "medium", "high"] }],
  "kimi-k3": [{ type: "effort", values: ["low", "high", "max"] }],
  // google/gemini-3.1-flash-image first-party: effort minimal|high
  "nano-banana-2": [{ type: "effort", values: ["minimal", "high"] }],
};

// Unique-to-InferenceSaver models with no models.dev lab counterpart get a
// full inline definition. Facts the catalog cannot provide are conservative
// defaults; maintainers should review before merging.
const UNIQUE_MODELS: Record<string, { name: string; description: string; family?: string }> = {
  "agnes-2.0-flash": { name: "Agnes 2.0 Flash", description: "Fast general chat model served by InferenceSaver over an OpenAI-compatible API." },
  "agnes-2.5-flash": { name: "Agnes 2.5 Flash", description: "Fast general chat model served by InferenceSaver over an OpenAI-compatible API." },
  "agnes-image-2.1-flash": { name: "Agnes Image 2.1 Flash", description: "Image generation model served by InferenceSaver over an OpenAI-compatible API." },
  "agnes-video-v2.0": { name: "Agnes Video 2.0", description: "Video generation model served by InferenceSaver over an OpenAI-compatible API." },
  "Hunyuan-MT": { name: "Hunyuan MT", description: "Multilingual chat model served by InferenceSaver over an OpenAI-compatible API.", family: "hunyuan" },
  "mimo-v2.5-tts": { name: "MiMo 2.5 TTS", description: "Text-to-speech model served by InferenceSaver over an OpenAI-compatible API.", family: "mimo" },
  "music-2.6": { name: "Music 2.6", description: "Music generation model served by InferenceSaver over an OpenAI-compatible API." },
  "music-2.6-free": { name: "Music 2.6 Free", description: "Music generation model served by InferenceSaver over an OpenAI-compatible API." },
  "music-cover": { name: "Music Cover", description: "Music cover generation model served by InferenceSaver over an OpenAI-compatible API." },
  "music-cover-free": { name: "Music Cover Free", description: "Music cover generation model served by InferenceSaver over an OpenAI-compatible API." },
};

// Capability-derived defaults for host-only models: generation endpoints do
// not expose tool calling, and image/video/audio modalities map to the
// corresponding output type. Limits for generation uniques default to
// non-token (0/0) like same-surface peers (stepfun TTS, chatgpt-image).
const CAPABILITY_MODALITIES: Record<string, { input: Array<"text" | "image" | "video" | "audio">; output: Array<"text" | "image" | "video" | "audio">; tool_call: boolean; attachment: boolean; generation: boolean }> = {
  chat: { input: ["text"], output: ["text"], tool_call: true, attachment: false, generation: false },
  image: { input: ["text"], output: ["image"], tool_call: false, attachment: true, generation: true },
  video: { input: ["text"], output: ["video"], tool_call: false, attachment: false, generation: true },
  audio: { input: ["text"], output: ["audio"], tool_call: false, attachment: false, generation: true },
};

// Round float noise from the catalog (e.g. 0.30000000000000004) to clean
// USD/MTok values.
function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ========================================
// Fetch + translate
// ========================================

export async function fetchInferenceSaverCatalog(
  fetcher: typeof fetch = fetch,
  url = PUBLIC_CATALOG_URL,
) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
  });
  if (!response.ok) {
    throw new Error(`InferenceSaver catalog request failed: ${response.status} ${response.statusText}`);
  }
  return InferenceSaverResponse.parse(await response.json());
}

export function buildInferenceSaverModel(
  model: InferenceSaverModel,
  releaseDate: string,
): SyncedModel {
  const base = BASE_MODELS[model.rawName];
  const capability = model.capability ?? "chat";
  const isGeneration = CAPABILITY_MODALITIES[capability]?.generation ?? false;
  const cost = {
    ...(model.inputPricePerMillionUsd !== undefined
      ? { input: roundPrice(model.inputPricePerMillionUsd) }
      : {}),
    ...(model.outputPricePerMillionUsd !== undefined
      ? { output: roundPrice(model.outputPricePerMillionUsd) }
      : {}),
    ...(model.cacheReadPricePerMillionUsd !== undefined && model.cacheReadPricePerMillionUsd > 0
      ? { cache_read: roundPrice(model.cacheReadPricePerMillionUsd) }
      : {}),
    ...(model.cacheWritePricePerMillionUsd !== undefined && model.cacheWritePricePerMillionUsd > 0
      ? { cache_write: roundPrice(model.cacheWritePricePerMillionUsd) }
      : {}),
  };
  const costOverrides = cost.input !== undefined || cost.output !== undefined ? { cost } : {};

  if (base !== undefined) {
    // The catalog reports 200k context / 16k output as a uniform fallback
    // for many models (image/video generation included). When it matches
    // that filler exactly, the lab metadata is authoritative, so omit the
    // limit override and let the lab limit inherit.
    const isFillerLimit =
      model.contextWindow === FILLER_CONTEXT && model.maxOutputTokens === FILLER_OUTPUT;
    const limit = isFillerLimit
      ? undefined
      : {
          ...(model.contextWindow !== undefined ? { context: model.contextWindow } : {}),
          ...(model.maxOutputTokens !== undefined ? { output: model.maxOutputTokens } : {}),
        };
    return factorBaseModel(
      base,
      {
        ...costOverrides,
        ...(limit !== undefined ? { limit } : {}),
        ...(model.rawName === "gpt-5.5-openai-compact" ? { name: "GPT-5.5 OpenAI Compact" } : {}),
        ...(REASONING_OPTIONS[model.rawName] !== undefined
          ? { reasoning_options: REASONING_OPTIONS[model.rawName] }
          : {}),
      },
      limit,
    );
  }

  const facts = UNIQUE_MODELS[model.rawName];
  if (facts === undefined) {
    throw new Error(`No models.dev definition for ${model.rawName}; add it to BASE_MODELS or UNIQUE_MODELS`);
  }
  const defaults = CAPABILITY_MODALITIES[capability] ?? CAPABILITY_MODALITIES.chat;
  // Chat uniques keep the catalog's limits; generation uniques are
  // non-token endpoints so 0/0 mirrors same-surface peers.
  const limit = defaults.generation
    ? { context: 0, output: 0 }
    : {
        ...(model.contextWindow !== undefined ? { context: model.contextWindow } : {}),
        ...(model.maxOutputTokens !== undefined ? { output: model.maxOutputTokens } : {}),
      };
  return {
    name: facts.name,
    description: facts.description,
    ...(facts.family !== undefined ? { family: facts.family } : {}),
    attachment: defaults.attachment,
    reasoning: false,
    tool_call: defaults.tool_call,
    release_date: releaseDate,
    last_updated: releaseDate,
    open_weights: false,
    ...(Object.keys(cost).length > 0 ? { cost } : {}),
    limit,
    modalities: { input: defaults.input, output: defaults.output },
  } satisfies SyncedFullModel;
}

export const inferencesaver = {
  id: "inferencesaver",
  name: "InferenceSaver",
  modelsDir: "providers/inferencesaver/models",
  deleteMissing: true,
  preserveDescriptions: false,
  sourceID(model) {
    return model.rawName;
  },
  fetchModels() {
    return fetchInferenceSaverCatalog();
  },
  parseModels(raw) {
    return InferenceSaverResponse.parse(raw);
  },
  translateModel(model) {
    const releaseDate = new Date().toISOString().slice(0, 10);
    return { id: model.rawName, model: buildInferenceSaverModel(model, releaseDate) };
  },
} satisfies SyncProvider<InferenceSaverModel>;

