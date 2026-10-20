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
// Speech, transcription, embedding and rerank models are listed only when
// requested by output modality. Image and video models aren't synced yet: their
// prices live in the per-endpoint image API and the video SKU list.
// https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
const MEDIA_API_ENDPOINT = "https://openrouter.ai/api/v1/models?output_modalities=speech,transcription,embeddings,rerank";
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
    // Per-token image and audio input prices (multimodal embeddings).
    image: z.string().optional(),
    audio: z.string().optional(),
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
    const [text, media] = await Promise.all(
      [API_ENDPOINT, MEDIA_API_ENDPOINT].map(async (url) => {
        const response = await fetch(url, { headers });
        if (!response.ok) {
          throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
        }
        return OpenRouterResponse.parse(await response.json());
      }),
    );
    const ids = new Set(text!.data.map((model) => model.id));
    return { data: [...text!.data, ...media!.data.filter((model) => !ids.has(model.id))] };
  },
  parseModels(raw) {
    // Temporarily skip batch routes (`*:batch`) — they are not catalog targets.
    return OpenRouterResponse.parse(raw).data.filter((model) => !model.id.endsWith(":batch"));
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
    const translated = buildOpenRouterModel(model, context.existing(model.id));
    return {
      id: model.id,
      model: translated,
      header: translated.reasoning_options?.some((option) => option.type === "toggle")
        ? "# Toggle: reasoning.enabled = true|false\n# https://openrouter.ai/docs/guides/best-practices/reasoning-tokens\n"
        : undefined,
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

// ---------------------------------------------------------------------------
// Speech, transcription, embedding and rerank models (v2-only files)
// ---------------------------------------------------------------------------

type MediaType = "speech" | "transcription" | "embedding" | "reranking";

const MEDIA_TYPES: Record<string, MediaType> = {
  speech: "speech",
  transcription: "transcription",
  embeddings: "embedding",
  rerank: "reranking",
};

const BASE_URL = "https://openrouter.ai/api/v1";

// Each type has its own OpenRouter endpoint. Speech and transcription follow
// OpenAI's audio API ("compatible with the OpenAI SDK"), and the OpenRouter AI
// SDK provider implements embeddings. No AI SDK package speaks OpenRouter's
// rerank API.
// https://openrouter.ai/docs/api/api-reference/tts/create-speech (POST /audio/speech)
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription (POST /audio/transcriptions)
// https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request (POST /embeddings)
// https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request (POST /rerank)
const MEDIA_APIS: Record<MediaType, { protocol: string; aisdk?: string }> = {
  speech: { protocol: "speech", aisdk: "@ai-sdk/openai" },
  transcription: { protocol: "transcriptions", aisdk: "@ai-sdk/openai" },
  embedding: { protocol: "embeddings", aisdk: "@openrouter/ai-sdk-provider" },
  reranking: { protocol: "rerank" },
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
};

// Transcription models whose pricing.prompt is per audio hour, not per second.
// Their OpenRouter pages bill "Audio Hours" ("$0.36/hour", "$0.10/hour"), matching
// Microsoft's prices ("$0.10 per hour" for MAI-Transcribe-2):
// https://openrouter.ai/microsoft/mai-transcribe-1.5
// https://openrouter.ai/microsoft/mai-transcribe-2
// https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/mai-transcribe-2-highest-quality-transcription-at-the-fastest-speed-and-lowest-c/4550972
const HOURLY_TRANSCRIPTION = new Set(["microsoft/mai-transcribe-1.5", "microsoft/mai-transcribe-2"]);

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
      output: type === "embedding" || type === "reranking"
        ? 0
        : model.top_provider.max_completion_tokens ?? 0,
    };
  }

  doc.api = {
    [api.protocol]: {
      base_url: BASE_URL,
      ...(api.aisdk !== undefined ? { sdk: { aisdk: api.aisdk } } : {}),
    },
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
  }
}

// Prices per CostV2 unit: per 1M tokens or characters, per second otherwise.
export function mediaCost(model: OpenRouterModel, type: MediaType) {
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
    ?.metadata ?? prefix.toLowerCase();
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
