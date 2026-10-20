import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AuthoredModelShape, ReasoningOption } from "../../schema.js";
import type { CostV2, CostWhenV2 } from "../../schema-v2.js";
import { readLabModel } from "../../translate.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";

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

const NATIVE_NPM: Record<string, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
};

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
}).passthrough();
// Some proxied rows (e.g. reflection-ai/beam-1.0-501b-a23b at launch) ship with
// provider_details = null. Those need a curated cost; see catalogCost.
const CatalogModel = CatalogEntry.extend({
  task: z.literal(TEXT_GENERATION),
  context_length: z.number().int().positive().nullish(),
  provider_details: z.array(ProviderDetail).length(1).nullish(),
});

export type MediaType = "speech" | "transcription";

// Non-text catalog tasks synced as v2-only files, by the model type each one serves.
const MEDIA_TASKS: Record<string, MediaType> = {
  "Text-to-Speech": "speech",
  "Automatic Speech Recognition": "transcription",
};
// Catalog tasks left out on purpose. Image and video models aren't synced yet; music
// generation has no model type in the schema; `websocket` is a realtime voice session
// billed per total audio minute and per text message, which no cost unit expresses.
const UNSYNCED_TASKS = new Set([
  "Text-to-Image",
  "Image-to-Image",
  "Text-to-Video",
  "Image-to-Video",
  "video-to-video",
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
    if (source.catalog.task !== TEXT_GENERATION) {
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
    return {
      id,
      model: buildCloudflareAiGatewayModel(
        source.catalog as CatalogModel,
        source.schemaInput,
        curated,
        context.authored(id),
      ),
      header: noteHeader([...prefixNotes(id), ...curated.note ?? []]),
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

  const npm = NATIVE_NPM[id.split("/")[0]!];
  if (npm !== undefined) model.provider = { npm };
  return model;
}

// ---------------------------------------------------------------------------
// Speech and transcription models (v2-only files)
// ---------------------------------------------------------------------------

// Third-party media models run on the REST API's universal endpoint: POST
// `{base_url}/run` with `{ model, input }`, where `input` follows the model's catalog
// schema. Generated audio comes back as a URL (or a data URI), transcripts as text.
const RUN_API = {
  "workers-ai-run": { base_url: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai" },
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
};

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
  doc.api = RUN_API;

  const pricing = catalog.provider_details?.[0]?.pricing;
  if (pricing === undefined) return { doc, unpriced: ["(no provider_details)"] };
  const { cost, unpriced } = mediaCost(pricing);
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
// per 1M tokens; character prices are per character. Every key must map, or no cost is
// written and the keys are returned, so no price is dropped silently.
export function mediaCost(pricing: Record<string, number>): { cost?: CostV2; unpriced?: string[] } {
  const sides: Record<string, PriceEntry> = {};
  const side = (modality: string, direction: "input" | "output") => (sides[`${modality}.${direction}`] ??= {});
  const unpriced: string[] = [];
  const additive: Array<[CostWhenV2, number]> = [];
  const modes: Array<[CostWhenV2, number]> = [];
  const set = (entry: PriceEntry, unit: string | undefined, value: number, key: string) => {
    if (entry.price !== undefined || (entry.unit !== undefined && entry.unit !== unit)) return unpriced.push(key);
    if (unit !== undefined) entry.unit = unit;
    entry.price = value;
  };

  for (const [key, value] of Object.entries(pricing)) {
    const minuteFeature = /^input_audio_minutes_(\w+)$/.exec(key)?.[1];
    const token = /^(input|output)_(?:(cached|cache_creation)_)?(?:(text|audio|image|video|reasoning)_)?tokens$/.exec(key);
    if (key === "input_characters") {
      set(side("text", "input"), "character", perMillion(value), key);
    } else if (key === "input_audio_minutes") {
      set(side("audio", "input"), "minute", value, key);
    } else if (minuteFeature !== undefined && ADDITIVE_MINUTE_PRICES[minuteFeature] !== undefined) {
      additive.push([ADDITIVE_MINUTE_PRICES[minuteFeature]!, value]);
    } else if (minuteFeature !== undefined && MODE_MINUTE_PRICES[minuteFeature] !== undefined) {
      modes.push([MODE_MINUTE_PRICES[minuteFeature]!, value]);
    } else if (token !== null) {
      const [, direction, cache, rawModality] = token as unknown as [string, "input" | "output", string | undefined, string | undefined];
      const reasoning = rawModality === "reasoning";
      const entry = side(reasoning ? "text" : rawModality ?? "text", direction);
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

function baseReasoning(id: string) {
  const file = path.join(MODELS_ROOT, `${id}.toml`);
  return existsSync(file) && z.object({ reasoning: z.boolean().optional() }).passthrough()
    .parse(readLabModel(file, id)).reasoning === true;
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
