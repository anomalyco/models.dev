import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AuthoredModelShape, ReasoningOption } from "../../schema.js";
import type { CostV2, CostWhenV2 } from "../../schema-v2.js";
import { readLabModel } from "../../translate.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { schemaToolChoice, toolsWith } from "./cloudflare-workers-ai.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PROVIDER_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "providers",
  "cloudflare-ai-gateway",
);
const MODELS_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const CURATION_PATH = path.join(PROVIDER_DIR, "curation.toml");
const TEXT_GENERATION = "Text Generation";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CATALOG_PAGES = 1_000;
const MAX_BACKOFF_DELAY_MS = 8_000;
const MAX_RETRY_DELAY_MS = 60_000;

// OpenAI and Anthropic models use their own SDK and API on the gateway's native
// routes. The gateway's OpenCode entry point serves those routes too.
// Their base URLs are the gateway's provider-native routes, not the SDKs' defaults:
// https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
// https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
const NATIVE_BASE = "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}";
const NATIVE_API: Record<string, { npm: string; api: string; protocol: string }> = {
  anthropic: { npm: "@ai-sdk/anthropic", api: `${NATIVE_BASE}/anthropic/v1`, protocol: "messages" },
  openai: { npm: "@ai-sdk/openai", api: `${NATIVE_BASE}/openai`, protocol: "responses" },
};
const OPENCODE_PACKAGE = "@opencode/ai/providers/cloudflare-ai-gateway";

// The REST API also serves POST /ai/v1/chat/completions, /ai/v1/responses and
// /ai/v1/messages; the catalog's request_formats lists the ones each model takes.
// https://developers.cloudflare.com/ai-gateway/usage/rest-api/
// The gateway's OpenCode entry point has no per-API entry points yet, so every
// table names the main one.
const REST_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1";
const REST_APIS: Record<string, { protocol: string; aisdk: string }> = {
  "chat-completions": { protocol: "chat-completions", aisdk: "@ai-sdk/openai-compatible" },
  responses: { protocol: "responses", aisdk: "@ai-sdk/openai" },
  "anthropic-messages": { protocol: "messages", aisdk: "@ai-sdk/anthropic" },
};

// A text model's APIs: its first table (what v1 reads: the native route for OpenAI
// and Anthropic, else the provider's default), then a REST table for every other
// format the catalog lists.
// `apiTools` (the lab's per-API tool fields, see `splitLabTools`) replaces each
// table's tool fields when given.
export function gatewayApis(
  current: unknown,
  nativeProtocol: string | undefined,
  requestFormats: unknown,
  apiTools?: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const tables = isRecord(current) ? current : {};
  const [firstKey, firstValue] = Object.entries(tables)[0] ?? [nativeProtocol ?? "chat-completions", {}];
  const first = isRecord(firstValue) ? firstValue : {};
  const { opencodeai: _opencodeai, ...sdk } = isRecord(first.sdk) ? first.sdk : {};
  const api: Record<string, unknown> = {
    [firstKey]: firstKey === nativeProtocol ? { ...first, sdk: { ...sdk, opencodeai: OPENCODE_PACKAGE } } : first,
  };
  for (const format of Array.isArray(requestFormats) ? requestFormats : []) {
    const rest = typeof format === "string" ? REST_APIS[format] : undefined;
    if (rest === undefined || rest.protocol in api) continue;
    api[rest.protocol] = { base_url: REST_BASE_URL, sdk: { aisdk: rest.aisdk, opencodeai: OPENCODE_PACKAGE } };
  }
  if (Object.keys(tables).length === 0 && nativeProtocol === undefined && Object.keys(api).length === 1) return undefined;
  if (apiTools === undefined) return api;
  return Object.fromEntries(
    Object.entries(api).map(([protocol, table]) => [protocol, withTableTools(table as Record<string, unknown>, apiTools[protocol] ?? {})]),
  );
}

function withTableTools(table: Record<string, unknown>, fields: Record<string, unknown>) {
  const { tools, ...capabilities } = isRecord(table.capabilities) ? table.capabilities : {};
  const kept = Object.entries(isRecord(tools) ? tools : {}).filter(([key]) => !TOOL_FIELDS.includes(key));
  const nextTools = { ...fields, ...Object.fromEntries(kept) };
  const next = { ...capabilities, ...(Object.keys(nextTools).length > 0 ? { tools: nextTools } : {}) };
  const { capabilities: _capabilities, ...rest } = table;
  return Object.keys(next).length > 0 ? { ...rest, capabilities: next } : rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const Price = z.number().nonnegative();
const ProviderDetail = z.object({
  id: z.string().min(1),
  pricing: z.record(Price),
}).passthrough();

const CatalogEntry = z.object({
  model_id: z.string().refine(isSafeModelID, "model_id must be a safe relative provider/model path"),
  task: z.string(),
  context_length: z.number().int().positive().nullish(),
  provider_details: z.array(ProviderDetail).nullish(),
  request_formats: z.array(z.string()).nullish(),
}).passthrough();
// Some proxied rows (e.g. reflection-ai/beam-1.0-501b-a23b at launch) ship with
// provider_details = null. Those need a curated cost; see catalogCost.
const CatalogModel = CatalogEntry.extend({
  task: z.literal(TEXT_GENERATION),
  context_length: z.number().int().positive().nullish(),
  provider_details: z.array(ProviderDetail).length(1).nullish(),
});

export type MediaType = "speech" | "transcription" | "image" | "video";

// Non-text catalog tasks synced as v2-only files, by the model type each one serves.
const MEDIA_TASKS: Record<string, MediaType> = {
  "Text-to-Speech": "speech",
  "Automatic Speech Recognition": "transcription",
  "Text-to-Image": "image",
  "Image-to-Image": "image",
  "Text-to-Video": "video",
  "Image-to-Video": "video",
  "video-to-video": "video",
};
// Catalog tasks left out on purpose. Music generation has no model type in the schema;
// Image-to-Document returns a JSON layer document; `websocket` is a realtime voice
// session billed per total audio minute and per text message, which no cost unit
// expresses.
const UNSYNCED_TASKS = new Set([
  "Image-to-Document",
  "Music Generation",
  "websocket",
]);

const MediaCatalogModel = CatalogEntry.extend({
  task: z.string().refine((task) => MEDIA_TASKS[task] !== undefined, "task must be a synced media task"),
  name: z.string().min(1).optional(),
  provider_details: z.array(ProviderDetail).length(1).nullish(),
});

const FlatPricing = z.object({
  input_tokens: Price,
  output_tokens: Price,
  input_cached_tokens: Price.optional(),
  input_cache_creation_tokens: Price.optional(),
}).strict();

const ContextPricing = z.object({
  long_context_threshold_tokens: Price.int().positive(),
  short_context_input_tokens: Price,
  short_context_output_tokens: Price,
  short_context_input_cached_tokens: Price.optional(),
  short_context_input_cache_creation_tokens: Price.optional(),
  long_context_input_tokens: Price,
  long_context_output_tokens: Price,
  long_context_input_cached_tokens: Price.optional(),
  long_context_input_cache_creation_tokens: Price.optional(),
}).strict();

const Tier200kPricing = z.object({
  under_200k_per_1m_input_tokens: Price,
  under_200k_per_1m_output_tokens: Price,
  under_200k_per_1m_input_cached_tokens: Price.optional(),
  over_200k_per_1m_input_tokens: Price,
  over_200k_per_1m_output_tokens: Price,
  over_200k_per_1m_input_cached_tokens: Price.optional(),
}).strict();

const Tier512kPricing = z.object({
  under_512k_per_1m_input_tokens: Price,
  under_512k_per_1m_output_tokens: Price,
  under_512k_per_1m_input_cached_tokens: Price.optional(),
  over_512k_per_1m_input_tokens: Price,
  over_512k_per_1m_output_tokens: Price,
  over_512k_per_1m_input_cached_tokens: Price.optional(),
}).strict();

const CloudflareResponse = z.object({
  success: z.literal(true),
  result: z.array(CatalogEntry),
  result_info: z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total_count: z.number().int().nonnegative(),
    total_pages: z.number().int().positive().optional(),
    count: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

const SourceModel = z.object({
  catalog: z.union([CatalogModel, MediaCatalogModel]),
  schemaInput: z.unknown().optional(),
});

const NoteLines = z.array(z.string().refine((value) => !/[\r\n]/.test(value)));

const CuratedModel = z.object({
  base_model: z.string().refine(isSafeModelID, "base_model must be a safe relative provider/model path").optional(),
  structured_output: z.boolean().optional(),
  // Only for rows without structured provider_details; see catalogCost.
  cost: AuthoredModelShape.shape.cost,
  reasoning_options: z.array(ReasoningOption).optional(),
  limit: z.object({
    context: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  }).strict().optional(),
  interleaved: z.union([
    z.literal(true),
    z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
  ]).optional(),
  // Media models only: what the /ai/run route accepts and returns, when its request
  // schema doesn't list it (e.g. a TTS model with no output format field).
  modalities: z.object({
    input: z.array(z.string().min(1)).min(1),
    output: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  // Image and video models only: which output modality a bare `output_tokens` price
  // bills (Gemini image models bill image tokens there, OpenAI's text tokens).
  output_tokens: z.enum(["text", "image", "video"]).optional(),
  note: NoteLines.optional(),
}).strict();

const Curation = z.object({
  skip: z.array(z.string()).default([]),
  // Leading comment lines for every model whose id starts with the key (route and
  // source notes shared by a family), written before the model's own note.
  prefix_notes: z.record(NoteLines).default({}),
  models: z.record(CuratedModel).default({}),
}).strict();

type CatalogModel = z.infer<typeof CatalogModel>;
type MediaCatalogModel = z.infer<typeof MediaCatalogModel>;
type CatalogEntry = z.infer<typeof CatalogEntry>;
type SourceModel = z.infer<typeof SourceModel>;
type CuratedModel = z.infer<typeof CuratedModel>;

const curation = Curation.parse(Bun.TOML.parse(readFileSync(CURATION_PATH, "utf8")));
const skippedModels = new Set(curation.skip);

export const cloudflareAiGateway = {
  id: "cloudflare-ai-gateway",
  name: "Cloudflare AI Gateway",
  modelsDir: "providers/cloudflare-ai-gateway/models",
  preserveDescriptions: false,
  authoritativeHeaders: true,
  sourceID(source) {
    return source.catalog.model_id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} new catalog models were not created because they have no lab file and no curated base_model; map or skip them in curation.toml.`,
      `Skipped catalog IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const catalog = CatalogEntry.array().parse(await loadCatalog());
    const catalogIDs = new Set(catalog.map((model) => model.model_id));
    if (catalogIDs.size !== catalog.length) {
      throw new Error("Cloudflare AI Gateway catalog returned duplicate model IDs");
    }
    const textModels = catalog.filter((model) => model.task === TEXT_GENERATION);
    if (textModels.length === 0) {
      throw new Error("Cloudflare AI Gateway catalog returned no Text Generation models");
    }

    const eligible = (model: CatalogEntry) => !model.model_id.startsWith("@cf/") && !skippedModels.has(model.model_id);
    const emittedModels = textModels.filter(eligible).map((model) => {
      const parsed = CatalogModel.safeParse(model);
      if (!parsed.success) throw new Error(`${model.model_id}: invalid catalog entry: ${parsed.error.message}`);
      return parsed.data;
    });
    if (emittedModels.length === 0) {
      throw new Error("Cloudflare AI Gateway catalog returned no eligible proxied models");
    }
    const mediaModels = catalog.filter((model) => MEDIA_TASKS[model.task] !== undefined);
    const emittedMedia = mediaModels.filter(eligible).map((model) => {
      const parsed = MediaCatalogModel.safeParse(model);
      if (!parsed.success) throw new Error(`${model.model_id}: invalid catalog entry: ${parsed.error.message}`);
      return parsed.data;
    });
    for (const task of new Set(catalog.map((model) => model.task))) {
      if (task !== TEXT_GENERATION && MEDIA_TASKS[task] === undefined && !UNSYNCED_TASKS.has(task)) {
        console.warn(`warning: unknown Cloudflare AI Gateway catalog task: ${task}`);
      }
    }
    const sources = await mapLimit([...emittedModels, ...emittedMedia], 6, async (model) => ({
      catalog: model,
      schemaInput: await loadCatalogSchemaInput(model.model_id),
    }));

    const liveIDs = new Set([...textModels, ...mediaModels].map((model) => model.model_id));
    for (const id of Object.keys(curation.models)) {
      if (!liveIDs.has(id)) console.warn(`warning: curation id not in live feed: ${id}`);
    }

    return sources;
  },
  parseModels(raw) {
    return SourceModel.array().parse(raw);
  },
  translateModel(source, context) {
    const id = source.catalog.model_id;
    const curated = curation.models[id] ?? {};
    const isText = source.catalog.task === TEXT_GENERATION;
    // A new model with no lab file is reported in the PR instead of failing
    // the whole sync; an existing file still fails loudly if its lab is gone.
    const base = curated.base_model ?? (isText ? resolveBaseModel(id) : resolveMediaBaseModel(id));
    if (base === undefined && context.authored(id) === undefined) return undefined;
    if (!isText) {
      const catalog = source.catalog as MediaCatalogModel;
      const type = MEDIA_TASKS[catalog.task]!;
      const { doc, unpriced } = buildCloudflareAiGatewayMediaModel(catalog, source.schemaInput, curated);
      if (unpriced !== undefined) console.warn(`warning: ${id}: no [cost], catalog pricing can't be expressed: ${unpriced.join(", ")}`);
      return {
        id,
        v2: doc,
        header: noteHeader([
          ...MEDIA_NOTES[type],
          ...(unpriced === undefined ? [] : [`No [cost]: catalog pricing keys ${unpriced.join(", ")} have no cost unit or condition to express them.`]),
          ...curated.note ?? [],
        ]),
      };
    }
    const native = NATIVE_API[id.split("/")[0]!];
    // Decision models are listed under Text Generation but only answer on POST /ai/run.
    const decision = base !== undefined && labType(base) === "decision";
    const tools = !decision && base !== undefined && baseToolCall(base);
    const lab = tools && native ? firstPartyTools(base) : undefined;
    const labTools = lab && native && splitLabTools(lab, Object.keys(gatewayApis(undefined, native.protocol, source.catalog.request_formats) ?? {}));
    return {
      id,
      model: buildCloudflareAiGatewayModel(
        source.catalog as CatalogModel,
        source.schemaInput,
        curated,
        context.authored(id),
      ),
      header: noteHeader([...prefixNotes(id), ...curated.note ?? []]),
      v2Set: {
        api: decision
          ? () => DECISION_RUN_API
          : (current: unknown) => gatewayApis(current, native?.protocol, source.catalog.request_formats, labTools?.apis),
        ...(tools
          ? { "capabilities.tools": (current: unknown) => gatewayTools(current, labTools?.top, source.schemaInput) }
          : {}),
      },
    };
  },
} satisfies SyncProvider<SourceModel>;

export function buildCloudflareAiGatewayModel(
  catalog: CatalogModel,
  schemaInput: unknown,
  curated: CuratedModel = {},
  existing?: ExistingModel,
): SyncedBaseModel {
  const id = catalog.model_id;
  // Pricing failures must not be hidden by missing reasoning controls.
  const cost = catalogCost(catalog, curated);
  const baseModel = curated.base_model ?? resolveBaseModel(id);
  if (baseModel === undefined) {
    throw new Error(`${id}: no lab file and no curated base_model; add it to skip or map it`);
  }

  const model: SyncedBaseModel = { base_model: baseModel };
  if (curated.structured_output !== undefined) {
    model.structured_output = curated.structured_output;
  }
  if (curated.interleaved !== undefined) model.interleaved = curated.interleaved;

  if (baseReasoning(baseModel)) {
    const derived = deriveReasoningOptions(schemaInput);
    const reasoningOptions = curated.reasoning_options ?? (derived.length > 0 ? derived : undefined);
    if (reasoningOptions === undefined) {
      throw new MissingReasoningOptionsError(
        id,
        `base ${baseModel} reasons but the catalog schema and curation provide no reasoning_options`,
      );
    }
    model.reasoning_options = reasoningOptions;
  }

  model.cost = cost;

  const limit = {
    ...(catalog.context_length == null && existing?.limit?.context === undefined
      ? {}
      : { context: catalog.context_length ?? existing?.limit?.context }),
    ...curated.limit,
  };
  if (Object.keys(limit).length > 0) model.limit = limit;

  const native = NATIVE_API[id.split("/")[0]!];
  if (native !== undefined) model.provider = { npm: native.npm, api: native.api };
  return model;
}

// ---------------------------------------------------------------------------
// Speech, transcription, image and video models (v2-only files)
// ---------------------------------------------------------------------------

// Third-party media models run on the REST API's universal endpoint: POST
// `{base_url}/run` with `{ model, input }`, where `input` follows the model's catalog
// schema. Generated media comes back as a URL (or a data URI), transcripts as text.
// Decision models (TypeSafe Jev) take a System One body as `input` and answer in a run
// record: `{ result: { state: "Completed", result: { answers, usage } } }`.
// @opencode/ai speaks /ai/run for decision models only, through its
// cloudflare-ai-gateway/decisions entry, which posts to the full Run URL (Workers AI
// tables put it all in base_url). v1 publishes base_url, so `/run` goes in path.
// Media models have no OpenCode package.
const RUN_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai";
const RUN_API = {
  "workers-ai-run": { base_url: RUN_BASE_URL, sdk: { opencodeai: "none" } },
};
const DECISION_RUN_API = {
  "workers-ai-run": {
    base_url: RUN_BASE_URL,
    path: "/run",
    sdk: { opencodeai: "@opencode/ai/providers/cloudflare-ai-gateway/decisions" },
  },
};

const MEDIA_NOTES: Record<MediaType, string[]> = {
  speech: [
    "Route: REST POST /ai/run with { model, input }; input per GET /ai/catalog/models/{id}/schema. https://developers.cloudflare.com/ai-gateway/usage/rest-api/",
    "Output: the schema's output format enum (output_format, response_format or format), else the lab's or the note below. Prices: catalog provider_details, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).",
  ],
  transcription: [
    "Route: REST POST /ai/run with { model, input }; input per GET /ai/catalog/models/{id}/schema. https://developers.cloudflare.com/ai-gateway/usage/rest-api/",
    "Input: the formats the schema's file field documents, else the lab's. Prices: catalog provider_details, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).",
  ],
  image: [
    "Route: REST POST /ai/run with { model, input }; input per GET /ai/catalog/models/{id}/schema. https://developers.cloudflare.com/ai-gateway/usage/rest-api/",
    "Modalities: the schema's prompt/image fields (the lab's MIME types) and output_format enum, else the lab's outputs. Prices: catalog provider_details, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).",
  ],
  video: [
    "Route: REST POST /ai/run with { model, input }; input per GET /ai/catalog/models/{id}/schema. https://developers.cloudflare.com/ai-gateway/usage/rest-api/",
    "Modalities: the schema's prompt/image/video/audio fields (the lab's MIME types) and output_format enum, else the lab's video outputs. Prices: catalog provider_details per second of output video, USD, passed through with no markup (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).",
  ],
};

const IMAGE_FORMATS: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const VIDEO_FORMATS: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
// Request fields that carry each input kind in the catalog's image and video schemas.
const TEXT_FIELD = /^(prompt|instruction|structured_instruction|voice_script)$/;
const IMAGE_FIELD = /^(image|images|image_input|image_uri|image_urls|input_image|input_images|person_image|garment_images|reference_images|prompt_images|image_style_references|start_image|end_image|first_frame_image|last_frame_image)$/;
const VIDEO_FIELD = /^(video|video_uri|input_video|reference_video|reference_videos)$/;
const AUDIO_FIELD = /^(audio|reference_audio|reference_audios)$/;

// Format names in the request schemas → MIME candidates. The lab's spelling wins when
// it lists one of them (Ogg Opus is audio/ogg for some labs, audio/opus for others).
const AUDIO_FORMATS: Record<string, string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  mpeg: ["audio/mpeg"],
  mpga: ["audio/mpeg"],
  opus: ["audio/opus", "audio/ogg"],
  ogg: ["audio/ogg"],
  wav: ["audio/wav"],
  aac: ["audio/aac"],
  flac: ["audio/flac"],
  mp4: ["audio/mp4"],
  m4a: ["audio/mp4"],
  webm: ["audio/webm"],
  mkv: ["audio/x-matroska"],
  pcm: ["audio/pcm", "audio/l16"],
  mulaw: ["audio/basic", "audio/mulaw", "audio/pcmu"],
  ulaw: ["audio/basic", "audio/mulaw", "audio/pcmu"],
  alaw: ["audio/alaw", "audio/pcma"],
};

type LabFile = {
  type?: string;
  name?: string;
  modalities?: { input: string[]; output: string[] };
  capabilities?: { tools?: { supported?: boolean }; reasoning?: { supported?: boolean } };
};

export function buildCloudflareAiGatewayMediaModel(
  catalog: MediaCatalogModel,
  schemaInput: unknown,
  curated: CuratedModel = {},
): { doc: Record<string, unknown>; unpriced?: string[] } {
  const id = catalog.model_id;
  const type = MEDIA_TASKS[catalog.task]!;
  const base = curated.base_model ?? resolveMediaBaseModel(id);
  if (base === undefined) {
    throw new Error(`${id}: no lab file and no curated base_model; add it to skip or map it`);
  }
  const lab = Bun.TOML.parse(readFileSync(path.join(MODELS_ROOT, `${base}.toml`), "utf8")) as LabFile;
  if ((lab.type ?? "chat") !== type) {
    throw new Error(`${id}: lab ${base} is a ${lab.type ?? "chat"} model, not ${type}; map it to a ${type} lab`);
  }

  const doc: Record<string, unknown> = { schema: 2, v2_only: true, base_model: base };
  // Cloudflare's name for an alias, unless it's just the lab's name with a vendor prefix
  // ("MiniMax Hailuo 2.3" for "Hailuo 2.3").
  if (
    catalog.name !== undefined
    && !normalizeSlug(catalog.name).endsWith(normalizeSlug(lab.name ?? ""))
    && normalizeSlug(id.split("/").slice(1).join("/")) !== normalizeSlug(base.split("/").slice(1).join("/"))
  ) {
    doc.name = catalog.name;
  }
  const modalities = curated.modalities ?? routeModalities(type, schemaInput, lab);
  if (modalities !== undefined && !sameModalities(modalities, lab.modalities)) doc.modalities = modalities;
  // The /ai/run input schema has no tools field and no reasoning control: a model that
  // reasons does so with no caller control (an empty reasoning_options in v1).
  const capabilities: Record<string, unknown> = {};
  if (lab.capabilities?.tools?.supported === true) capabilities.tools = { supported: false };
  if (lab.capabilities?.reasoning?.supported === true) capabilities.reasoning = { supported: true };
  if (Object.keys(capabilities).length > 0) doc.capabilities = capabilities;
  doc.api = RUN_API;

  const pricing = catalog.provider_details?.[0]?.pricing;
  if (pricing === undefined) return { doc, unpriced: ["(no provider_details)"] };
  const { cost, unpriced } = mediaCost(pricing, type, curated.output_tokens, schemaInput);
  if (cost !== undefined) doc.cost = cost;
  return { doc, unpriced };
}

// What the route accepts and returns, read from the model's request schema. Undefined
// when the schema doesn't say, so the lab's modalities apply.
export function routeModalities(
  type: MediaType,
  schemaInput: unknown,
  lab: LabFile,
): { input: string[]; output: string[] } | undefined {
  const properties = schemaProperties(schemaInput);
  const labInput = lab.modalities?.input ?? [];
  const labOutput = lab.modalities?.output ?? [];
  if (type === "image" || type === "video") {
    const fields = Object.keys(properties);
    if (fields.length === 0) return undefined;
    const kinds = [
      ["image", IMAGE_FIELD],
      ["video", VIDEO_FIELD],
      ["audio", AUDIO_FIELD],
    ] as const;
    const input = [
      ...(fields.some((field) => TEXT_FIELD.test(field)) ? ["text"] : []),
      ...kinds.flatMap(([kind, pattern]) => {
        if (!fields.some((field) => pattern.test(field))) return [];
        const mimes = labInput.filter((mime) => mime.startsWith(`${kind}/`));
        if (mimes.length === 0) throw new Error(`the route takes ${kind} input but the lab lists no ${kind} MIME types; curate modalities`);
        return mimes;
      }),
    ];
    const formats = enumValues(properties.output_format);
    const table = type === "image" ? IMAGE_FORMATS : VIDEO_FORMATS;
    const output = formats === undefined
      ? labOutput.filter((mime) => mime.startsWith(`${type}/`))
      : [...new Set(formats.map((format) => {
          const mime = table[format.toLowerCase()];
          if (mime === undefined) throw new Error(`unknown ${type} output format "${format}"; add it to ${type === "image" ? "IMAGE" : "VIDEO"}_FORMATS`);
          return mime;
        }))];
    if (input.length === 0 || output.length === 0) return undefined;
    return { input, output };
  }
  if (type === "speech") {
    const field = properties.output_format ?? properties.response_format ?? properties.format;
    const codec = schemaProperties(field).codec;
    const values = enumValues(codec) ?? enumValues(field);
    if (values === undefined) return undefined;
    const output = audioMimes(values.map((value) => value.split("_")[0]!).filter((value) => value !== "auto"), labOutput, "output format");
    return { input: ["text"], output };
  }

  const file = (properties.file ?? properties.audio_url) as { description?: unknown } | undefined;
  const description = typeof file?.description === "string" ? file.description : "";
  const listed = /Supported (?:container )?formats: ([^.]+)\./i.exec(description)?.[1];
  if (listed === undefined) return undefined;
  const raw = /Raw formats \(([^)]+)\)/i.exec(description)?.[1];
  const formats = [listed, raw].filter((value) => value !== undefined).flatMap((value) => value.split(","));
  const audio = audioMimes(formats.map((value) => value.trim().toLowerCase()), labInput, "input format");
  return {
    input: [...(labInput.includes("text") && properties.prompt !== undefined ? ["text"] : []), ...audio],
    output: ["text"],
  };
}

function audioMimes(formats: string[], labMimes: string[], label: string) {
  const mimes = formats.map((format) => {
    const candidates = AUDIO_FORMATS[format];
    if (candidates === undefined) throw new Error(`unknown audio ${label} "${format}"; add it to AUDIO_FORMATS`);
    return candidates.find((mime) => labMimes.includes(mime)) ?? candidates[0]!;
  });
  return [...new Set(mimes)];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") return {};
  const properties = (schema as { properties?: unknown }).properties;
  return properties !== null && typeof properties === "object" ? properties as Record<string, unknown> : {};
}

function enumValues(schema: unknown) {
  const parsed = z.object({ enum: z.array(z.string()).min(1) }).passthrough().safeParse(schema);
  return parsed.success ? parsed.data.enum : undefined;
}

function sameModalities(a: { input: string[]; output: string[] }, b: LabFile["modalities"]) {
  const key = (values: string[] | undefined) => JSON.stringify([...values ?? []].sort());
  return b !== undefined && key(a.input) === key(b.input) && key(a.output) === key(b.output);
}

// Per-feature transcription surcharges, added to the base per-minute price when the
// request sets the field. Keyed by the catalog's `input_audio_minutes_<feature>` suffix.
// AssemblyAI sells these as add-on features on top of the model's hourly rate
// (https://www.assemblyai.com/pricing: keyterms $0.05/hr, diarization $0.02/hr, medical
// $0.15/hr, the catalog's per-minute values), so they stack.
const ADDITIVE_MINUTE_PRICES: Record<string, CostWhenV2> = {
  speaker_diarization: { speaker_labels: { equals: true } },
  keyterms: { keyterms_prompt: { min_items: 1 } },
  medical: { domain: { equals: "medical-v1" } },
};
// Per-mode transcription prices that replace the base price.
const MODE_MINUTE_PRICES: Record<string, CostWhenV2> = {
  streaming: { websocket: { equals: true } },
};

type PriceEntry = { unit?: string; price?: number; cache?: { read?: number; write?: number }; reasoning?: number; overrides?: Array<Record<string, unknown>> };

// Maps a catalog provider_details pricing object to a v2 cost. Token prices are already
// per 1M tokens; character prices are per character; video prices are per second of
// output. Every key must map, or no cost is written and the keys are returned, so no
// price is dropped silently.
export function mediaCost(
  pricing: Record<string, number>,
  type: MediaType = "speech",
  bareOutputTokens?: "text" | "image" | "video",
  schemaInput?: unknown,
): { cost?: CostV2; unpriced?: string[] } {
  const sides: Record<string, PriceEntry> = {};
  const side = (modality: string, direction: "input" | "output") => (sides[`${modality}.${direction}`] ??= {});
  const unpriced: string[] = [];
  const additive: Array<[CostWhenV2, number]> = [];
  const modes: Array<[CostWhenV2, number]> = [];
  const imageSizes: Array<[string, number]> = [];
  const megapixelBuckets: Array<[number, number, string]> = [];
  const megapixels: Record<string, number> = {};
  const videoOverrides: Array<{ when: CostWhenV2[]; price: number; key: string }> = [];
  const set = (entry: PriceEntry, unit: string | undefined, value: number, key: string) => {
    if (entry.price !== undefined || (entry.unit !== undefined && entry.unit !== unit)) return unpriced.push(key);
    if (unit !== undefined) entry.unit = unit;
    entry.price = value;
  };
  const resolution = requestValue(schemaInput, ["resolution", "quality"]);

  for (const [key, value] of Object.entries(pricing)) {
    const minuteFeature = /^input_audio_minutes_(\w+)$/.exec(key)?.[1];
    const token = /^(input|output)_(?:(cached|cache_creation)_)?(?:(text|audio|image|video|reasoning)_)?tokens$/.exec(key);
    const size = /^output_size_(\w+)$/.exec(key)?.[1];
    const bucket = /^mp_(\d+)_(\d+)$/.exec(key);
    const clip = type === "video"
      ? /^(\d+p|\d+k)(?:_(\d+)s)?(?:_(audio|draft|video_in|non_video_in))?$/.exec(key)
      : null;
    if (key === "input_characters") {
      set(side("text", "input"), "character", perMillion(value), key);
    } else if (key === "input_audio_minutes") {
      set(side("audio", "input"), "minute", value, key);
    } else if (minuteFeature !== undefined && ADDITIVE_MINUTE_PRICES[minuteFeature] !== undefined) {
      additive.push([ADDITIVE_MINUTE_PRICES[minuteFeature]!, value]);
    } else if (minuteFeature !== undefined && MODE_MINUTE_PRICES[minuteFeature] !== undefined) {
      modes.push([MODE_MINUTE_PRICES[minuteFeature]!, value]);
    } else if (key === "output_image_count") {
      set(side("image", "output"), "image", value, key);
    } else if (key === "input_image_count") {
      set(side("image", "input"), "image", value, key);
    } else if (size !== undefined) {
      imageSizes.push([size, value]);
    } else if (bucket !== null) {
      megapixelBuckets.push([Number(bucket[1]), value, key]);
    } else if (key === "first_output_megapixel" || key === "subsequent_output_megapixel") {
      megapixels[key] = value;
    } else if (key === "input_megapixel") {
      set(side("image", "input"), "megapixel", value, key);
    } else if (type === "video" && key === "default") {
      set(side("video", "output"), "second", value, key);
    } else if (clip !== null) {
      const [, res, seconds, flag] = clip;
      const when: CostWhenV2[] = [{ resolution: { equals: resolution(res!) } }];
      if (seconds !== undefined) when.push({ duration: { equals: Number(seconds) } });
      if (flag === "audio") when.push({ generate_audio: { equals: true } });
      // A silent price next to an audio one applies only when audio is turned off, so an
      // unset flag (audio is often on by default) never gets the cheaper rate.
      if (flag === undefined && pricing[`${key}_audio`] !== undefined) when.push({ generate_audio: { equals: false } });
      if (flag === "draft") when.push({ mode: { equals: "draft" } });
      if (flag === "video_in" || flag === "non_video_in") when.push({ input_video: { equals: flag === "video_in" } });
      // Clip prices for a fixed length become a per-second price for that length.
      videoOverrides.push({ when, price: seconds === undefined ? value : roundPrice(value / Number(seconds)), key });
    } else if (token !== null) {
      const [, direction, cache, rawModality] = token as unknown as [string, "input" | "output", string | undefined, string | undefined];
      const reasoning = rawModality === "reasoning";
      // A bare output_tokens price on an image or video model may bill text or media
      // tokens, depending on the lab, so it needs curation.
      const modality = reasoning
        ? "text"
        : rawModality ?? (direction === "output" && (type === "image" || type === "video") ? bareOutputTokens : "text");
      if (modality === undefined) {
        unpriced.push(key);
        continue;
      }
      const entry = side(modality, direction);
      if (entry.unit !== undefined) {
        unpriced.push(key);
      } else if (direction === "output" && reasoning && cache === undefined) {
        entry.reasoning = value;
      } else if (direction === "input" && !reasoning && cache !== undefined) {
        entry.cache = { ...entry.cache, [cache === "cached" ? "read" : "write"]: value };
      } else if (!reasoning && cache === undefined) {
        set(entry, undefined, value, key);
      } else {
        unpriced.push(key);
      }
    } else {
      unpriced.push(key);
    }
  }

  const minutes = sides["audio.input"];
  if (additive.length > 0 || modes.length > 0) {
    if (minutes?.unit !== "minute" || minutes.price === undefined) {
      unpriced.push(...Object.keys(pricing).filter((key) => key.startsWith("input_audio_minutes_")));
    } else {
      minutes.overrides = [
        ...modes.map(([when, price]) => ({ when, price })),
        // Surcharges add up, so every combination of features gets its own total.
        ...subsets(additive).map((features) => ({
          when: features.length === 1 ? features[0]![0] : { all: features.map(([when]) => when) },
          price: roundPrice(minutes.price! + features.reduce((sum, [, price]) => sum + price, 0)),
        })),
      ];
    }
  }

  // A flat per-megapixel price; a first megapixel priced apart from the rest has no unit.
  const { first_output_megapixel: first, subsequent_output_megapixel: subsequent } = megapixels;
  if (first !== undefined && subsequent !== undefined && first === subsequent) {
    set(side("image", "output"), "megapixel", first, "first_output_megapixel");
  } else {
    unpriced.push(...Object.keys(megapixels));
  }

  const images = sides["image.output"];
  if (imageSizes.length > 0) {
    if (images?.unit !== "image" || images.price === undefined) {
      unpriced.push(...imageSizes.map(([size]) => `output_size_${size}`));
    } else {
      const resolutionOf = requestValue(schemaInput, ["resolution", "size", "image_size"]);
      images.overrides = imageSizes
        .filter(([, price]) => price !== images.price)
        .map(([size, price]) => ({ when: { resolution: { equals: resolutionOf(size) } }, price }));
      if (images.overrides.length === 0) delete images.overrides;
    }
  }
  if (megapixelBuckets.length > 0) {
    // Per-image prices by output size: the smallest band is the base price.
    const sorted = [...megapixelBuckets].sort(([a], [b]) => a - b);
    const entry = side("image", "output");
    if (entry.price !== undefined) {
      unpriced.push(...sorted.map(([, , key]) => key));
    } else {
      entry.unit = "image";
      entry.price = sorted[0]![1];
      entry.overrides = sorted.slice(1).map(([from, price]) => ({ when: { megapixels: { gte: from } }, price }));
    }
  }

  const video = sides["video.output"];
  if (videoOverrides.length > 0) {
    if (video?.unit !== "second" || video.price === undefined) {
      unpriced.push(...videoOverrides.map(({ key }) => key));
    } else {
      // Broader conditions first, so the most specific matching override wins. An override
      // at the base price is dropped unless a broader one it narrows would apply instead.
      const key = (condition: CostWhenV2) => JSON.stringify(condition);
      const sorted = [...videoOverrides].sort((a, b) => a.when.length - b.when.length);
      const kept = sorted.filter((override) => override.price !== video.price || sorted.some((other) =>
        other !== override
        && other.when.length < override.when.length
        && other.price !== video.price
        && other.when.every((condition) => override.when.some((own) => key(own) === key(condition)))));
      if (kept.length > 0) {
        video.overrides = kept.map(({ when, price }) => ({ when: when.length === 1 ? when[0]! : { all: when }, price }));
      }
    }
  }

  for (const [name, entry] of Object.entries(sides)) {
    if (entry.price === undefined) unpriced.push(...Object.keys(pricing).filter((key) => keyTargets(key, name)));
  }
  if (unpriced.length > 0) return { unpriced: [...new Set(unpriced)] };

  const cost: Record<string, Record<string, PriceEntry>> = {};
  for (const modality of ["text", "image", "audio", "video"]) {
    for (const direction of ["input", "output"] as const) {
      const entry = sides[`${modality}.${direction}`];
      if (entry === undefined) continue;
      const { unit, price, cache, reasoning, overrides } = entry;
      (cost[modality] ??= {})[direction] = {
        ...(unit === undefined ? {} : { unit }),
        price,
        ...(cache === undefined ? {} : { cache }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(overrides === undefined ? {} : { overrides }),
      };
    }
  }
  return { cost: cost as CostV2 };
}

// The request's own spelling of a catalog pricing label (720p → "720P"), from the
// first listed field whose enum has it; otherwise the label itself.
function requestValue(schemaInput: unknown, fields: string[]) {
  const properties = schemaProperties(schemaInput);
  return (label: string) => {
    for (const field of fields) {
      const match = enumValues(properties[field])?.find((value) => value.toLowerCase() === label.toLowerCase());
      if (match !== undefined) return match;
    }
    return label;
  };
}

function keyTargets(key: string, side: string) {
  const [modality, direction] = side.split(".");
  return key.startsWith(`${direction}_`) && (modality === "text" ? !/_(audio|image|video)_/.test(key) : key.includes(`_${modality}_`));
}

// Non-empty subsets, smallest first, keeping the input order within each.
function subsets<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let mask = 1; mask < 1 << items.length; mask++) {
    result.push(items.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return result.sort((a, b) => a.length - b.length);
}

function perMillion(value: number) {
  return Math.round(value * 1e12) / 1e6;
}

function roundPrice(value: number) {
  return Math.round(value * 1e10) / 1e10;
}

function normalizeSlug(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

// The catalog id's lab file: the same path, dots as dashes, or the one file in the
// lab directory whose name matches without punctuation (eleven-v3 ↔ eleven_v3).
function resolveMediaBaseModel(id: string) {
  const direct = resolveBaseModel(id);
  if (direct !== undefined) return direct;
  const [lab, ...rest] = id.split("/");
  const slug = normalizeSlug(rest.join("/"));
  const dir = path.join(MODELS_ROOT, lab!);
  if (!existsSync(dir)) return undefined;
  const matches = readdirSync(dir).filter((file) => file.endsWith(".toml") && normalizeSlug(file.slice(0, -5)) === slug);
  return matches.length === 1 ? `${lab}/${matches[0]!.slice(0, -5)}` : undefined;
}

export function deriveReasoningOptions(
  schemaInput: unknown,
): NonNullable<SyncedBaseModel["reasoning_options"]> {
  let effortValues: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default">
    | undefined;

  const EffortValues = z.array(z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "default",
  ]));

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (key !== "properties" || value === null || typeof value !== "object") {
        visit(value);
        continue;
      }

      for (const [property, rawSchema] of Object.entries(value)) {
        const propertySchema = rawSchema as Record<string, unknown>;
        if (property === "effort" || property === "reasoning_effort") {
          const candidates = [propertySchema, ...arrayValue(propertySchema.anyOf), ...arrayValue(propertySchema.oneOf)];
          for (const candidate of candidates) {
            const parsed = EffortValues.safeParse(candidate.enum);
            if (parsed.success) effortValues = parsed.data;
          }
        }
        visit(rawSchema);
      }
    }
  };
  visit(schemaInput);

  // A thinking field describes an accepted input shape, not proof that this route
  // supports disabling thinking. Toggle support is curated per model instead.
  return effortValues === undefined ? [] : [{ type: "effort", values: effortValues }];
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}

async function loadCatalog() {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir !== undefined) return loadFixtureRows(fixtureDir, "catalog");

  const { accountID, token } = credentials();
  const pages: Array<z.infer<typeof CloudflareResponse>> = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    const url = new URL(`${API_BASE}/${accountID}/ai/catalog/models`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const { response, json } = await fetchJsonWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`Cloudflare AI Gateway catalog request failed: ${response.status} ${response.statusText}`);
    }
    const body = CloudflareResponse.parse(json);
    pages.push(body);
    const expectedPages = catalogPageCount(pages[0]!);
    if (expectedPages > MAX_CATALOG_PAGES) throw new Error(`Invalid Cloudflare AI Gateway catalog page count: ${expectedPages}`);
    if (page === expectedPages) return validateCatalogPages(pages, "Cloudflare AI Gateway catalog");
  }
  throw new Error("Cloudflare AI Gateway catalog exceeded the pagination safety limit");
}

async function loadCatalogSchemaInput(id: string): Promise<unknown> {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir !== undefined) {
    const file = path.join(fixtureDir, "schema", `${id.replaceAll("/", "_")}.json`);
    if (!existsSync(file)) return undefined;
    return z.object({
      success: z.literal(true),
      result: z.object({ schema: z.object({ input: z.unknown().optional() }).passthrough() }).passthrough(),
    }).passthrough().parse(JSON.parse(readFileSync(file, "utf8"))).result.schema.input;
  }

  const { accountID, token } = credentials();
  const { response, json } = await fetchJsonWithRetry(
    `${API_BASE}/${accountID}/ai/catalog/models/${id.split("/").map(encodeURIComponent).join("/")}/schema`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Cloudflare AI Gateway schema request failed for ${id}: ${response.status} ${response.statusText}`);
  }
  return z.object({
    success: z.literal(true),
    result: z.object({ schema: z.object({ input: z.unknown().optional() }).passthrough() }).passthrough(),
  }).passthrough().parse(json).result.schema.input;
}

function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN
    ?? process.env.CLOUDFLARE_PRODUCTION_API_TOKEN;
  const accountID = process.env.CLOUDFLARE_ACCOUNT_ID
    ?? process.env.CLOUDFLARE_PRODUCTION_ACCOUNT_ID_AI_GATEWAY_SANDBOX;
  if (!token || !accountID) {
    throw new Error(
      "Cloudflare AI Gateway sync requires Cloudflare API token and account ID credentials",
    );
  }
  return { accountID, token };
}

function loadFixtureRows(directory: string, prefix: string): unknown[] {
  const pages = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((file) => CloudflareResponse.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8"))))
    .sort((a, b) => a.result_info.page - b.result_info.page);
  return validateCatalogPages(pages, `Cloudflare AI Gateway fixtures in ${directory}`);
}

function catalogPageCount(page: z.infer<typeof CloudflareResponse>) {
  const calculated = Math.max(1, Math.ceil(page.result_info.total_count / page.result_info.per_page));
  if (page.result_info.total_pages !== undefined && page.result_info.total_pages !== calculated) {
    throw new Error("Invalid Cloudflare AI Gateway catalog pagination: total_pages does not match total_count");
  }
  return page.result_info.total_pages ?? calculated;
}

function validateCatalogPages(pages: Array<z.infer<typeof CloudflareResponse>>, source: string) {
  const first = pages[0];
  if (first === undefined) throw new Error(`${source} contained no pages`);
  const expectedPages = catalogPageCount(first);
  if (pages.length !== expectedPages) {
    throw new Error(`${source} contains ${pages.length}/${expectedPages} pages`);
  }

  const models: CatalogEntry[] = [];
  const ids = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (page.result_info.page !== index + 1) {
      throw new Error(`${source} expected page ${index + 1}, got ${page.result_info.page}`);
    }
    if (
      page.result_info.total_count !== first.result_info.total_count
      || page.result_info.per_page !== first.result_info.per_page
      || catalogPageCount(page) !== expectedPages
    ) {
      throw new Error(`${source} pagination changed while reading pages`);
    }
    if (page.result_info.count !== undefined && page.result_info.count !== page.result.length) {
      throw new Error(`${source} result count mismatch on page ${page.result_info.page}`);
    }
    if (page.result.length > page.result_info.per_page) {
      throw new Error(`${source} page ${page.result_info.page} exceeds per_page`);
    }
    for (const model of page.result) {
      if (ids.has(model.model_id)) throw new Error(`${source} returned duplicate model ID ${model.model_id}`);
      ids.add(model.model_id);
      models.push(model);
    }
  }
  if (models.length !== first.result_info.total_count) {
    throw new Error(`${source} pagination ended at ${models.length}/${first.result_info.total_count}`);
  }
  return models;
}

async function fetchJsonWithRetry(
  url: string | URL,
  init: RequestInit,
  attempts = 5,
): Promise<{ response: Response; json?: unknown }> {
  let delay = 500;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
          await response.body?.cancel();
          await waitForRetry(retryDelay(response, delay), init.signal);
          delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
          continue;
        }
        await response.body?.cancel();
        return { response };
      }
      try {
        return { response, json: await response.json() };
      } catch (error) {
        if (attempt === attempts) throw error;
      }
    } catch (error) {
      if (init.signal?.aborted || attempt === attempts) throw error;
    }
    await waitForRetry(delay, init.signal);
    delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
  }
  throw new Error("Cloudflare AI Gateway request exhausted retries");
}

function retryDelay(response: Response, fallback: number) {
  const value = response.headers.get("retry-after");
  if (value === null) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_DELAY_MS)
    : fallback;
}

function waitForRetry(delay: number, signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function mapLimit<T, R>(items: T[], limit: number, transform: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await transform(items[index]!);
    }
  }));
  return results;
}

// Structured provider_details is the source of truth. A curated cost is only allowed
// (and then required) when Cloudflare omits it, so a stale override can't outlive it.
function catalogCost(catalog: CatalogModel, curated: CuratedModel): NonNullable<SyncedBaseModel["cost"]> {
  const id = catalog.model_id;
  const detail = catalog.provider_details?.[0];
  if (detail !== undefined) {
    if (curated.cost !== undefined) {
      throw new Error(`${id}: catalog now has provider_details pricing; remove the curated cost`);
    }
    return proxiedCost(detail.pricing, id);
  }
  if (curated.cost === undefined) {
    throw new Error(`${id}: catalog has no provider_details pricing; add a curated cost`);
  }
  return curated.cost;
}

function proxiedCost(pricing: Record<string, number>, id: string): NonNullable<SyncedBaseModel["cost"]> {
  try {
    if ("long_context_threshold_tokens" in pricing) {
      const value = ContextPricing.parse(pricing);
      return contextCost(
        value.long_context_threshold_tokens,
        tokenCost(
          value.short_context_input_tokens,
          value.short_context_output_tokens,
          value.short_context_input_cached_tokens,
          value.short_context_input_cache_creation_tokens,
        ),
        tokenCost(
          value.long_context_input_tokens,
          value.long_context_output_tokens,
          value.long_context_input_cached_tokens,
          value.long_context_input_cache_creation_tokens,
        ),
      );
    }
    if ("under_200k_per_1m_input_tokens" in pricing) {
      const value = Tier200kPricing.parse(pricing);
      return contextCost(
        200_000,
        tokenCost(
          value.under_200k_per_1m_input_tokens,
          value.under_200k_per_1m_output_tokens,
          value.under_200k_per_1m_input_cached_tokens,
        ),
        tokenCost(
          value.over_200k_per_1m_input_tokens,
          value.over_200k_per_1m_output_tokens,
          value.over_200k_per_1m_input_cached_tokens,
        ),
      );
    }
    if ("under_512k_per_1m_input_tokens" in pricing) {
      const value = Tier512kPricing.parse(pricing);
      return contextCost(
        512_000,
        tokenCost(
          value.under_512k_per_1m_input_tokens,
          value.under_512k_per_1m_output_tokens,
          value.under_512k_per_1m_input_cached_tokens,
        ),
        tokenCost(
          value.over_512k_per_1m_input_tokens,
          value.over_512k_per_1m_output_tokens,
          value.over_512k_per_1m_input_cached_tokens,
        ),
      );
    }
    const value = FlatPricing.parse(pricing);
    return tokenCost(
      value.input_tokens,
      value.output_tokens,
      value.input_cached_tokens,
      value.input_cache_creation_tokens,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`${id}: unsupported structured pricing: ${error.message}`);
    }
    throw error;
  }
}

function tokenCost(input: number, output: number, cacheRead?: number, cacheWrite?: number) {
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
}

function contextCost(
  size: number,
  short: ReturnType<typeof tokenCost>,
  long: ReturnType<typeof tokenCost>,
): NonNullable<SyncedBaseModel["cost"]> {
  // Some rows repeat the same prices above the threshold; that isn't a tier.
  if (JSON.stringify(short) === JSON.stringify(long)) return short;
  return {
    ...short,
    tiers: [{ ...long, tier: { type: "context", size } }],
  };
}

function isSafeModelID(id: string) {
  if (path.isAbsolute(id) || id.includes("\\")) return false;
  const segments = id.split("/");
  return segments.length >= 2
    && segments.every((segment) => /^[A-Za-z0-9@._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function resolveBaseModel(id: string) {
  if (labFileExists(id)) return id;
  const dashed = id.replaceAll(".", "-");
  return labFileExists(dashed) ? dashed : undefined;
}

function labFileExists(id: string) {
  return existsSync(path.join(MODELS_ROOT, `${id}.toml`));
}

function labType(id: string) {
  const file = path.join(MODELS_ROOT, `${id}.toml`);
  return existsSync(file) ? (Bun.TOML.parse(readFileSync(file, "utf8")) as LabFile).type ?? "chat" : undefined;
}

function baseReasoning(id: string) {
  const file = path.join(MODELS_ROOT, `${id}.toml`);
  return existsSync(file) && z.object({ reasoning: z.boolean().optional() }).passthrough()
    .parse(readLabModel(file, id)).reasoning === true;
}

const TOOL_FIELDS = ["strict", "choice", "search", "grammar"];

// Native routes forward the body unchanged, so once the lab's own API
// (providers/<lab>) states its tool fields they are the model's: `lab` is the
// top-level part from `splitLabTools`. The catalog schema's tool_choice values
// fill in `choice` when the lab doesn't state it.
export function gatewayTools(current: unknown, lab: Record<string, unknown> | undefined, schemaInput: unknown) {
  const choice = schemaToolChoice(schemaInput);
  if (lab === undefined) return toolsWith(current, { choice });
  if (isRecord(current) && current.supported === false) return current;
  const rest = Object.fromEntries(Object.entries(isRecord(current) ? current : {}).filter(([key]) => !TOOL_FIELDS.includes(key)));
  return { supported: true, ...(choice === undefined ? {} : { choice }), ...lab, ...rest };
}

// The tool fields of the lab's own provider file, top-level and per API, when it states any.
function firstPartyTools(base: string): LabTools | undefined {
  const [lab, ...rest] = base.split("/");
  const file = path.join(path.dirname(PROVIDER_DIR), lab!, "models", `${rest.join("/")}.toml`);
  if (!existsSync(file)) return undefined;
  const doc = Bun.TOML.parse(readFileSync(file, "utf8")) as {
    capabilities?: { tools?: unknown };
    api?: Record<string, { capabilities?: { tools?: unknown } }>;
  };
  const top = toolFields(doc.capabilities?.tools);
  const apis = Object.fromEntries(Object.entries(doc.api ?? {}).map(([protocol, table]) => [protocol, toolFields(table.capabilities?.tools)]));
  return [top, ...Object.values(apis)].some((fields) => Object.keys(fields).length > 0) ? { top, apis } : undefined;
}

type LabTools = { top: Record<string, unknown>; apis: Record<string, Record<string, unknown>> };

function toolFields(tools: unknown) {
  return Object.fromEntries(Object.entries(isRecord(tools) ? tools : {}).filter(([key]) => TOOL_FIELDS.includes(key)));
}

// Each gateway API takes the lab's values for the same protocol (native routes
// forward the body unchanged; the REST Chat Completions route reaches OpenAI's own
// Chat Completions, which takes grammar and strict tools and rejects tool_search,
// live 2026-10-26). A value every API holds goes top-level; one that holds on
// only some APIs goes on each of those APIs. A value an API leaves out means no.
export function splitLabTools(lab: LabTools, protocols: string[]) {
  const resolved = protocols.map((protocol) => [protocol, { ...lab.top, ...lab.apis[protocol] }] as const);
  const shared = (key: string) => resolved.every(([, tools]) => JSON.stringify(tools[key]) === JSON.stringify(resolved[0]![1][key]));
  const pick = (fields: Record<string, unknown>, keep: (key: string) => boolean) =>
    Object.fromEntries(TOOL_FIELDS.filter((key) => keep(key) && fields[key] !== undefined).map((key) => [key, fields[key]]));
  return {
    top: pick(resolved[0]?.[1] ?? {}, shared),
    apis: Object.fromEntries(resolved.map(([protocol, tools]) => [protocol, pick(tools, (key) => !shared(key))])),
  };
}

function baseToolCall(id: string) {
  const file = path.join(MODELS_ROOT, `${id}.toml`);
  return existsSync(file) && z.object({ tool_call: z.boolean().optional() }).passthrough()
    .parse(readLabModel(file, id)).tool_call === true;
}

function prefixNotes(id: string) {
  return Object.entries(curation.prefix_notes)
    .filter(([prefix]) => id.startsWith(prefix))
    .sort(([a], [b]) => a.length - b.length)
    .flatMap(([, lines]) => lines);
}

function noteHeader(note: string[] | undefined) {
  return note === undefined || note.length === 0
    ? undefined
    : `${note.map((line) => `# ${line}`).join("\n")}\n`;
}
