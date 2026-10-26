import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import { providerModelToV2 } from "../../model-file-v2.js";
import { ReasoningOption } from "../../schema.js";
import { roundPrice } from "../../translate.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://ai-gateway.vercel.sh/v1/models";

const OUTPUT_LIMIT_OVERRIDES: Record<string, number> = {
  "alibaba/qwen3.6-27b": 65_536,
  "amazon/nova-2-lite": 65_535,
  "bytedance/seed-1.8": 32_768,
  "deepseek/deepseek-v3.1-terminus": 32_768,
  "inception/mercury-2": 50_000,
  "minimax/minimax-m2": 196_608,
  "quiverai/arrow-2": 65_536,
  "quiverai/arrow-2-telos": 65_536,
  "zai/glm-5-turbo": 131_072,
};

const KnownModelType = z.enum([
  "language",
  "embedding",
  "image",
  "video",
  "reranking",
  "transcription",
  "speech",
  "realtime",
  "evaluation",
]);

const PricingTier = z.object({
  cost: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const Pricing = z.object({
  input: z.string().optional(),
  output: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_tiers: z.array(PricingTier).optional(),
  output_tiers: z.array(PricingTier).optional(),
  input_cache_read_tiers: z.array(PricingTier).optional(),
  input_cache_write_tiers: z.array(PricingTier).optional(),
}).passthrough();

export const VercelModel = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  created: z.number(),
  released: z.number().optional(),
  context_window: z.number().optional().default(0),
  max_tokens: z.number().optional().default(0),
  // Vercel adds new model types without notice ("evaluation" appeared Sep 2026
  // and broke the sync with a ZodError). The trailing z.string() keeps the
  // schema forward-compatible so future types fall through to the default
  // text/text handling in buildVercelModel instead of failing the whole sync.
  type: KnownModelType.or(z.string()),
  tags: z.array(z.string()).optional().default([]),
  supported_parameters: z.array(z.string()).optional().default([]),
  // Keep the catalog parse forward-compatible with new control shapes or
  // effort values; unresolved options retain the authored menu below.
  reasoning_options: z.array(z.unknown()).optional(),
  pricing: Pricing.optional(),
}).passthrough();

const VercelResponse = z.object({
  data: z.array(VercelModel),
}).passthrough();

export type VercelModel = z.infer<typeof VercelModel>;

export const vercel = {
  id: "vercel",
  name: "Vercel AI Gateway",
  modelsDir: "providers/vercel/models",
  preserveSymlinks: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Vercel AI Gateway request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Temporarily skip batch routes (`*-batch`) — they are not catalog targets.
    return VercelResponse.parse(raw).data.filter((model) => !model.id.endsWith("-batch"));
  },
  translateModel(model, context) {
    const mediaType = MEDIA_TYPES[model.type];
    if (mediaType !== undefined) {
      const current = context.v2?.(model.id);
      const v2 = buildVercelMediaModel(model, mediaType, current, context.authored(model.id));
      const cache = vercelCache(model);
      if (cache !== undefined) v2.capabilities = { ...v2.capabilities, cache: cache((current?.capabilities as Doc | undefined)?.cache) };
      return {
        id: model.id,
        v2,
        header: MEDIA_HEADERS[mediaType] + realtimePriceNote(model),
      };
    }
    const existing = context.existing(model.id);
    const routeBase = freeRouteBase(model.id);
    const baseModel = existing?.base_model ?? resolveVercelBaseModel(model.id);
    const inherited = routeBase === undefined ? undefined : context.existing(routeBase);
    const translated = buildVercelModel(
      model,
      existing,
      inherited ?? (baseModel === undefined || baseModel === model.id ? undefined : context.existing(baseModel)),
    );
    const cache = vercelCache(model);
    const type = existing?.type ?? (baseModel === undefined ? undefined : labDoc(baseModel)?.type);
    const v2Set = {
      ...(model.type === "evaluation" ? { api: structuredClone(DECISION_APIS) } : {}),
      ...(model.type === "language" && (type ?? "chat") === "chat"
        ? {
          api: chatApis,
          "capabilities.tools": (current: unknown) =>
            toolChoice(model, existing, baseModel === undefined ? undefined : labToolChoice(baseModel), current),
        }
        : {}),
      ...(cache === undefined ? {} : { "capabilities.cache": cache }),
    };
    return {
      id: model.id,
      model: translated,
      header: translated.reasoning_options?.some((option) => option.type === "toggle")
        ? "# Toggle: reasoning.enabled = true|false\n# https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning\n"
        : undefined,
      ...(Object.keys(v2Set).length > 0 ? { v2Set } : {}),
    };
  },
} satisfies SyncProvider<VercelModel>;

// A tool-calling model that lists `tool_choice` takes "auto", "none", "required"
// and a named function, narrowed to the base model's own `choice` when its lab
// file sets one. A choice equal to the lab's is inherited, not restated.
// https://vercel.com/docs/ai-gateway/inputs-and-tools/tool-use
// https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/tool-calling
function toolChoice(model: VercelModel, existing: ExistingModel | undefined, labChoice: unknown[] | undefined, current: unknown) {
  const { choice: _choice, ...rest } = (current ?? {}) as Doc;
  const tools = existing?.tool_call ?? model.tags.includes("tool-use");
  const choice = ["auto", "none", "required", "tool"].filter((value) => labChoice?.includes(value) ?? true);
  if (!tools || !model.supported_parameters.includes("tool_choice") || sameChoice(choice, labChoice)) {
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...rest, supported: true, choice };
}

function sameChoice(choice: string[], labChoice: unknown[] | undefined) {
  return labChoice !== undefined && choice.length === labChoice.length && choice.every((value) => labChoice.includes(value));
}

// The `tools.choice` a lab file sets for the model on every host.
function labToolChoice(modelID: string) {
  const tools = labDoc(modelID)?.capabilities?.tools;
  return Array.isArray(tools?.choice) ? tools.choice as unknown[] : undefined;
}

// The catalog tags each model `implicit-caching` and/or `explicit-caching`. An
// untagged model with a cache read price caches implicitly, except Anthropic's,
// which only cache with explicit markers. Details a file already has for a kind
// (TTLs, breakpoints) are kept; other untagged models keep whatever the file says.
export function vercelCache(model: Pick<VercelModel, "id" | "tags" | "pricing">) {
  const tagged = model.tags.includes("implicit-caching") || model.tags.includes("explicit-caching");
  const priced = !tagged && model.pricing?.input_cache_read !== undefined;
  const anthropic = model.id.startsWith("anthropic/");
  const implicit = model.tags.includes("implicit-caching") || (priced && !anthropic);
  const explicit = model.tags.includes("explicit-caching") || (priced && anthropic);
  if (!implicit && !explicit) return undefined;
  const kind = (current: unknown) => (current !== null && typeof current === "object" ? current : true);
  return (current: { implicit?: unknown; explicit?: unknown } | false | undefined) => ({
    ...(implicit ? { implicit: kind(current && current.implicit) } : {}),
    ...(explicit ? { explicit: kind(current && current.explicit) } : {}),
  });
}

export function buildVercelModel(
  model: VercelModel,
  existing: ExistingModel | undefined,
  base: ExistingModel | undefined = undefined,
): SyncedModel {
  const tags = new Set(model.tags);
  const releaseDate = model.released
    ? dateFromTimestamp(model.released)
    : existing?.release_date ?? new Date().toISOString().slice(0, 10);
  const context = model.context_window > 0
    ? model.context_window
    : existing?.limit?.context ?? 0;
  const output = OUTPUT_LIMIT_OVERRIDES[model.id] ?? (model.max_tokens > 0
    ? model.max_tokens
    : existing?.limit?.output ?? 0);
  const input = model.id.startsWith("openai/") && context > output
    ? context - output
    : undefined;
  const cost = buildCost(model.pricing, existing?.cost);

  // Self-heal bogus `family = "o"` stamps left by the old substring matcher
  // (e.g. cohere rerank, fish-audio, alibaba wan). Same precedent as OpenRouter.
  const inferredFamily = inferFamily(model.id, model.name);
  const family = existing?.family === "o" && inferredFamily !== "o"
    ? inferredFamily
    : (existing?.family ?? inferredFamily);
  const reasoning = existing?.reasoning ?? tags.has("reasoning");

  const synced: SyncedFullModel = {
    type: model.type === "evaluation" ? "decision" : existing?.type,
    name: existing?.name ?? model.name,
    description: model.type === "evaluation"
      ? existing?.description ?? model.description ?? "Decision model for typed evaluation of shared state"
      : existing?.description ?? describeModel({
      id: model.id,
      name: existing?.name ?? model.name,
      family,
      reasoning,
      tool_call: model.type === "language"
        ? existing?.tool_call ?? tags.has("tool-use")
        : tags.has("tool-use"),
      structured_output: existing?.structured_output,
      open_weights: existing?.open_weights ?? false,
      limit: { context, input, output },
      modalities: {
        input: model.type === "transcription"
          ? ["audio"]
          : model.type === "realtime"
          ? ["text", "audio"]
          : ["text", tags.has("vision") ? "image" : undefined, tags.has("file-input") ? "pdf" : undefined]
            .filter((value): value is "text" | "image" | "pdf" => value !== undefined),
        output: model.type === "speech"
          ? ["audio"]
          : model.type === "realtime"
          ? ["text", "audio"]
          : model.type === "image"
          ? ["image"]
          : model.type === "video"
          ? ["video"]
          : tags.has("image-generation")
          ? ["text", "image"]
          : ["text"],
      },
    }),
    family,
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: existing?.attachment ?? (tags.has("vision") || tags.has("file-input")),
    reasoning,
    reasoning_options: reasoning ? vercelReasoningOptions(model, existing, base) : undefined,
    temperature: existing?.temperature,
    tool_call: model.type === "language"
      ? existing?.tool_call ?? tags.has("tool-use")
      : tags.has("tool-use"),
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    experimental: existing?.experimental,
    provider: model.type === "evaluation" ? DECISION_V1_PROVIDER : existing?.provider,
    cost,
    limit: { context, input, output },
    modalities: {
      input: model.type === "transcription"
        ? ["audio"]
        : model.type === "realtime"
        ? ["text", "audio"]
        : ["text", tags.has("vision") ? "image" : undefined, tags.has("file-input") ? "pdf" : undefined]
          .filter((value): value is "text" | "image" | "pdf" => value !== undefined),
      output: model.type === "speech"
        ? ["audio"]
        : model.type === "realtime"
        ? ["text", "audio"]
        : model.type === "image"
        ? ["image"]
        : model.type === "video"
        ? ["video"]
        : tags.has("image-generation")
        ? ["text", "image"]
        : ["text"],
    },
  };

  const baseModel = existing?.base_model ?? resolveVercelBaseModel(model.id);
  if (baseModel === undefined) return synced;

  return factorBaseModel(baseModel, {
    type: synced.type,
    name: synced.name,
    // The lab describes the decision task; a generic gateway chat description
    // must not override it when the provider file has no curated description.
    description: model.type === "evaluation" && existing?.description === undefined
      ? undefined
      : synced.description,
    attachment: synced.attachment,
    reasoning: synced.reasoning,
    reasoning_options: synced.reasoning_options,
    temperature: synced.temperature,
    tool_call: synced.tool_call,
    structured_output: synced.structured_output,
    status: synced.status,
    interleaved: synced.interleaved,
    experimental: synced.experimental,
    provider: synced.provider,
    cost: synced.cost,
    limit: synced.limit,
    modalities: synced.modalities,
  }, synced.limit, existing?.base_model_omit);
}

function vercelReasoningOptions(
  model: VercelModel,
  existing: ExistingModel | undefined,
  base: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const authored = existing?.reasoning_options?.length
    ? existing.reasoning_options
    : base?.reasoning_options ?? existing?.reasoning_options;
  if (model.reasoning_options === undefined) return authored;
  if (model.reasoning_options.length === 0) return [];

  const parsed = model.reasoning_options.map((option) => ReasoningOption.safeParse(option));
  if (parsed.some((result) => !result.success)) return authored;
  const options = parsed.flatMap((result) => result.success ? [result.data] : []);
  // An effort of "none" already disables reasoning; don't duplicate the off
  // control with the catalog's separate toggle.
  const effortHasNone = options.some((option) => option.type === "effort" && option.values.includes("none"));
  return effortHasNone ? options.filter((option) => option.type !== "toggle") : options;
}

function resolveVercelBaseModel(modelID: string) {
  const routeBase = freeRouteBase(modelID);
  return resolveCanonicalBaseModel(modelID)
    ?? (routeBase === undefined ? undefined : resolveCanonicalBaseModel(routeBase));
}

function freeRouteBase(modelID: string) {
  return modelID.endsWith("-free") ? modelID.slice(0, -"-free".length) : undefined;
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

function tieredPrice(value: string | undefined, tiers: z.infer<typeof PricingTier>[] | undefined) {
  const base = price(value);
  const normalized = (tiers ?? [])
    .map((tier, index, values) => ({
      start: tier.min ?? (index === 0 ? 0 : values[index - 1]?.max ?? 0),
      cost: price(tier.cost),
    }))
    .filter((tier): tier is { start: number; cost: number } => tier.cost !== undefined)
    .sort((a, b) => a.start - b.start);

  return {
    base: normalized[0]?.cost ?? base,
    thresholds: normalized.map((tier) => tier.start).filter((start) => start > 0),
    at(threshold: number) {
      return normalized.findLast((tier) => tier.start <= threshold)?.cost ?? base;
    },
  };
}

function buildCost(pricing: VercelModel["pricing"], existing?: ExistingModel["cost"]) {
  const hasPricingTiers = [
    pricing?.input_tiers,
    pricing?.output_tiers,
    pricing?.input_cache_read_tiers,
    pricing?.input_cache_write_tiers,
  ].some((tiers) => (tiers?.length ?? 0) > 0);
  const inputPrice = tieredPrice(pricing?.input, pricing?.input_tiers);
  const outputPrice = tieredPrice(pricing?.output, pricing?.output_tiers);
  const cacheReadPrice = tieredPrice(pricing?.input_cache_read, pricing?.input_cache_read_tiers);
  const cacheWritePrice = tieredPrice(pricing?.input_cache_write, pricing?.input_cache_write_tiers);
  const input = inputPrice.base;
  const output = outputPrice.base;
  if (input === undefined || output === undefined) return undefined;

  const thresholds = new Set([
    ...inputPrice.thresholds,
    ...outputPrice.thresholds,
    ...cacheReadPrice.thresholds,
    ...cacheWritePrice.thresholds,
  ]);
  const tiers: NonNullable<NonNullable<ExistingModel["cost"]>["tiers"]> = [];
  let previous = {
    input,
    output,
    cache_read: cacheReadPrice.base,
    cache_write: cacheWritePrice.base,
  };
  for (const size of [...thresholds].sort((a, b) => a - b)) {
    const tierInput = inputPrice.at(size);
    const tierOutput = outputPrice.at(size);
    if (tierInput === undefined || tierOutput === undefined) continue;
    const current = {
      input: tierInput,
      output: tierOutput,
      cache_read: cacheReadPrice.at(size),
      cache_write: cacheWritePrice.at(size),
    };
    if (JSON.stringify(current) === JSON.stringify(previous)) continue;
    tiers.push({ tier: { type: "context", size }, ...current });
    previous = current;
  }

  return {
    input,
    output,
    reasoning: existing?.reasoning,
    cache_read: cacheReadPrice.base,
    cache_write: cacheWritePrice.base,
    tiers: hasPricingTiers ? (tiers.length > 0 ? tiers : undefined) : existing?.tiers,
  };
}

function inferFamily(modelID: string, name: string) {
  const kimiFamily = inferKimiFamily(modelID, name);
  if (kimiFamily !== undefined) return kimiFamily;

  // Word-boundary matching like the other gateway syncs. Deliberately no
  // fuzzy/subsequence fallback: matching a family by scattered letters
  // produces false positives (e.g. "typesafe-ai/jev" -> "yi"), and plain
  // substring matching lets single-letter families like "o" match anything
  // containing that letter (e.g. cohere rerank, fish-audio, alibaba wan).
  const target = `${modelID} ${name}`.toLowerCase();
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

// ---------------------------------------------------------------------------
// Image, video, embedding, rerank, speech, transcription and realtime models
// ---------------------------------------------------------------------------

type MediaType = "image" | "video" | "embedding" | "reranking" | "speech" | "transcription" | "realtime";

// Vercel's catalog `type` → ours. `language` and `evaluation` (decision) stay
// on the chat path above.
const MEDIA_TYPES: Record<string, MediaType> = {
  image: "image",
  video: "video",
  embedding: "embedding",
  reranking: "reranking",
  speech: "speech",
  transcription: "transcription",
  realtime: "realtime",
};

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// The provider's npm, @ai-sdk/gateway, calls every model type under this base
// URL: POST /image-model, /video-model, /embedding-model, /reranking-model,
// /speech-model, /transcription-model, and the WebSocket /realtime-model.
// https://vercel.com/docs/ai-gateway/modalities/text-to-speech (REST: /v4/ai/speech-model)
// https://vercel.com/docs/ai-gateway/modalities/speech-to-text (REST: /v4/ai/transcription-model)
// https://vercel.com/docs/ai-gateway/modalities/realtime
const MEDIA_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
const MEDIA_PROTOCOLS: Record<MediaType, string> = {
  image: "images",
  video: "videos",
  embedding: "embeddings",
  reranking: "rerank",
  speech: "speech",
  transcription: "transcriptions",
  realtime: "realtime",
};
// GPT-Live has its own Live endpoint (wss .../v4/ai/live-model), not the
// realtime one, and @ai-sdk/gateway has no Live model:
// https://vercel.com/docs/ai-gateway/modalities/realtime/gpt-live
const LIVE_MODELS = new Set(["openai/gpt-live-1"]);
// The gateway's other endpoints have no standard equivalent:
// POST /v1/audio/speech, /v1/audio/transcriptions and /v1/videos return 404.
const MEDIA_SDK = { opencodeai: "none" };
// Image, embedding and rerank models are also served on the gateway's standard
// endpoints, under the same model IDs: OpenAI's /v1/images/generations (and
// /v1/images/edits), OpenAI's /v1/embeddings and Cohere's /v1/rerank.
// https://vercel.com/docs/ai-gateway/sdks-and-apis
const STANDARD_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const STANDARD_MEDIA_APIS: Partial<Record<MediaType, Doc>> = {
  image: { base_url: STANDARD_BASE_URL, sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-images" } },
  embedding: { base_url: STANDARD_BASE_URL, sdk: { aisdk: "@ai-sdk/openai", opencodeai: "none" } },
  reranking: { base_url: STANDARD_BASE_URL, sdk: { aisdk: "@ai-sdk/cohere", opencodeai: "none" } },
};
// Decision models: POST /v1/decisions, OpenAI's Decisions format, which
// @ai-sdk/openai's decisionModel and OpenCode's openai-decisions protocol
// speak with this baseURL. @ai-sdk/gateway's decisionModel uses its own
// /v4/ai/decision-model endpoint instead.
// https://vercel.com/docs/ai-gateway/modalities/decision
const DECISION_APIS = {
  decisions: {
    base_url: STANDARD_BASE_URL,
    sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-decisions" },
  },
};
// v1 reads the first API as `provider`.
const DECISION_V1_PROVIDER = {
  npm: DECISION_APIS.decisions.sdk.aisdk,
  api: DECISION_APIS.decisions.base_url,
};
const LIVE_SDK = { aisdk: "none", opencodeai: "none" };
// Every language model is also served on the OpenAI Responses and Anthropic
// Messages endpoints, under the same model IDs:
// https://vercel.com/docs/ai-gateway/sdks-and-apis
// https://ai-sdk.dev/providers/ai-sdk-providers/open-responses
const CHAT_EXTRA_APIS = {
  responses: {
    base_url: STANDARD_BASE_URL,
    sdk: { aisdk: "@ai-sdk/open-responses", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/responses" },
  },
  messages: {
    base_url: STANDARD_BASE_URL,
    sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/vercel-ai-gateway/messages" },
  },
};

// A text model's APIs: its default one first (what v1 reads; an empty table
// takes the provider's), then the extra endpoints, keeping their hand-authored
// per-API `capabilities`.
export function chatApis(current: Doc | undefined): Doc {
  const { responses, messages, ...own } = current ?? {};
  const capabilities: Doc = { responses: responses?.capabilities, messages: messages?.capabilities };
  const extra = Object.fromEntries(
    Object.entries(structuredClone(CHAT_EXTRA_APIS)).map(([key, table]) => [
      key,
      capabilities[key] === undefined ? table : { ...table, capabilities: capabilities[key] },
    ]),
  );
  return {
    ...(Object.keys(own).length > 0 ? own : { "chat-completions": {} }),
    ...extra,
  };
}

const MEDIA_HEADERS: Record<MediaType, string> = {
  image: "# Synced from https://ai-gateway.vercel.sh/v1/models (type image)\n# https://vercel.com/docs/ai-gateway/modalities/image-generation\n",
  video: "# Synced from https://ai-gateway.vercel.sh/v1/models (type video)\n# https://vercel.com/docs/ai-gateway/modalities/video-generation\n",
  embedding: "# Synced from https://ai-gateway.vercel.sh/v1/models (type embedding)\n# https://vercel.com/docs/ai-gateway/modalities/embeddings\n",
  reranking: "# Synced from https://ai-gateway.vercel.sh/v1/models (type reranking)\n# https://vercel.com/docs/ai-gateway/modalities/reranking\n",
  speech: "# Synced from https://ai-gateway.vercel.sh/v1/models (type speech)\n# https://vercel.com/docs/ai-gateway/modalities/text-to-speech\n",
  transcription: "# Synced from https://ai-gateway.vercel.sh/v1/models (type transcription)\n# https://vercel.com/docs/ai-gateway/modalities/speech-to-text\n",
  realtime: "# Synced from https://ai-gateway.vercel.sh/v1/models (type realtime)\n# https://vercel.com/docs/ai-gateway/modalities/realtime\n",
};

const MEDIA_DESCRIPTIONS: Record<MediaType, string> = {
  image: "Image model for prompt-driven generation, editing, and visual design workflows",
  video: "Video model for prompt-guided generation, editing, and motion workflows",
  embedding: "Embedding model for semantic search, retrieval, clustering, and ranking pipelines",
  reranking: "Reranking model for improving retrieval quality in search and recommendation systems",
  speech: "Speech generation model for controllable voice, narration, and audio delivery",
  transcription: "Speech transcription model for accurate audio-to-text and captioning workflows",
  realtime: "Realtime voice model for low-latency spoken conversations",
};

// Format names in `video_capabilities.input_limits.*.supported_formats`.
const FORMAT_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

// The realtime endpoint streams base64 PCM16 audio both ways:
// https://vercel.com/docs/ai-gateway/modalities/realtime
const REALTIME_AUDIO = ["audio/pcm"];

const INPUT_KINDS = ["image", "video", "audio", "application/pdf"] as const;

// Request fields each endpoint takes. Image, video, embedding, rerank, speech and
// transcription calls take no tools or sampling parameters; realtime sessions
// take tool definitions ("tools: realtime tool definitions the model can call").
const MEDIA_CAPABILITY_KEYS = ["tools", "reasoning", "temperature", "top_p", "top_k"];

type Doc = Record<string, any>;

export function buildVercelMediaModel(
  model: VercelModel,
  type: MediaType,
  current?: Doc,
  authored?: ExistingModel,
): Doc {
  const base = typeof current?.base_model === "string"
    ? current.base_model
    : authored?.base_model ?? resolveVercelBaseModel(model.id);
  const lab = base === undefined ? undefined : labDoc(base);
  const existing = current ?? (authored === undefined ? undefined : v1ToDoc(authored, lab));
  // New media files are v2-only; files already published in v1 stay there.
  const doc: Doc = existing === undefined || existing.v2_only === true
    ? { schema: 2, v2_only: true }
    : { schema: 2 };
  const route = routeCapabilities(model, type);

  if (base !== undefined && lab !== undefined) {
    doc.base_model = base;
    if (existing?.base_model_omit !== undefined) doc.base_model_omit = existing.base_model_omit;
    const sameType = (lab.type ?? "chat") === type;
    if (!sameType) doc.type = type;
    // Model facts, including the description, stay with the lab. A display name
    // that differs from the lab's is kept: the file's (so published names don't
    // change on resync), or Vercel's for a new file.
    const name = existing === undefined ? model.name : existing.name;
    if (name !== undefined && name !== lab.name) doc.name = name;
    if (existing?.status !== undefined) doc.status = existing.status;
    // A lab of this type keeps its inputs and outputs, so only a host override
    // (with generic kinds made exact from the lab) is kept. A lab of another type
    // takes on what this endpoint accepts and returns.
    const modalities = sameType
      ? existing?.modalities && fixedOutput(type, exactModalities(existing.modalities, lab.modalities))
      : mediaModalities(model, type, existing?.modalities, lab.modalities);
    if (modalities !== undefined && !sameValue(modalities, lab.modalities)) doc.modalities = modalities;
    const capabilities = Object.fromEntries(
      Object.entries(orderedCapabilities({ ...pickCapabilities(existing?.capabilities), ...route }))
        .filter(([key, value]) => !sameValue(value, lab.capabilities?.[key])),
    );
    // Realtime session config has no reasoning control, so a reasoning lab model
    // gets an explicit `supported = true` (no caller control) instead of
    // inheriting the lab's, which leaves v1 without reasoning_options.
    if (type === "realtime" && capabilities.reasoning === undefined && lab.capabilities?.reasoning?.supported === true) {
      capabilities.reasoning = { supported: true };
    }
    if (Object.keys(capabilities).length > 0) doc.capabilities = capabilities;
    const limit = Object.fromEntries(
      Object.entries(mediaLimit(model, type, lab.limit))
        .filter(([key, value]) => value !== lab.limit?.[key]),
    );
    if (Object.keys(limit).length > 0) doc.limit = limit;
  } else {
    doc.type = type;
    doc.name = existing?.name ?? model.name;
    doc.description = existing?.description ?? MEDIA_DESCRIPTIONS[type];
    const family = existing?.family ?? inferFamily(model.id, model.name);
    if (family !== undefined) doc.family = family;
    doc.open_weights = existing?.open_weights ?? model.tags.includes("open-weights");
    if (existing?.knowledge !== undefined) doc.knowledge = existing.knowledge;
    doc.release_date = existing?.release_date ?? (model.released
      ? dateFromTimestamp(model.released)
      : dateFromTimestamp(model.created));
    if (existing?.last_updated !== undefined) doc.last_updated = existing.last_updated;
    if (existing?.status !== undefined) doc.status = existing.status;
    doc.modalities = mediaModalities(model, type, existing?.modalities, undefined);
    doc.capabilities = orderedCapabilities({
      tools: { supported: false },
      reasoning: { supported: false },
      ...pickCapabilities(existing?.capabilities),
      ...route,
    });
    doc.limit = mediaLimit(model, type, undefined, existing?.limit?.context);
  }

  doc.api = LIVE_MODELS.has(model.id)
    ? { live: { base_url: MEDIA_BASE_URL, sdk: { ...LIVE_SDK } } }
    : { [MEDIA_PROTOCOLS[type]]: structuredClone(STANDARD_MEDIA_APIS[type] ?? { base_url: MEDIA_BASE_URL, sdk: MEDIA_SDK }) };
  const { cost, issue } = vercelMediaCost(model, type);
  if (issue !== undefined) console.warn(`Vercel ${model.id}: no cost written, ${issue}`);
  if (cost !== undefined) doc.cost = cost;
  for (const key of ["experimental", "metadata"]) {
    if (existing?.[key] !== undefined) doc[key] = existing[key];
  }
  return doc;
}

// Limits come from Vercel's catalog for the model's type, else the lab's. Embedding
// and rerank calls produce no output tokens, and the catalog's `max_tokens` for
// them only repeats the input window, so their output is the lab's (0 without a
// lab). Chat-path output and input limits in the file are not kept; a standalone
// file keeps its context, an earlier catalog value, when the catalog gives none.
function mediaLimit(
  model: VercelModel,
  type: MediaType,
  lab: { context?: number; output?: number } | undefined,
  context?: number,
) {
  const tokenOutput = type !== "embedding" && type !== "reranking";
  return {
    context: model.context_window > 0 ? model.context_window : lab?.context ?? context ?? 0,
    output: tokenOutput && model.max_tokens > 0 ? model.max_tokens : lab?.output ?? 0,
  };
}

// The caveat for duration-priced realtime sessions, written to new files' leading
// comment (existing comments are kept on resync).
export function realtimePriceNote(model: VercelModel) {
  const pricing = (model.pricing ?? {}) as Record<string, unknown>;
  if (pricing.realtime_session_duration_cost_per_second === undefined) return "";
  const message = pricing.realtime_client_message_cost;
  return message === undefined
    ? "# Price: session duration billed as audio input per second\n"
    : `# Price: session duration billed as audio input per second; $${Number(message)} per client message not represented\n`;
}

function routeCapabilities(model: VercelModel, type: MediaType): Doc {
  if (type === "realtime") {
    const temperature = (model as { temperature?: unknown }).temperature;
    return {
      tools: { supported: true },
      ...(typeof temperature === "boolean" ? { temperature } : {}),
    };
  }
  return {
    tools: { supported: false },
    reasoning: { supported: false },
    temperature: false,
    top_p: false,
    top_k: false,
  };
}

function pickCapabilities(capabilities: Doc | undefined) {
  return Object.fromEntries(
    Object.entries(capabilities ?? {}).filter(([key]) => MEDIA_CAPABILITY_KEYS.includes(key)),
  );
}

function orderedCapabilities(capabilities: Doc) {
  return Object.fromEntries(
    MEDIA_CAPABILITY_KEYS.filter((key) => capabilities[key] !== undefined).map((key) => [key, capabilities[key]]),
  );
}

// Inputs: the catalog's kinds (`modalities.input`, `video_capabilities.input_limits`)
// plus any the file already lists. MIME types per kind come from the catalog's
// `supported_formats`, else the file's exact entries, else the lab's.
function mediaModalities(
  model: VercelModel,
  type: MediaType,
  current: { input?: string[]; output?: string[] } | undefined,
  lab: { input?: string[]; output?: string[] } | undefined,
) {
  const exact = (values: string[] | undefined, kind: string) =>
    (values ?? []).filter((value) => value.includes("/") && (value === kind || value.startsWith(`${kind}/`)));
  const pick = (kind: string, catalog: string[] = [], fallback: string[] = [kind]) => {
    for (const values of [catalog, exact(current?.input, kind), exact(lab?.input, kind)]) {
      if (values.length > 0) return values;
    }
    return fallback;
  };
  const pickOutput = (kind: string, fallback: string[] = [kind]) => {
    for (const values of [exact(current?.output, kind), exact(lab?.output, kind)]) {
      if (values.length > 0) return values;
    }
    return fallback;
  };

  switch (type) {
    case "embedding":
    case "reranking":
    case "image":
    case "video": {
      const limits = videoInputLimits(model);
      const kinds = new Set<string>();
      for (const value of [...((model as { modalities?: { input?: string[] } }).modalities?.input ?? []), ...Object.keys(limits)]) {
        kinds.add(value === "file" ? "application/pdf" : value);
      }
      for (const value of current?.input ?? []) {
        kinds.add(value === "pdf" || value === "application/pdf" ? "application/pdf" : value.split("/")[0]!);
      }
      const input = ["text"];
      for (const kind of INPUT_KINDS) {
        if (!kinds.has(kind)) continue;
        input.push(...(kind === "application/pdf" ? ["application/pdf"] : pick(kind, limits[kind])));
      }
      const output = type === "image"
        ? pickOutput("image")
        : type === "video"
          ? pickOutput("video")
          : [type];
      return { input: [...new Set(input)], output };
    }
    case "speech":
      return { input: ["text"], output: pickOutput("audio") };
    case "transcription":
      return { input: pick("audio"), output: ["text"] };
    case "realtime":
      return {
        input: ["text", ...pick("audio", [], REALTIME_AUDIO)],
        output: ["text", ...pickOutput("audio", REALTIME_AUDIO)],
      };
  }
}

function videoInputLimits(model: VercelModel) {
  const limits = (model as { video_capabilities?: { input_limits?: Record<string, unknown> } | null })
    .video_capabilities?.input_limits ?? {};
  const result: Record<string, string[]> = {};
  for (const [kind, value] of Object.entries(limits)) {
    if (!["image", "video", "audio"].includes(kind) || value === null || typeof value !== "object") continue;
    const formats = (value as { supported_formats?: unknown }).supported_formats;
    result[kind] = Array.isArray(formats)
      ? [...new Set(formats.flatMap((format) => FORMAT_MIME[String(format).toLowerCase()] ?? []))]
      : [];
  }
  return result;
}

// Generic kinds in a host override take the lab's exact types of that kind.
function exactModalities(
  current: { input?: string[]; output?: string[] },
  lab: { input?: string[]; output?: string[] } | undefined,
) {
  const fix = (values: string[] | undefined, labValues: string[] | undefined) => {
    if (values === undefined) return labValues;
    return [...new Set(values.flatMap((value) => {
      if (value.includes("/") || value === "text") return [value];
      const kind = value === "pdf" ? "application/pdf" : value;
      const exact = (labValues ?? []).filter((item) => item === kind || item.startsWith(`${kind}/`));
      return exact.length > 0 ? exact : [kind];
    }))];
  };
  return { input: fix(current.input, lab?.input) ?? [], output: fix(current.output, lab?.output) ?? [] };
}

function fixedOutput(type: MediaType, modalities: { input: string[]; output: string[] }) {
  return type === "embedding" || type === "reranking" ? { ...modalities, output: [type] } : modalities;
}

// A v1 file as the v2 file it stands for, with a base_model override's missing
// modality side taken from the lab.
function v1ToDoc(authored: ExistingModel, lab: Doc | undefined): Doc {
  const modalities = authored.modalities as { input?: string[]; output?: string[] } | undefined;
  const { cost: _cost, attachment: _attachment, ...rest } = authored as Record<string, unknown>;
  return providerModelToV2({
    ...rest,
    modalities: modalities === undefined
      ? undefined
      : { input: modalities.input ?? lab?.modalities?.input, output: modalities.output ?? lab?.modalities?.output },
  });
}

// The lab file as v2 fields (v1 labs are translated).
function labDoc(modelID: string): Doc | undefined {
  let raw: Doc;
  try {
    raw = Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Doc;
  } catch {
    return undefined;
  }
  if (raw.schema === 2) return raw;
  return {
    type: raw.type,
    name: raw.name,
    limit: raw.limit,
    modalities: raw.modalities && {
      input: raw.modalities.input?.map((value: string) => value === "pdf" ? "application/pdf" : value),
      output: raw.modalities.output?.map((value: string) => value === "pdf" ? "application/pdf" : value),
    },
    capabilities: {
      ...(raw.tool_call !== undefined ? { tools: { supported: raw.tool_call } } : {}),
      ...(raw.reasoning !== undefined ? { reasoning: { supported: raw.reasoning } } : {}),
      ...(raw.temperature !== undefined ? { temperature: raw.temperature } : {}),
    },
  };
}

function sameValue(a: unknown, b: unknown) {
  return stableValue(a) === stableValue(b);
}

// Lists of plain values compare as sets, like factored base_model overrides.
function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(stableValue);
    return `[${(value.every((item) => item === null || typeof item !== "object") ? items.sort() : items).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Media prices → CostV2
// ---------------------------------------------------------------------------

// Per-call tool fees (USD per 1,000 calls). Chat routes list them too and no
// model price carries them; they aren't a price of the model's input or output.
const TOOL_FEES = new Set(["web_search", "maps_search"]);
// A flat fee per client message on realtime sessions; CostV2 has no per-message
// unit, so it is left out and the file's leading comment says so.
const UNPRICED_FIELDS = new Set(["realtime_client_message_cost"]);
const PRICE_FIELDS = new Set([
  "input",
  "output",
  "input_cache_read",
  "input_cache_write",
  "audio_input_token_cost",
  "audio_output_token_cost",
  "speech_input_character_cost",
  "transcription_duration_cost_per_second",
  "realtime_session_duration_cost_per_second",
  "image",
  "image_dimension_quality_pricing",
  "video_duration_pricing",
  "video_token_pricing",
  "regional",
]);
// Condition fields of the per-resolution, per-mode price lists, in the order they
// are written. `size` is the image size the request asks for.
const CONDITION_FIELDS: Record<string, string> = {
  resolution: "resolution",
  size: "resolution",
  quality: "quality",
  style: "style",
  mode: "mode",
  audio: "generate_audio",
  voice_control: "voice_control",
  input_video: "input_video",
};

type Conditions = Record<string, string | number | boolean>;
type Priced = { when: Conditions; price: number };

class Unrepresentable extends Error {}

/**
 * Vercel's price fields as CostV2. Token prices are per token (written per 1M),
 * `speech_input_character_cost` per character (per 1M), duration prices per
 * second and `image` per image. When a field has no CostV2 expression, the model
 * gets no cost and `issue` says why.
 */
export function vercelMediaCost(model: VercelModel, type: MediaType): { cost?: Doc; issue?: string } {
  const pricing = (model.pricing ?? {}) as Record<string, unknown>;
  const fields = Object.keys(pricing).filter((key) => !TOOL_FEES.has(key) && !UNPRICED_FIELDS.has(key));
  if (fields.length === 0) return {};
  const unknown = fields.filter((key) => !PRICE_FIELDS.has(key));
  if (unknown.length > 0) return { issue: `no CostV2 field for ${unknown.join(", ")}` };
  try {
    return { cost: mediaCost(pricing, type) };
  } catch (error) {
    if (error instanceof Unrepresentable) return { issue: error.message };
    throw error;
  }
}

function mediaCost(pricing: Record<string, unknown>, type: MediaType): Doc | undefined {
  const value = (key: string) => amount(pricing[key], key);
  const perMillion = (number: number) => Math.round(number * 1_000_000_000_000) / 1_000_000;
  const cost: Doc = {};
  const set = (modality: string, direction: string, entry: Doc) => {
    (cost[modality] ??= {})[direction] = entry;
  };

  let input = value("input");
  const output = value("output");
  const characters = value("speech_input_character_cost");
  const seconds = value("transcription_duration_cost_per_second");
  if (characters !== undefined) {
    // Character-priced speech repeats the same per-character price in `input`.
    if (input !== undefined && input !== characters) {
      throw new Unrepresentable("input differs from speech_input_character_cost");
    }
    set("text", "input", { unit: "character", price: perMillion(characters) });
    input = undefined;
  }
  if (seconds !== undefined) {
    // Next to a duration price, `input` is a nominal placeholder (0 to 0.0000000002
    // per token seen, under $0.001 per 1M); a real token price can't be combined.
    if (input !== undefined && input * 1_000_000 >= 0.001) {
      throw new Unrepresentable("input next to transcription_duration_cost_per_second");
    }
    set("audio", "input", { unit: "second", price: roundPrice(seconds) });
    input = undefined;
  }

  const cacheRead = value("input_cache_read");
  const cacheWrite = value("input_cache_write");
  if (input !== undefined) {
    const cache = {
      ...(cacheRead !== undefined ? { read: perMillion(cacheRead) } : {}),
      ...(cacheWrite !== undefined ? { write: perMillion(cacheWrite) } : {}),
    };
    set("text", "input", { price: perMillion(input), ...(Object.keys(cache).length > 0 ? { cache } : {}) });
  } else if (cacheRead !== undefined || cacheWrite !== undefined) {
    throw new Unrepresentable("cache prices without an input price");
  }
  if (output !== undefined) set("text", "output", { price: perMillion(output) });

  const images = imagePrices(pricing);
  if (images !== undefined) {
    set("image", "output", { unit: "image", ...conditionalPrice(images.entries, images.base) });
  } else if (type === "image" && output !== undefined) {
    // Image models' output tokens are image tokens (`text.output` keeps the v1 pair).
    set("image", "output", { price: perMillion(output) });
  }

  const audioInput = value("audio_input_token_cost");
  if (audioInput !== undefined) set("audio", "input", { price: perMillion(audioInput) });
  // Realtime sessions billed by duration: the session second is priced as a
  // second of audio input.
  const session = value("realtime_session_duration_cost_per_second");
  if (session !== undefined) {
    if (audioInput !== undefined) {
      throw new Unrepresentable("both audio_input_token_cost and realtime_session_duration_cost_per_second");
    }
    set("audio", "input", { unit: "second", price: roundPrice(session) });
  }
  const audioOutput = value("audio_output_token_cost");
  if (audioOutput !== undefined) set("audio", "output", { price: perMillion(audioOutput) });

  const videoSeconds = videoDurationPrices(pricing.video_duration_pricing);
  const videoTokens = videoTokenPrices(pricing.video_token_pricing);
  if (videoSeconds !== undefined && videoTokens !== undefined) {
    throw new Unrepresentable("both video_duration_pricing and video_token_pricing");
  }
  if (videoSeconds !== undefined) set("video", "output", { unit: "second", ...conditionalPrice(videoSeconds) });
  // "Token count includes both input and output video"; written as output.
  if (videoTokens !== undefined) set("video", "output", conditionalPrice(videoTokens));

  regionalPrices(pricing.regional, cost, perMillion);

  const ordered = Object.fromEntries(
    ["text", "image", "audio", "video"].filter((modality) => cost[modality] !== undefined)
      .map((modality) => [modality, cost[modality]]),
  );
  return Object.keys(ordered).length > 0 ? ordered : undefined;
}

function amount(value: unknown, field: string) {
  if (value === undefined) return undefined;
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) throw new Unrepresentable(`${field} is not a price`);
  return number;
}

function conditions(entry: Record<string, unknown>, priceKeys: string[], skip: string[] = []) {
  const when: Conditions = {};
  for (const [key, value] of Object.entries(entry)) {
    if (priceKeys.includes(key) || skip.includes(key)) continue;
    const field = CONDITION_FIELDS[key];
    if (field === undefined || !["string", "number", "boolean"].includes(typeof value)) {
      throw new Unrepresentable(`no CostV2 condition for ${key}`);
    }
    // An image size of "default" is the price when no size is requested.
    if (key === "size" && value === "default") continue;
    when[field] = value as string | number | boolean;
  }
  return Object.fromEntries(
    Object.values(CONDITION_FIELDS)
      .filter((field, index, all) => all.indexOf(field) === index && when[field] !== undefined)
      .map((field) => [field, when[field]!]),
  );
}

// `image` is the per-image price; `image_dimension_quality_pricing` lists prices
// per size, quality or style. `operation: "web-grounding"` entries are a per-call
// grounding fee, like the tool fees above.
function imagePrices(pricing: Record<string, unknown>) {
  const base = amount(pricing.image, "image");
  const list = pricing.image_dimension_quality_pricing;
  if (list !== undefined && !Array.isArray(list)) throw new Unrepresentable("image_dimension_quality_pricing is not a list");
  const entries: Priced[] = [];
  for (const entry of (list ?? []) as Record<string, unknown>[]) {
    if (entry.operation !== undefined) {
      if (entry.operation === "web-grounding") continue;
      throw new Unrepresentable(`no CostV2 field for image operation ${String(entry.operation)}`);
    }
    entries.push({ when: conditions(entry, ["cost"]), price: roundPrice(amount(entry.cost, "image cost")!) });
  }
  if (base === undefined && entries.length === 0) return undefined;
  return { base, entries };
}

function videoDurationPrices(list: unknown) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length === 0) throw new Unrepresentable("video_duration_pricing is not a list");
  return (list as Record<string, unknown>[]).map((entry) => ({
    when: conditions(entry, ["cost_per_second"]),
    price: roundPrice(amount(entry.cost_per_second, "cost_per_second")!),
  }));
}

// Token prices per resolution, reduced when the input contains video.
function videoTokenPrices(value: unknown) {
  if (value === undefined) return undefined;
  const tiers = (value as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Unrepresentable("video_token_pricing has no tiers");
  const entries: Priced[] = [];
  for (const tier of tiers as Record<string, unknown>[]) {
    const when = conditions(tier, ["no_video_input", "with_video_input"]);
    for (const [key, withVideo] of [["no_video_input", false], ["with_video_input", true]] as const) {
      const price = (tier[key] as { cost_per_million_tokens?: unknown } | undefined)?.cost_per_million_tokens;
      if (price === undefined) continue;
      entries.push({
        when: withVideo ? { ...when, input_video: true } : when,
        price: roundPrice(amount(price, "cost_per_million_tokens")!),
      });
    }
  }
  return entries;
}

// One base price plus overrides. The base is the explicit price, else the entry
// without conditions, else the first entry. Overrides are ordered by how many
// conditions they have, so the most specific match is applied last, and entries
// the earlier rules already price are left out.
function conditionalPrice(entries: Priced[], base?: number) {
  const fallback = base === undefined
    ? entries.find((entry) => Object.keys(entry.when).length === 0) ?? entries[0]
    : undefined;
  const price = base ?? fallback!.price;
  const overrides: Priced[] = [];
  const rest = entries
    .filter((entry) => entry !== fallback)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Object.keys(a.entry.when).length - Object.keys(b.entry.when).length || a.index - b.index)
    .map(({ entry }) => entry);
  for (const entry of rest) {
    const current = overrides.reduce(
      (value, override) =>
        Object.entries(override.when).every(([key, item]) => entry.when[key] === item) ? override.price : value,
      price,
    );
    if (current === entry.price) continue;
    overrides.push(entry);
  }
  return {
    price,
    ...(overrides.length > 0
      ? {
          overrides: overrides.map((override) => ({
            when: Object.fromEntries(Object.entries(override.when).map(([key, item]) => [key, { equals: item }])),
            price: override.price,
          })),
        }
      : {}),
  };
}

// Regional token prices that differ from the global ones become region overrides.
function regionalPrices(regional: unknown, cost: Doc, perMillion: (value: number) => number) {
  if (regional === undefined) return;
  if (regional === null || typeof regional !== "object") throw new Unrepresentable("regional is not an object");
  for (const [region, prices] of Object.entries(regional as Record<string, Record<string, unknown>>)) {
    for (const [key, raw] of Object.entries(prices ?? {})) {
      const direction = key === "input" ? "input" : key === "output" ? "output" : undefined;
      const entry = cost.text?.[direction ?? ""];
      if (direction === undefined || entry === undefined || entry.unit !== undefined) {
        throw new Unrepresentable(`no CostV2 field for regional ${key}`);
      }
      const price = perMillion(amount(raw, `regional ${key}`)!);
      if (price === entry.price) continue;
      (entry.overrides ??= []).push({ when: { region: { equals: region } }, price });
    }
  }
}
