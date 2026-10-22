import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import { readLabModel } from "../../translate.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

// The bare endpoint lists text-output models only; decision models (output
// modality `decisions`) are returned only when requested explicitly.
// https://openrouter.ai/docs/guides/community/jev
const API_ENDPOINT = "https://openrouter.ai/api/v1/models?output_modalities=text,decisions";
// Speech, transcription, embedding, rerank, image and video models are listed only
// when requested by output modality. Image prices come from each model's Images API
// endpoints, video prices from the video models list.
// https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
const MEDIA_API_ENDPOINT = "https://openrouter.ai/api/v1/models?output_modalities=speech,transcription,embeddings,rerank,image,video";
// https://openrouter.ai/docs/guides/overview/multimodal/image-generation#per-endpoint-records
const IMAGE_ENDPOINTS_URL = (id: string) => `https://openrouter.ai/api/v1/images/models/${id}/endpoints`;
// https://openrouter.ai/docs/guides/overview/multimodal/video-generation#via-the-video-models-api
const VIDEO_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/videos/models";
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
  "typesafe/jev-1.13": "typesafe/jev-latest",
  "~typesafe/jev-latest": "typesafe/jev-latest",
} as const;

const DECISION_DESCRIPTION = "Decision model for typed evaluation of shared state";

const OUTPUT_LIMIT_OVERRIDES: Record<string, number> = {
  "minimax/minimax-01": 40_000,
};

const CANONICAL_PROVIDER_PREFIXES = {
  alibaba: { provider: "alibaba", metadata: "alibaba" },
  anthropic: { provider: "anthropic", metadata: "anthropic" },
  "bytedance-seed": { provider: "bytedance-seed", metadata: "bytedance-seed" },
  cohere: { provider: "cohere", metadata: "cohere" },
  deepseek: { provider: "deepseek", metadata: "deepseek" },
  google: { provider: "google", metadata: "google" },
  liquid: { provider: "liquid", metadata: "liquid" },
  meta: { provider: "llama", metadata: "meta" },
  "meta-llama": { provider: "llama", metadata: "meta" },
  minimax: { provider: "minimax", metadata: "minimax" },
  mistralai: { provider: "mistral", metadata: "mistral" },
  "nace-ai": { provider: "nace-ai", metadata: "nace-ai" },
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
  spacexai: { provider: "xai", metadata: "xai" },
  xiaomi: { provider: "xiaomi", metadata: "xiaomi" },
  zai: { provider: "zai", metadata: "zhipuai" },
  "z-ai": { provider: "zai", metadata: "zhipuai" },
  "zai-org": { provider: "zai", metadata: "zhipuai" },
} as const;

/**
 * The first-party provider directory for a metadata lab id.
 *
 * `base_model` ids are spelled with the METADATA lab (`zhipuai/glm-4.7-flash`,
 * `meta/llama-...`) while a lab's own reasoning ladder lives under its
 * PROVIDER directory (`providers/zai`, `providers/llama`). The two coincide for
 * most labs and not for these, and a lookup that assumes they coincide fails
 * silently — the caller falls back to whatever it had, which for a relay means
 * publishing the host's enum as if it were the lab's.
 */
export function providerDirForMetadataLab(metadata: string): string {
  for (const entry of Object.values(CANONICAL_PROVIDER_PREFIXES)) {
    if (entry.metadata === metadata) return entry.provider;
  }
  return metadata;
}

/**
 * The OpenRouter model-directory prefixes that carry a metadata lab, in table
 * order — e.g. `alibaba` lives under both `alibaba/` and `qwen/` on OpenRouter,
 * and only the latter is populated.
 */
export function openrouterDirsForMetadataLab(metadata: string): string[] {
  const dirs: string[] = [];
  for (const [prefix, entry] of Object.entries(CANONICAL_PROVIDER_PREFIXES)) {
    if (entry.metadata === metadata) dirs.push(prefix);
  }
  return dirs.length > 0 ? dirs : [metadata];
}

const OpenRouterImageEndpoint = z.object({
  provider_slug: z.string().optional(),
  supported_parameters: z.record(z.object({ values: z.array(z.string()).optional() }).passthrough()).optional(),
  pricing: z.array(z.object({
    billable: z.string(),
    unit: z.string(),
    cost_usd: z.number(),
    variant: z.string().optional(),
  })),
});

export const OpenRouterImageEndpoints = z.object({
  endpoints: z.array(OpenRouterImageEndpoint),
});

export const OpenRouterVideoModels = z.object({
  data: z.array(z.object({ id: z.string(), pricing_skus: z.record(z.string()).nullable().optional() }).passthrough()),
});

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
  // Passthrough: catalogCost reports price keys it doesn't know.
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    // Per-token image and audio prices (audio is per second on TIME_BILLED_AUDIO models).
    image: z.string().optional(),
    audio: z.string().optional(),
    audio_output: z.string().optional(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    input_cache_write_1h: z.string().optional(),
    image_output: z.string().optional(),
    web_search: z.string().optional(),
    request: z.string().optional(),
    overrides: z.array(z.object({
      min_prompt_tokens: z.number().optional(),
      prompt: z.string().optional(),
      completion: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
      // Time-of-day windows, checked by parseTimeWindow.
      utc_days: z.unknown().optional(),
      utc_start: z.unknown().optional(),
      utc_end: z.unknown().optional(),
    }).passthrough()).optional(),
  }).passthrough(),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
  }),
  supported_parameters: z.array(z.string()),
  // Images API endpoint records, attached by fetchModels for image models.
  image_endpoints: z.array(OpenRouterImageEndpoint).optional(),
  // Video SKU prices from the video models list, attached by fetchModels for video models.
  video_pricing_skus: z.record(z.string()).optional(),
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
    const get = async (url: string) => {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
      }
      return response.json();
    };
    const [text, media, videos] = await Promise.all([
      get(API_ENDPOINT).then((raw) => OpenRouterResponse.parse(raw)),
      get(MEDIA_API_ENDPOINT).then((raw) => OpenRouterResponse.parse(raw)),
      get(VIDEO_MODELS_ENDPOINT).then((raw) => OpenRouterVideoModels.parse(raw)),
    ]);
    const ids = new Set(text.data.map((model) => model.id));
    // Models that also output text (Gemini image models, routers) come from the text list.
    const extra = media.data.filter((model) => !ids.has(model.id) && mediaType(model) !== undefined);
    const skus = new Map(videos.data.map((model) => [model.id, model.pricing_skus ?? undefined]));
    for (const model of extra) {
      if (mediaType(model) === "video") model.video_pricing_skus = skus.get(model.id);
    }
    await Promise.all(extra.filter((model) => mediaType(model) === "image").map(async (model) => {
      model.image_endpoints = OpenRouterImageEndpoints.parse(await get(IMAGE_ENDPOINTS_URL(model.id))).endpoints;
    }));
    return { data: [...text.data, ...extra] };
  },
  parseModels(raw) {
    // Temporarily skip batch routes (`*:batch`) — they are not catalog targets.
    return OpenRouterResponse.parse(raw).data.filter((model) => !model.id.endsWith(":batch"));
  },
  sourceNotices(models) {
    const ids = new Set(models.map((model) => model.id));
    return [...TIME_BILLED_AUDIO]
      .filter((id) => !ids.has(id))
      .map((id) => `${id}: listed in TIME_BILLED_AUDIO but no longer in the OpenRouter catalog`);
  },
  translateModel(model, context) {
    const type = mediaType(model);
    if (type !== undefined) {
      const current = context.v2?.(model.id);
      if (isUnavailableMedia(model)) {
        return current === undefined ? undefined : { id: model.id, v2: current };
      }
      return {
        id: model.id,
        v2: buildOpenRouterMediaModel(model, type, current),
        header: MEDIA_HEADERS[type],
      };
    }
    // OpenRouter serves deprecated/unavailable routes as degraded stubs:
    // negative pricing (`"-1"`) and an empty `supported_parameters` array. Syncing
    // those would wrongly flip `reasoning`/`tool_call`/`structured_output` to false
    // and strip `reasoning_options`. Leave the authored file untouched instead, and
    // skip the model entirely when we have nothing to preserve.
    if (isUnavailable(model)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    const built = buildOpenRouterModel(model, context.existing(model.id));
    // The decision model's first API (systemone) names its own AI SDK package,
    // which v1 reads as the model's provider npm.
    const translated = isDecisionModel(model)
      ? { ...built, provider: { npm: DECISION_APIS.systemone.sdk.aisdk } }
      : built;
    // Without a catalog price the file's cost is kept as is.
    const catalog = price(model.pricing.prompt) === undefined || price(model.pricing.completion) === undefined
      ? undefined
      : catalogV2Set(model, context.v2?.(model.id));
    const api = isDecisionModel(model)
      ? DECISION_APIS
      : "base_model" in built && typeof built.base_model === "string" && rawLabModel(built.base_model)?.type === "image"
        ? IMAGE_CHAT_APIS
        : undefined;
    const v2Set = api === undefined ? catalog?.v2Set : { ...catalog?.v2Set, api: structuredClone(api) };
    return {
      id: model.id,
      model: translated,
      header: translated.reasoning_options?.some((option) => option.type === "toggle")
        ? "# Toggle: reasoning.enabled = true|false\n# https://openrouter.ai/docs/guides/best-practices/reasoning-tokens\n"
        : undefined,
      v2Set,
      notices: catalog?.notices,
    };
  },
} satisfies SyncProvider<OpenRouterModel>;

function isUnavailable(model: OpenRouterModel) {
  return (
    // Decision models take no sampling or tool parameters, so an empty list is normal for them.
    (model.supported_parameters.length === 0 && !isDecisionModel(model)) ||
    Number(model.pricing.prompt) < 0 ||
    Number(model.pricing.completion) < 0
  );
}

function isDecisionModel(model: OpenRouterModel) {
  return model.architecture.output_modalities.includes("decisions");
}

// Decision models answer POST /api/v1/systemone, which OpenCode's openrouter
// entry (experimental.evaluation) and @ai-sdk/typesafe-ai's decisionModel (with
// this baseURL) call, and POST /api/alpha/decisions, which
// the OpenRouter AI SDK provider's evaluationModel calls.
// https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request
// https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
const DECISION_APIS = {
  systemone: { sdk: { aisdk: "@ai-sdk/typesafe-ai", opencodeai: "@opencode/ai/providers/openrouter" } },
  decisions: { base_url: "https://openrouter.ai/api/alpha", sdk: { opencodeai: "none" } },
};
// Chat models whose lab is an image model are also served by the /images router
// (https://openrouter.ai/api/v1/images/models), which answers OpenAI's format.
const IMAGE_CHAT_APIS = {
  "chat-completions": {},
  images: { sdk: { opencodeai: "@opencode/ai/protocols/openai-images" } },
};

// ---------------------------------------------------------------------------
// Speech, transcription, embedding, rerank and image models (v2-only files)
// ---------------------------------------------------------------------------

type MediaType = "speech" | "transcription" | "embedding" | "reranking" | "image" | "video";

const MEDIA_TYPES: Record<string, MediaType> = {
  speech: "speech",
  transcription: "transcription",
  embeddings: "embedding",
  rerank: "reranking",
  image: "image",
  video: "video",
};

const BASE_URL = "https://openrouter.ai/api/v1";

// Each type has its own OpenRouter endpoint. Speech and transcription follow
// OpenAI's audio API ("compatible with the OpenAI SDK"), and the OpenRouter AI
// SDK provider implements embeddings. Rerank takes and returns Cohere's rerank
// shape, so @ai-sdk/cohere works against it. Images also answer OpenAI's
// /images/generations, so OpenCode uses its OpenAI media protocols for images,
// speech and transcription; it has none for video, embeddings or rerank.
// https://openrouter.ai/docs/api/api-reference/tts/create-speech (POST /audio/speech)
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription (POST /audio/transcriptions)
// https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request (POST /embeddings)
// https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request (POST /rerank)
// https://openrouter.ai/docs/guides/overview/multimodal/image-generation (POST /images; the OpenRouter
// AI SDK provider's imageModel)
// https://openrouter.ai/docs/guides/overview/multimodal/video-generation (POST /videos; the OpenRouter
// AI SDK provider's videoModel)
const MEDIA_APIS: Record<MediaType, { protocol: string; aisdk: string; opencodeai: string }> = {
  speech: { protocol: "speech", aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-speech" },
  transcription: {
    protocol: "transcriptions",
    aisdk: "@ai-sdk/openai",
    opencodeai: "@opencode/ai/protocols/openai-transcription",
  },
  embedding: { protocol: "embeddings", aisdk: "@openrouter/ai-sdk-provider", opencodeai: "none" },
  reranking: { protocol: "rerank", aisdk: "@ai-sdk/cohere", opencodeai: "none" },
  image: { protocol: "images", aisdk: "@openrouter/ai-sdk-provider", opencodeai: "@opencode/ai/protocols/openai-images" },
  video: { protocol: "videos", aisdk: "@openrouter/ai-sdk-provider", opencodeai: "none" },
};

const MEDIA_HEADERS: Record<MediaType, string> = {
  speech: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=speech",
    "# Output: response_format mp3 (audio/mpeg) or pcm (audio/pcm). Priced per input character, or",
    "# per second of output audio when only pricing.completion is set, or per token when both are.",
    "# https://openrouter.ai/docs/guides/overview/multimodal/tts",
  ].join("\n"),
  transcription: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=transcription",
    "# Input: wav, mp3, flac, m4a, ogg, webm, aac (\"varies by provider\"). Priced per second of input",
    "# audio, or per token when pricing.completion is set.",
    "# https://openrouter.ai/docs/guides/overview/multimodal/stt",
  ].join("\n"),
  embedding: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=embeddings (prices per token)",
    "# https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request",
  ].join("\n"),
  reranking: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=rerank",
    "# No [cost]: the models API reports \"0\" for priced rerank models (the model pages show per-search",
    "# and per-token prices), so only free routes get a price.",
    "# https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request",
  ].join("\n"),
  image: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=image. Prices are the Images API",
    "# endpoint pricing lines (/api/v1/images/models/{id}/endpoints): per image, per megapixel or per token.",
    "# Resolution and quality tiers are overrides on the first line; a request that omits them is billed at",
    "# the provider's default tier. No [cost] when a price has no CostV2 form (per-request or font fees,",
    "# unlisted or per-job pricing).",
    "# https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
  ].join("\n"),  video: [
    "# Synced from https://openrouter.ai/api/v1/models?output_modalities=video. Prices are the pricing_skus of",
    "# https://openrouter.ai/api/v1/videos/models: per second of output (cents_per_* / 100, duration_seconds_* in USD)",
    "# or per video token (video_tokens_*). SKU qualifiers are overrides on the plain or first SKU: resolution,",
    "# generate_audio (true by default for models with audio), mode (text-to-video, image-to-video, reference-to-video)",
    "# and input_video. No [cost] when a SKU has no CostV2 form (minimum charge per generation, per megapixel-second).",
    "# https://openrouter.ai/docs/guides/overview/multimodal/video-generation",
  ].join("\n"),
};

// MIME types per OpenRouter's docs.
// https://openrouter.ai/docs/guides/overview/multimodal/tts (Output Formats)
// https://openrouter.ai/docs/guides/overview/multimodal/stt (Supported Audio Formats)
// https://openrouter.ai/docs/guides/overview/multimodal/image-understanding (png, jpeg, webp, gif)
// https://openrouter.ai/docs/guides/overview/multimodal/videos (mp4, mpeg, mov, webm)
const SPEECH_OUTPUT = ["audio/mpeg", "audio/pcm"];
const AUDIO_INPUT = ["audio/wav", "audio/mpeg", "audio/flac", "audio/mp4", "audio/ogg", "audio/webm", "audio/aac"];
const MIME_INPUT: Record<string, string[]> = {
  text: ["text"],
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  audio: AUDIO_INPUT,
  video: ["video/mp4", "video/mpeg", "video/quicktime", "video/webm"],
  file: ["application/pdf"],
};

const MEDIA_DESCRIPTIONS: Record<MediaType, string> = {
  speech: "Text-to-speech model",
  transcription: "Speech-to-text model",
  embedding: "Text embedding model",
  reranking: "Reranking model",
  image: "Image generation model",
  video: "Video generation model",
};

// OpenRouter IDs whose lab file has another name. Matching otherwise compares
// slugs without punctuation inside the lab directory (eleven-flash-v2.5 ↔ eleven_flash_v2_5).
const MEDIA_BASE_MODEL_OVERRIDES: Record<string, string> = {
  "cohere/rerank-4-fast": "cohere/rerank-v4.0-fast",
  "cohere/rerank-4-pro": "cohere/rerank-v4.0-pro",
  "fish-audio/s2.1-pro-free:free": "fish-audio/s2.1-pro",
  "mistralai/mistral-embed-2312": "mistral/mistral-embed",
  "mistralai/voxtral-small-24b-2507-stt": "mistral/voxtral-small-24b-2507",
  // OpenRouter serves it as "mistralai/voxtral-mini-transcribe-2602" (endpoints API):
  // Voxtral Mini Transcribe 2, API ID voxtral-mini-2602.
  "mistralai/voxtral-mini-transcribe": "mistral/voxtral-mini-2602",
  // xAI's only TTS model, and its STT slug: grok-voice-transcribe-1.0 reached end
  // of life on 2026-10-02 and is served by 2.0 (https://docs.x.ai/developers/release-notes).
  "x-ai/grok-voice-tts-1.0": "xai/grok-tts",
  "x-ai/grok-stt-1.0": "xai/grok-voice-transcribe-2.0",
  // Krea serves Krea 3 on OpenRouter as K3 Edit (https://www.krea.ai/blog/introducing-krea-3).
  "krea/k3-edit": "krea/krea-3",
  "meta/muse-image": "meta/muse-image-1.0",
  "qwen/qwen-image-3": "alibaba/qwen-image-3.0",
  "qwen/qwen-image-3-pro": "alibaba/qwen-image-3.0-pro",
  // Video models whose lab file uses the lab's API name.
  "alibaba/wan-3.0": "alibaba/wan3.0-video",
  "alibaba/wan-3.0-prime": "alibaba/wan3.0-video-prime",
  "minimax/hailuo-3": "minimax/MiniMax-H3",
  "minimax/hailuo-3-max": "minimax/MiniMax-H3-Max",
  "minimax/hailuo-2.3": "minimax/MiniMax-Hailuo-2.3",
  // Veo 3.1 on Vertex AI; the lab files carry the Gemini API model names.
  "google/veo-3.1": "google/veo-3.1-generate-preview",
  "google/veo-3.1-fast": "google/veo-3.1-fast-generate-preview",
  "google/veo-3.1-lite": "google/veo-3.1-lite-generate-preview",
};

// OpenRouter prefixes of media labs that the chat prefix table doesn't cover. Kept separate so chat
// models under these prefixes don't start resolving to new labs.
const MEDIA_LAB_PREFIXES: Record<string, string> = {
  bytedance: "bytedance-seed",
  kwaivgi: "kuaishou",
};

// Transcription models whose pricing.prompt is per audio hour, not per second.
// Their OpenRouter pages bill "Audio Hours" ("$0.36/hour", "$0.10/hour"), matching
// Microsoft's prices ("$0.10 per hour" for MAI-Transcribe-2):
// https://openrouter.ai/microsoft/mai-transcribe-1.5
// https://openrouter.ai/microsoft/mai-transcribe-2
// https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/mai-transcribe-2-highest-quality-transcription-at-the-fastest-speed-and-lowest-c/4550972
const HOURLY_TRANSCRIPTION = new Set(["microsoft/mai-transcribe-1.5", "microsoft/mai-transcribe-2"]);

// https://openrouter.ai/docs/guides/overview/multimodal/image-generation (output_format)
const IMAGE_OUTPUT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

// Labs whose OpenRouter price lines are a floor: "Pricing is dynamic: cost is finalized per job at
// completion based on billable processing, so it scales with reasoning effort, resolution, and editing
// complexity" (https://openrouter.ai/sourceful/riverflow-v2.5-fast). A 1K Riverflow V2.5 Fast image
// listed at $0.019 was billed $0.0318 (2026-10-20).
const PER_JOB_IMAGE_PRICING = new Set(["sourceful"]);

// Pricing variants that aren't a resolution or quality tier. Seedream 5.0 Pro lists a plain line and
// `high_resolution`: a 1K request was billed the plain $0.045 and a 2K request $0.09 (2026-10-20).
const IMAGE_VARIANT_CONDITIONS: Record<string, Record<string, Record<string, unknown>>> = {
  "bytedance-seed/seedream-5-0-pro": { high_resolution: { resolution: { equals: "2K" } } },
};

const IMAGE_BILLABLES: Record<string, ["text" | "image", "input" | "output"]> = {
  input_text: ["text", "input"],
  input_image: ["image", "input"],
  output_image: ["image", "output"],
};

const IMAGE_UNITS = new Set(["token", "image", "megapixel"]);

// OpenRouter's `resolution` request values spell tiers with a capital K (1K, 1.5K, 2K, 4K); pixel
// heights (768, 720p) stay as they are.
function requestResolution(value: string) {
  return value.endsWith("k") ? `${value.slice(0, -1)}K` : value;
}

// One modality price: per 1M tokens (no unit) or per unit, with its overrides when there are any.
function unitPrice(unit: string, price: number, overrides: Array<{ when: Record<string, unknown>; price: number }>) {
  return {
    ...(unit === "token" ? {} : { unit }),
    price,
    ...(overrides.length > 0 ? { overrides } : {}),
  };
}

// A tier variant as request conditions: `1k`/`1.5k`/`768` are the `resolution` values (1K, 1.5K, 768),
// and `<quality>_<resolution>` adds `quality`.
// https://openrouter.ai/docs/guides/overview/multimodal/image-generation#request-parameters
export function imageVariantCondition(modelID: string, variant: string): Record<string, unknown> | undefined {
  const special = IMAGE_VARIANT_CONDITIONS[modelID]?.[variant];
  if (special !== undefined) return special;
  const resolution = (value: string) =>
    /^\d+(\.\d+)?k$/.test(value) || /^\d+$/.test(value) ? requestResolution(value) : undefined;
  const tier = resolution(variant);
  if (tier !== undefined) return { resolution: { equals: tier } };
  const match = /^(low|medium|high)_(.+)$/.exec(variant);
  const qualityTier = match === null ? undefined : resolution(match[2]!);
  if (match === null || qualityTier === undefined) return undefined;
  return { quality: { equals: match[1] }, resolution: { equals: qualityTier } };
}

// Image prices from the Images API endpoint records. Every line must map to a CostV2 price, or the
// model gets no cost rather than a partial one.
export function imageCost(model: OpenRouterModel) {
  if (PER_JOB_IMAGE_PRICING.has(model.id.split("/")[0]!)) return undefined;
  const endpoints = (model.image_endpoints ?? []).filter((endpoint) => endpoint.pricing.length > 0);
  const lines = endpoints[0]?.pricing;
  if (lines === undefined) return undefined;
  // Several hosts with different prices can't be one price.
  if (endpoints.some((endpoint) => JSON.stringify(endpoint.pricing) !== JSON.stringify(lines))) return undefined;

  const groups = new Map<string, typeof lines>();
  for (const line of lines) groups.set(line.billable, [...(groups.get(line.billable) ?? []), line]);
  const cost: Record<string, Record<string, unknown>> = {};
  for (const billable of Object.keys(IMAGE_BILLABLES)) {
    const group = groups.get(billable);
    if (group === undefined) continue;
    groups.delete(billable);
    const unit = group[0]!.unit;
    if (!IMAGE_UNITS.has(unit) || group.some((line) => line.unit !== unit)) return undefined;
    const value = (usd: number) => unit === "token" ? price(String(usd))! : roundPrice(usd);
    const base = group.find((line) => line.variant === undefined) ?? group[0]!;
    const overrides = [];
    for (const line of group) {
      if (line === base || value(line.cost_usd) === value(base.cost_usd)) continue;
      const when = line.variant === undefined ? undefined : imageVariantCondition(model.id, line.variant);
      if (when === undefined) return undefined;
      overrides.push({ when, price: value(line.cost_usd) });
    }
    const [modality, direction] = IMAGE_BILLABLES[billable]!;
    cost[modality] = {
      ...cost[modality],
      [direction]: unitPrice(unit, value(base.cost_usd), overrides),
    };
  }
  // Reference, font or per-request fees have no CostV2 price.
  return groups.size === 0 ? cost : undefined;
}

type VideoSku = { target: "output" | "image"; unit: "second" | "token" | "image"; price: number; when: Record<string, string | boolean> };

const VIDEO_RESOLUTION = "(480p|720p|768p|1080p|2k|4k)";
const VIDEO_MODES: Record<string, string> = {
  text_to_video_: "text-to-video",
  image_to_video_: "image-to-video",
  reference_: "reference-to-video",
};

function videoResolution(value: string | undefined) {
  return value === undefined ? undefined : requestResolution(value);
}

function videoWhen(entries: Record<string, string | boolean | undefined>) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as Record<string, string | boolean>;
}

// One video SKU as a price and its request conditions, or undefined when it has no CostV2 form
// (minimum_cents_per_generation, cents_per_megapixel_second_*) or an unknown name.
export function parseVideoSku(name: string, value: string): VideoSku | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const cents = roundPrice(amount / 100);
  if (name === "cents_per_image_input") return { target: "image", unit: "image", price: cents, when: {} };
  if (name === "reference_images" || name === "reference_input_images") {
    return { target: "image", unit: "image", price: roundPrice(amount), when: {} };
  }
  let match = new RegExp(`^cents_per_(?:second_output|video_output_second)(?:_${VIDEO_RESOLUTION})?$`).exec(name);
  if (match !== null) {
    return { target: "output", unit: "second", price: cents, when: videoWhen({ resolution: videoResolution(match[1]) }) };
  }
  match = new RegExp(`^cents_per_second_video_continuation(?:_${VIDEO_RESOLUTION})?$`).exec(name);
  if (match !== null) {
    return {
      target: "output",
      unit: "second",
      price: cents,
      when: videoWhen({ resolution: videoResolution(match[1]), input_video: true }),
    };
  }
  match = new RegExp(`^(text_to_video_|image_to_video_|reference_)?duration_seconds(?:_(with|without)_audio)?(?:_${VIDEO_RESOLUTION})?$`).exec(name);
  if (match !== null) {
    return {
      target: "output",
      unit: "second",
      price: roundPrice(amount),
      when: videoWhen({
        resolution: videoResolution(match[3]),
        generate_audio: match[2] === undefined ? undefined : match[2] === "with",
        mode: match[1] === undefined ? undefined : VIDEO_MODES[match[1]],
      }),
    };
  }
  match = new RegExp(`^video_tokens(?:_${VIDEO_RESOLUTION})?(?:_(with_video_input|without_audio))?$`).exec(name);
  if (match !== null) {
    return {
      target: "output",
      unit: "token",
      price: price(value)!,
      when: videoWhen({
        resolution: videoResolution(match[1]),
        input_video: match[2] === "with_video_input" ? true : undefined,
        generate_audio: match[2] === "without_audio" ? false : undefined,
      }),
    };
  }
  return undefined;
}

// Video prices from OpenRouter's pricing SKUs. The plain SKU (else the first) is the base price;
// each other SKU becomes an override on its qualifiers, more specific ones last so they win, and
// SKUs that already price out the same are left out. Any SKU without a CostV2 form drops the cost.
export function videoCost(skus: Record<string, string> | undefined) {
  if (skus === undefined || Object.keys(skus).length === 0) return undefined;
  const parsed: VideoSku[] = [];
  for (const [name, value] of Object.entries(skus)) {
    const sku = parseVideoSku(name, value);
    if (sku === undefined) return undefined;
    parsed.push(sku);
  }
  const images = [...new Set(parsed.filter((sku) => sku.target === "image").map((sku) => sku.price))];
  const outputs = parsed.filter((sku) => sku.target === "output");
  if (images.length > 1 || outputs.length === 0 || new Set(outputs.map((sku) => sku.unit)).size > 1) return undefined;

  const base = outputs.find((sku) => Object.keys(sku.when).length === 0) ?? outputs[0]!;
  const matches = (when: Record<string, unknown>, target: Record<string, unknown>) =>
    Object.entries(when).every(([key, value]) => target[key] === value);
  const applied: VideoSku[] = [];
  const rest = outputs
    .filter((sku) => sku !== base)
    .sort((a, b) => Object.keys(a.when).length - Object.keys(b.when).length);
  for (const sku of rest) {
    const effective = applied.reduce(
      (current, override) => matches(override.when, sku.when) ? override.price : current,
      base.price,
    );
    if (effective !== sku.price) applied.push(sku);
  }
  const overrides = applied.map((sku) => ({
    when: Object.fromEntries(Object.entries(sku.when).map(([key, value]) => [key, { equals: value }])),
    price: sku.price,
  }));
  return {
    ...(images.length === 1 ? { image: { input: unitPrice("image", images[0]!, []) } } : {}),
    video: { output: unitPrice(base.unit, base.price, overrides) },
  };
}

export function mediaType(model: OpenRouterModel): MediaType | undefined {
  const [output, ...rest] = model.architecture.output_modalities;
  return rest.length === 0 && output !== undefined ? MEDIA_TYPES[output] : undefined;
}

// Media models list no sampling parameters, so only a negative price marks an
// unavailable route.
function isUnavailableMedia(model: OpenRouterModel) {
  const { prompt, completion, image, audio } = model.pricing;
  return [prompt, completion, image, audio].some((value) => value !== undefined && Number(value) < 0);
}

export function buildOpenRouterMediaModel(
  model: OpenRouterModel,
  type: MediaType,
  current?: Record<string, unknown>,
): Record<string, unknown> {
  const base = typeof current?.base_model === "string" ? current.base_model : resolveMediaBaseModel(model.id);
  const lab = base === undefined ? undefined : rawLabModel(base);
  const doc: Record<string, unknown> = { schema: 2, v2_only: true };
  const modalities = mediaModalities(model, type);
  const context = model.context_length;
  const api = MEDIA_APIS[type];

  if (base !== undefined && lab !== undefined) {
    doc.base_model = base;
    const labCapabilities = (lab.capabilities ?? {}) as Record<string, unknown>;
    const labContext = (lab.limit as { context?: number } | undefined)?.context;
    // A lab of another type (a chat model served on a transcription endpoint)
    // takes on what the endpoint accepts and returns.
    const route = lab.type === type ? undefined : routeOverrides(type, lab, modalities, context);
    if (route !== undefined) doc.type = type;
    const name = model.name.replace(/^[^:]+:\s+/, "");
    if (
      name !== lab.name &&
      shouldPreserveFactoredName(model.id, base, undefined, MEDIA_BASE_MODEL_OVERRIDES[model.id])
    ) {
      doc.name = name;
    }
    if (current?.status !== undefined) doc.status = current.status;
    // TTS output is always mp3 or pcm on OpenRouter; other types keep the lab's inputs.
    const routeModalities = route?.modalities ?? (type === "speech" ? modalities : undefined);
    if (routeModalities !== undefined && !sameInheritedValue(routeModalities, lab.modalities)) {
      doc.modalities = routeModalities;
    }
    // Hand-authored host capabilities are kept; the route's own win. Either way,
    // only what differs from the lab is written.
    const capabilities = Object.fromEntries(
      Object.entries({ ...(current?.capabilities as Record<string, unknown> | undefined), ...route?.capabilities })
        .filter(([key, value]) => !sameInheritedValue(value, labCapabilities[key])),
    );
    if (Object.keys(capabilities).length > 0) doc.capabilities = capabilities;
    if (route !== undefined) {
      const limit = Object.fromEntries(
        Object.entries(route.limit).filter(([key, value]) => !sameInheritedValue(value, (lab.limit as Record<string, unknown> | undefined)?.[key])),
      );
      if (Object.keys(limit).length > 0) doc.limit = limit;
    } else if ((type === "embedding" || type === "reranking") && context > 0 && context !== labContext) {
      // Only embedding and rerank inputs are token-limited; OpenRouter's context for
      // speech and transcription models is often the chat model's it derives from.
      doc.limit = { context };
    }
  } else {
    doc.type = type;
    doc.name = model.name.replace(/^[^:]+:\s+/, "");
    doc.description = typeof current?.description === "string"
      ? current.description
      : type === "embedding" && modalities.input.length > 1
        ? "Multimodal embedding model"
        : MEDIA_DESCRIPTIONS[type];
    for (const key of ["family", "knowledge"]) {
      if (current?.[key] !== undefined) doc[key] = current[key];
    }
    doc.open_weights = Boolean(model.hugging_face_id);
    // Only for models with no lab file yet; linked files take the lab's date.
    doc.release_date = dateFromTimestamp(model.created);
    if (current?.status !== undefined) doc.status = current.status;
    doc.modalities = modalities;
    doc.capabilities = {
      tools: { supported: false },
      reasoning: { supported: false },
      ...(current?.capabilities as Record<string, unknown> | undefined),
    };
    doc.limit = {
      context,
      output: type === "embedding" || type === "reranking" || type === "image" || type === "video"
        ? 0
        : model.top_provider.max_completion_tokens ?? 0,
    };
  }

  doc.api = {
    [api.protocol]: { base_url: BASE_URL, sdk: { aisdk: api.aisdk, opencodeai: api.opencodeai } },
  };
  const cost = mediaCost(model, type);
  if (cost !== undefined) doc.cost = cost;
  for (const key of ["experimental", "metadata"]) {
    if (current?.[key] !== undefined) doc[key] = current[key];
  }
  return doc;
}

// Request fields per endpoint: transcription takes `temperature`; speech, embeddings
// and rerank take no sampling parameters. None take tools.
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription ("Sampling temperature for transcription")
// https://openrouter.ai/docs/api/api-reference/tts/create-speech
function routeOverrides(
  type: MediaType,
  lab: Record<string, unknown>,
  modalities: { input: string[]; output: string[] },
  context: number,
) {
  const labInput = ((lab.modalities as { input?: string[] } | undefined)?.input ?? []);
  // The audio formats the lab documents for the model, else OpenRouter's STT list.
  const labAudio = labInput.filter((value) => value.startsWith("audio/"));
  return {
    modalities: type === "transcription"
      ? { input: labAudio.length > 0 ? labAudio : AUDIO_INPUT, output: ["text"] }
      : modalities,
    capabilities: {
      tools: { supported: false },
      reasoning: { supported: false },
      temperature: type === "transcription",
      top_p: false,
      top_k: false,
    },
    // OpenRouter's context for the endpoint; 0 where no token limit applies, as in
    // transcription and speech labs.
    limit: { context, output: 0 },
  };
}

function mediaModalities(model: OpenRouterModel, type: MediaType) {
  switch (type) {
    case "speech":
      return { input: ["text"], output: SPEECH_OUTPUT };
    case "transcription":
      return { input: AUDIO_INPUT, output: ["text"] };
    case "embedding":
    case "reranking":
      return {
        input: [...new Set(model.architecture.input_modalities.flatMap((value) => MIME_INPUT[value] ?? []))],
        output: [type],
      };
    case "image": {
      // The endpoint's output_format values, else PNG ("media_type ... including image/png").
      const formats = (model.image_endpoints ?? [])
        .flatMap((endpoint) => endpoint.supported_parameters?.output_format?.values ?? [])
        .map((value) => IMAGE_OUTPUT[value])
        .filter((value): value is string => value !== undefined);
      return {
        input: [...new Set(model.architecture.input_modalities.flatMap((value) => MIME_INPUT[value] ?? []))],
        output: formats.length > 0 ? [...new Set(formats)] : ["image/png"],
      };
    }
    case "video":
      // Jobs download as MP4 (https://openrouter.ai/docs/guides/overview/multimodal/video-generation).
      return {
        input: [...new Set(model.architecture.input_modalities.flatMap((value) => MIME_INPUT[value] ?? []))],
        output: ["video/mp4"],
      };
  }
}

// Prices per CostV2 unit: per 1M tokens or characters, per second otherwise.
export function mediaCost(model: OpenRouterModel, type: MediaType) {
  if (type === "image") return imageCost(model);
  if (type === "video") return videoCost(model.video_pricing_skus);
  const free = model.id.endsWith(":free");
  const prompt = Number(model.pricing.prompt);
  const completion = Number(model.pricing.completion);
  const perMillion = (value: number) => price(String(value))!;
  // A free route has real zero prices; elsewhere "0" means the API has no price.
  if (prompt === 0 && completion === 0 && !free) return undefined;

  switch (type) {
    case "speech":
      // Token-priced speech (Gemini TTS) bills text in and audio out per token.
      if (prompt > 0 && completion > 0) {
        return {
          text: { input: { price: perMillion(prompt) } },
          audio: { output: { price: perMillion(completion) } },
        };
      }
      // "per-second models report their rate under pricing.completion"
      if (completion > 0) return { audio: { output: { unit: "second", price: roundPrice(completion) } } };
      return { text: { input: { unit: "character", price: perMillion(prompt) } } };
    case "transcription": {
      if (completion > 0) {
        return {
          text: { input: { price: perMillion(prompt) }, output: { price: perMillion(completion) } },
          audio: { input: { price: perMillion(prompt) } },
        };
      }
      // "Duration-based ... Priced per second of audio input" (STT guide), except
      // the models OpenRouter prices per audio hour.
      const perSecond = HOURLY_TRANSCRIPTION.has(model.id) ? prompt / 3600 : prompt;
      return { audio: { input: { unit: "second", price: roundPrice(perSecond) } } };
    }
    case "embedding": {
      const cost: Record<string, unknown> = { text: { input: { price: perMillion(prompt) } } };
      for (const modality of ["image", "audio"] as const) {
        const value = Number(model.pricing[modality] ?? 0);
        if (value > 0) cost[modality] = { input: { price: perMillion(value) } };
      }
      return cost;
    }
    case "reranking":
      return { text: { input: { price: perMillion(prompt) } } };
  }
}

function roundPrice(value: number) {
  return Math.round(value * 1e10) / 1e10;
}

export function resolveMediaBaseModel(openrouterID: string) {
  const override = MEDIA_BASE_MODEL_OVERRIDES[openrouterID];
  if (override !== undefined) return override;

  const [prefix, ...modelParts] = openrouterID.split("/");
  if (prefix === undefined || modelParts.length === 0 || prefix.startsWith("~")) return undefined;
  const lab = CANONICAL_PROVIDER_PREFIXES[prefix.toLowerCase() as keyof typeof CANONICAL_PROVIDER_PREFIXES]
    ?.metadata ?? MEDIA_LAB_PREFIXES[prefix.toLowerCase()] ?? prefix.toLowerCase();
  const slug = normalizeModelSlug(modelParts.join("/").replace(/:free$/, ""));
  const matches = [...labFiles(lab)].filter(
    (file) => file.endsWith(".toml") && normalizeModelSlug(file.slice(0, -".toml".length)) === slug,
  );
  return matches.length === 1 ? `${lab}/${matches[0]!.slice(0, -".toml".length)}` : undefined;
}

function rawLabModel(modelID: string) {
  try {
    return Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

// ---------------------------------------------------------------------------
// Chat model prices
// ---------------------------------------------------------------------------

// Where each catalog price goes in a v2 file. Prices are per token in the catalog
// (per 1M in the file). `image` and `image_output` are per token too: OpenRouter's
// model pages show "Image Input: $0.30/M tokens" and "Image Output: $60/M tokens".
// So are the audio prices ("Price in USD per audio input token"), except on the
// models in TIME_BILLED_AUDIO.
// https://openrouter.ai/docs/guides/overview/models#pricing-object
// https://openrouter.ai/docs/api/api-reference/models/get-models
type PriceTarget = {
  section: "text" | "image" | "audio";
  entry: string;
  field: "price" | "reasoning" | "read" | "write";
  ttl?: "1h";
};

const PRICE_TARGETS: Record<string, PriceTarget> = {
  prompt: { section: "text", entry: "input", field: "price" },
  input_cache_read: { section: "text", entry: "input", field: "read" },
  input_cache_write: { section: "text", entry: "input", field: "write" },
  input_cache_write_1h: { section: "text", entry: "input", field: "write", ttl: "1h" },
  completion: { section: "text", entry: "output", field: "price" },
  internal_reasoning: { section: "text", entry: "output", field: "reasoning" },
  image: { section: "image", entry: "input", field: "price" },
  image_output: { section: "image", entry: "output", field: "price" },
  audio: { section: "audio", entry: "input", field: "price" },
  input_audio_cache: { section: "audio", entry: "input", field: "read" },
  audio_output: { section: "audio", entry: "output", field: "price" },
};

// Models whose catalog audio prices are per second of audio, not per token. They
// are written per minute, the unit OpenRouter's model page bills them in.
const TIME_BILLED_AUDIO = new Set([
  // "Input audio is priced at $100 per million seconds" and "Input Audio at
  // $0.006/minute": https://openrouter.ai/mistralai/voxtral-small-24b-2507
  "mistralai/voxtral-small-24b-2507",
]);

// A time-billed catalog audio price (per second) as a price per minute.
function perMinute(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? roundPrice(number * 60) : undefined;
}

// Flat fee per call ("Fixed cost per API request"); v2 costs have no per-call price.
const PER_CALL_PRICES = new Set(["request"]);

// "Cost per web search operation", in USD per search; v2 prices web search per 1,000.
const WEB_SEARCH_PRICE = "web_search";
// Per 1,000 requests by search context size, where the catalog lists them.
const WEB_SEARCH_CONTEXT_PRICES: Record<string, string> = {
  web_search_per_1000_requests_low: "low",
  web_search_per_1000_requests_medium: "medium",
  web_search_per_1000_requests_high: "high",
};

function isPriceKey(key: string) {
  return PRICE_TARGETS[key] !== undefined
    || PER_CALL_PRICES.has(key)
    || key === WEB_SEARCH_PRICE
    || WEB_SEARCH_CONTEXT_PRICES[key] !== undefined;
}

// A catalog web search price as USD per 1,000. Zero stands for no price.
export function webSearchPrice(value: unknown, perSearch: boolean) {
  if (typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.round(number * (perSearch ? 1000 : 1) * 1e6) / 1e6
    : undefined;
}

// Override conditions this module reads. The docs ask consumers to skip entries
// with any other condition.
const CONDITION_KEYS = new Set(["min_prompt_tokens", "utc_days", "utc_start", "utc_end"]);
const TIME_WINDOW_KEYS = ["utc_days", "utc_start", "utc_end"];

type PriceOverride = NonNullable<OpenRouterModel["pricing"]["overrides"]>[number];
type CostEntry = Record<string, any>;
type CostOverride = { when: Record<string, unknown> } & CostEntry;

const UTC_DAYS: Record<string, string> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

function hasReasoning(model: OpenRouterModel) {
  return model.supported_parameters.includes("reasoning") || model.supported_parameters.includes("include_reasoning");
}

function isTimeWindow(override: PriceOverride) {
  return TIME_WINDOW_KEYS.some((key) => key in override);
}

function isContextOnly(override: PriceOverride) {
  return Object.keys(override).every((key) => !CONDITION_KEYS.has(key) || key === "min_prompt_tokens");
}

// A v2 `when` for one override entry, or why it has none.
// https://openrouter.ai/docs/guides/overview/models#pricing-overrides
export function overrideWhen(override: PriceOverride): Record<string, unknown> | string {
  const when: Record<string, unknown> = {};
  if (override.min_prompt_tokens !== undefined) {
    if (!Number.isInteger(override.min_prompt_tokens) || override.min_prompt_tokens < 0) {
      return "min_prompt_tokens is not a token count";
    }
    // "applies when total prompt tokens are strictly greater than this threshold"
    when.context = { gt: override.min_prompt_tokens };
  }
  if (override.utc_days !== undefined) {
    const days = Array.isArray(override.utc_days)
      ? override.utc_days.map((day) => (typeof day === "string" ? UTC_DAYS[day.toLowerCase()] : undefined))
      : [];
    if (days.length === 0 || days.some((day) => day === undefined)) return "utc_days is not a list of weekdays";
    // Evaluated at the request instant, like utc_hours.
    when.utc_days = { in: Object.values(UTC_DAYS).filter((day) => days.includes(day)) };
  }
  if ((override.utc_start === undefined) !== (override.utc_end === undefined)) {
    return "only one of utc_start and utc_end";
  }
  if (override.utc_start !== undefined) {
    const start = utcTime(override.utc_start);
    const end = utcTime(override.utc_end);
    if (start === undefined || end === undefined) return "utc_start or utc_end is not an HHMM time";
    const from = start === "00:00" ? [] : [{ utc_hours: { gte: start } }];
    const until = end === "00:00" ? [] : [{ utc_hours: { lt: end } }];
    // "A window whose end is not after its start wraps past midnight ... t >= start || t < end",
    // so one that ends where it starts is the whole day.
    const hours = end > start
      ? [...from, ...until]
      : end === start ? [] : from.length + until.length === 2 ? [{ any: [...from, ...until] }] : [...from, ...until];
    if (hours.length === 1) Object.assign(when, hours[0]);
    if (hours.length === 2) when.all = hours;
  }
  return when;
}

function utcTime(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  const hours = Math.floor(value / 100);
  const minutes = value % 100;
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// The default and 1h cache write TTLs a file lists, which label the catalog's
// input_cache_write and input_cache_write_1h prices.
function writeTtls(current: Record<string, unknown> | undefined) {
  const cache = (current?.capabilities as { cache?: { explicit?: { ttl?: unknown } } } | undefined)?.cache;
  const ttls = cache?.explicit?.ttl;
  return Array.isArray(ttls) && ttls.length === 2 && ttls[0] !== "1h" && ttls[1] === "1h"
    ? (ttls[0] as string)
    : undefined;
}

/**
 * Every catalog price as v2 cost: the top-level prices and each override entry
 * in catalog order, with its conditions as `when`. v2 overrides merge in order
 * with later ones winning per field, and absent fields inherit the base, as
 * OpenRouter's overrides do. Prices with no exact v2 form get a notice.
 */
export function catalogCost(model: OpenRouterModel, current?: Record<string, unknown>) {
  const has1h = [model.pricing, ...(model.pricing.overrides ?? [])]
    .some((prices) => (prices as Record<string, unknown>).input_cache_write_1h !== undefined);
  const defaultTtl = has1h ? writeTtls(current) : undefined;
  const issues = new Map<string, Set<string>>();
  const note = (reason: string, key: string) => issues.set(reason, (issues.get(reason) ?? new Set()).add(key));

  const prices = (source: Record<string, unknown>, isOverride: boolean) => {
    const cost: Record<string, Record<string, CostEntry>> = {};
    for (const [key, raw] of Object.entries(source)) {
      if (key === "overrides" || (isOverride && CONDITION_KEYS.has(key))) continue;
      if (key === WEB_SEARCH_PRICE || WEB_SEARCH_CONTEXT_PRICES[key] !== undefined) continue;
      const target = PRICE_TARGETS[key];
      if (target === undefined) {
        note(PER_CALL_PRICES.has(key) ? "v2 has no per-call price" : "no known v2 field", key);
        continue;
      }
      if (target.ttl !== undefined && defaultTtl === undefined) {
        note("the file's cache capability doesn't list a default and a 1h TTL", key);
        continue;
      }
      const timeBilled = target.section === "audio" && TIME_BILLED_AUDIO.has(model.id);
      const value = typeof raw !== "string" ? undefined : timeBilled ? perMinute(raw) : price(raw);
      if (value === undefined) {
        note("not a price", key);
        continue;
      }
      const entry = ((cost[target.section] ??= {})[target.entry] ??= {});
      if (timeBilled && !isOverride) entry.unit = "minute";
      if (target.field === "read") (entry.cache ??= {}).read = value;
      else if (target.field === "write" && defaultTtl !== undefined) {
        ((entry.cache ??= {}).write ??= {})[target.ttl ?? defaultTtl] = value;
      } else if (target.field === "write") (entry.cache ??= {}).write = value;
      else entry[target.field] = value;
    }
    // The default TTL leads, as v1 takes the first cache write price.
    const write = cost.text?.input?.cache?.write;
    if (typeof write === "object" && defaultTtl !== undefined && write[defaultTtl] !== undefined) {
      cost.text!.input!.cache.write = { [defaultTtl]: write[defaultTtl], ...write };
    }
    return cost;
  };

  // Web search prices, each with the search context size it applies to (if any).
  const webSearch = (source: Record<string, unknown>) => {
    const keys: Array<[string, string | undefined]> = [
      [WEB_SEARCH_PRICE, undefined],
      ...Object.entries(WEB_SEARCH_CONTEXT_PRICES),
    ];
    const entries: Array<{ size?: string; price: number }> = [];
    for (const [key, size] of keys) {
      const raw = source[key];
      if (raw === undefined) continue;
      const value = webSearchPrice(raw, key === WEB_SEARCH_PRICE);
      if (value !== undefined) entries.push({ size, price: value });
      else if (Number(raw) !== 0) note("not a price", key);
    }
    return entries;
  };
  const sized = (when: Record<string, unknown>, size: string | undefined) =>
    size === undefined ? when : { ...when, search_context_size: { equals: size } };

  const base = prices(model.pricing, false);
  const baseSearch = webSearch(model.pricing);
  // Without a flat price, the base is the medium one (OpenAI's default search context size).
  const searchPrice = baseSearch.find((entry) => entry.size === undefined)?.price
    ?? baseSearch.find((entry) => entry.size === "medium")?.price;
  const searchOverrides: CostOverride[] = baseSearch
    .filter((entry) => entry.size !== undefined)
    .map((entry) => ({ when: sized({}, entry.size), price: entry.price }));
  const overrides: Record<string, CostOverride[]> = {};
  let ownsContext = false;
  for (const override of model.pricing.overrides ?? []) {
    const unknown = Object.keys(override).filter((key) =>
      !CONDITION_KEYS.has(key) && !isPriceKey(key)
    );
    const when = unknown.length > 0 ? `unknown fields ${unknown.join(", ")}` : overrideWhen(override);
    if (typeof when === "string") {
      note(`skipped override ${JSON.stringify(override)}: ${when}`, "overrides");
      continue;
    }
    if (when.context !== undefined && isContextOnly(override)) ownsContext = true;
    for (const [section, entries] of Object.entries(prices(override, true))) {
      for (const [entry, fields] of Object.entries(entries)) {
        if (base[section]?.[entry]?.price === undefined && fields.price === undefined) {
          note(`an override prices ${section}.${entry} with no base price`, "overrides");
          continue;
        }
        (overrides[`${section}.${entry}`] ??= []).push({ when, ...fields });
      }
    }
    const search = webSearch(override);
    if (search.length > 0 && searchPrice === undefined) {
      note("an override prices web_search with no base price", "overrides");
    } else {
      searchOverrides.push(...search.map((entry) => ({ when: sized(when, entry.size), price: entry.price })));
    }
  }
  const webSearchCost = searchPrice === undefined
    ? undefined
    : { price: searchPrice, ...(searchOverrides.length > 0 ? { overrides: searchOverrides } : {}) };

  const section = (name: "image" | "audio") => {
    const entries: Record<string, CostEntry> = Object.fromEntries(
      Object.entries(base[name] ?? {}).map(([entry, fields]) => {
        const list = overrides[`${name}.${entry}`];
        return [entry, { ...fields, ...(list === undefined ? {} : { overrides: list }) }];
      }),
    );
    return Object.keys(entries).length > 0 ? entries : undefined;
  };
  const write = base.text?.input?.cache?.write;
  return {
    reasoning: base.text?.output?.reasoning as number | undefined,
    write: typeof write === "object" ? write as Record<string, number> : undefined,
    overrides: { input: overrides["text.input"] ?? [], output: overrides["text.output"] ?? [] },
    ownsContext,
    image: section("image"),
    audio: section("audio"),
    webSearch: webSearchCost,
    notices: [...issues].map(([reason, keys]) => `${model.id}: ${[...keys].join(", ")} not synced: ${reason}`),
  };
}

// v2 values the v1 patch can't write: the 1h cache write price, override lists,
// image, audio and web search prices, and the reasoning price of a model without
// reasoning (which v1 leaves out). Reasoning tokens are billed whenever the model
// reasons.
function catalogV2Set(model: OpenRouterModel, current: Record<string, unknown> | undefined) {
  const cost = catalogCost(model, current);
  const priced = price(model.pricing.prompt) !== undefined && price(model.pricing.completion) !== undefined;
  return {
    notices: cost.notices,
    v2Set: {
      ...(priced ? { "cost.text.output.reasoning": cost.reasoning } : {}),
      ...(cost.write === undefined ? {} : { "cost.text.input.cache.write": cost.write }),
      "cost.text.input.overrides": withCatalogOverrides(cost.overrides.input, cost.ownsContext),
      "cost.text.output.overrides": withCatalogOverrides(cost.overrides.output, cost.ownsContext),
      "cost.image": cost.image,
      "cost.audio": cost.audio,
      "cost.web_search": cost.webSearch,
    },
  };
}

function usesCondition(when: unknown, keys: string[]): boolean {
  if (Array.isArray(when)) return when.some((item) => usesCondition(item, keys));
  if (!isPlainObject(when)) return false;
  return Object.entries(when).some(([key, value]) =>
    keys.includes(key) || (["all", "any", "not"].includes(key) && usesCondition(value, keys))
  );
}

// The file's overrides with the catalog's in place of the ones it owns: every
// time-of-day override, and context tiers when the catalog lists any (otherwise
// the file's tiers stay, as v1 keeps them).
function withCatalogOverrides(catalog: CostOverride[], ownsContext: boolean) {
  return (current: unknown) => {
    const kept = (Array.isArray(current) ? current : []).filter((item) => {
      const when = (item as { when?: unknown } | null)?.when;
      if (usesCondition(when, ["utc_days", "utc_hours"])) return false;
      return !(ownsContext && isPlainObject(when) && Object.keys(when).length === 1 && "context" in when);
    });
    const next = [...kept, ...catalog];
    return next.length > 0 ? next : undefined;
  };
}

function costTiers(model: OpenRouterModel, existing: ExistingModel | undefined) {
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = hasReasoning(model);
  const tiers = (model.pricing.overrides ?? [])
    .flatMap((o) => {
      if (o.min_prompt_tokens === undefined || isTimeWindow(o) || typeof overrideWhen(o) === "string") return [];
      if (Object.keys(o).some((key) => !CONDITION_KEYS.has(key) && !isPriceKey(key))) return [];
      // Prices an entry leaves out are the base prices.
      const input = price(o.prompt) ?? prompt;
      const output = price(o.completion) ?? completion;
      if (input === undefined || output === undefined) return [];
      return [{
        tier: { type: "context" as const, size: o.min_prompt_tokens },
        input,
        output,
        reasoning: reasoning ? price(o.internal_reasoning as string | undefined) : undefined,
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
  const decision = isDecisionModel(model);
  const type = decision ? "decision" : existing?.type;
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  // Prefer OpenRouter's live reasoning metadata over authored options so aliases
  // and rotated models pick up new efforts/budget support. Fall back to authored
  // only when the API omits a reasoning object.
  const reasoning_options = reasoning
    ? openRouterReasoningOptions(model.reasoning) ?? existing?.reasoning_options
    : undefined;
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
        // v1 audio prices are per token, so time-billed ones stay v2-only.
        ...(TIME_BILLED_AUDIO.has(model.id) ? {} : {
          input_audio: price(model.pricing.audio),
          output_audio: price(model.pricing.audio_output),
        }),
        tiers: costTiers(model, existing),
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    // Decision models evaluate state without generating completion tokens.
    output: decision ? 0 : (OUTPUT_LIMIT_OVERRIDES[model.id]
      ?? model.top_provider.max_completion_tokens
      ?? existing?.limit?.output
      ?? context),
  };
  const canonical = existing?.base_model ?? baseModel ?? resolveCanonicalBaseModel(model.id);

  if (canonical !== undefined) {
    const canonicalOverride = canonicalBaseModelOverride(model.id);
    return factorBaseModel(
      canonical,
      {
        type,
        name: shouldPreserveFactoredName(model.id, canonical, baseModel, canonicalOverride)
          ? name
          : undefined,
        // The lab describes a decision model; don't override it with a generic chat description.
        description: decision ? existing?.description : existing?.description ?? describeModel({
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
        // Decision models list no parameters; inherit these from the lab instead of reporting false.
        temperature: decision ? undefined : params.has("temperature"),
        tool_call: toolCall,
        structured_output: decision ? undefined : structuredOutput,
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
    type,
    name,
    description: existing?.description ?? (decision ? DECISION_DESCRIPTION : describeModel({
      id: model.id,
      name,
      family: familyValue,
      reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: openWeights,
      limit,
      modalities: { input, output },
    })),
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

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function openRouterReasoningOptions(reasoning: OpenRouterModel["reasoning"]): SyncedFullModel["reasoning_options"] {
  if (reasoning === undefined) return undefined;

  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  const efforts = reasoning.supported_efforts === null
    ? ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const
    : reasoning.supported_efforts;

  if (!reasoning.mandatory && !efforts?.includes("none")) {
    options.push({ type: "toggle" });
  }

  if (efforts !== undefined) {
    // OpenRouter lists efforts from max down; v2 files keep them low to high, and
    // the v2 patch compares them in order.
    const values = (reasoning.mandatory ? efforts.filter((value) => value !== "none") : [...efforts])
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    options.push({ type: "effort", values });
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

function labFiles(provider: string) {
  let files = modelMetadataFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(MODELS_DIR, provider)));
    } catch {
      files = new Set();
    }
    modelMetadataFilesByProvider.set(provider, files);
  }
  return files;
}

function matchingModelMetadataFile(provider: string, candidates: string[]) {
  const files = labFiles(provider);
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
    metadata = readLabModel(filePath, modelID);
    modelMetadataByID.set(modelID, metadata);
  }
  return metadata;
}

function canonicalCandidates(provider: string, modelID: string) {
  const candidates = [modelID];
  if (modelID.endsWith("-fast")) candidates.push(modelID.slice(0, -"-fast".length));

  if (provider === "anthropic") {
    for (const candidate of [...candidates]) {
      candidates.push(candidate.replace(/(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2"));
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
