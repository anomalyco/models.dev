import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.neuralwatt.com/v1/models";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// The live catalog carries ~27 entries; the floor sits just below the largest
// observed retirement batch (8) so a truncated response fails the run before
// deprecateMissing can act on it.
const MIN_LIVE_MODELS = 20;

const REASONING_EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const NEURALWATT_ORG_TO_LAB: Record<string, string | undefined> = {
  Qwen: "alibaba",
  XiaomiMiMo: "xiaomi",
  "deepseek-ai": "deepseek",
  google: "google",
  moonshotai: "moonshotai",
  "zai-org": "zhipuai",
};

// A few neuralwatt entries re-host a checkpoint under an id that does not follow
// its lab's namespace or suffix conventions; alias those to the canonical files.
const BASE_MODEL_ALIASES: Record<string, string | undefined> = {
  "nvidia/Gemma-4-31B-IT-NVFP4": "google/gemma-4-31b-it",
  "XiaomiMiMo/MiMo-V2.6-Pro-MOPD": "xiaomi/mimo-v2.6-pro",
};

const NeuralwattPricing = z.object({
  input_per_million: z.number().optional(),
  output_per_million: z.number().optional(),
  cached_input_per_million: z.number().nullable().optional(),
  pricing_tbd: z.boolean().optional(),
}).passthrough();

const NeuralwattCapabilities = z.object({
  tools: z.boolean().optional(),
  json_mode: z.boolean().optional(),
  vision: z.boolean().optional(),
  audio_input: z.boolean().optional(),
  reasoning: z.boolean().optional(),
}).passthrough();

const NeuralwattReasoning = z.object({
  supported_efforts: z.array(z.string()).optional(),
}).passthrough();

const NeuralwattLimits = z.object({
  max_context_length: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
}).passthrough();

export const NeuralwattModel = z.object({
  id: z.string(),
  created: z.number(),
  max_model_len: z.number().optional(),
  metadata: z.object({
    display_name: z.string(),
    huggingface_id: z.string().nullable(),
    pricing: NeuralwattPricing,
    capabilities: NeuralwattCapabilities,
    reasoning: NeuralwattReasoning,
    limits: NeuralwattLimits,
    deprecated: z.boolean(),
  }).passthrough(),
}).passthrough();

export const NeuralwattResponse = z.object({
  data: z.array(NeuralwattModel),
}).passthrough();

export type NeuralwattModel = z.infer<typeof NeuralwattModel>;

export function neuralwattID(id: string): string {
  return id.replaceAll("_", "-");
}

export function labModelID(huggingfaceId: string): string | undefined {
  const alias = BASE_MODEL_ALIASES[huggingfaceId];
  if (alias !== undefined) return canonicalModelFile(alias);
  const separator = huggingfaceId.indexOf("/");
  if (separator === -1) return undefined;
  const lab = NEURALWATT_ORG_TO_LAB[huggingfaceId.slice(0, separator)];
  if (lab === undefined) return undefined;
  const slug = huggingfaceId
    .slice(separator + 1)
    .toLowerCase()
    .replace(/(?:-(?:fp8|fp16|bf16|int8|int4))+$/, "");
  return canonicalModelFile(`${lab}/${slug}`);
}

export function resolveNeuralwattBaseModel(
  model: NeuralwattModel,
  siblingBase: string | undefined,
): string | undefined {
  const huggingfaceId = model.metadata.huggingface_id;
  return (huggingfaceId === null ? undefined : labModelID(huggingfaceId)) ?? siblingBase;
}

export function buildNeuralwattModel(
  model: NeuralwattModel,
  existing: ExistingModel | undefined,
  baseModel: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const { capabilities, limits, pricing } = model.metadata;
  const vision = capabilities.vision === true;
  const audioInput = capabilities.audio_input === true;
  const reasoning = capabilities.reasoning;
  const cachedInputPerMillion = pricing.cached_input_per_million ?? undefined;

  const cost = pricing.pricing_tbd === true
      || pricing.input_per_million === undefined
      || pricing.output_per_million === undefined
    ? existing?.cost
    : {
        input: price(pricing.input_per_million),
        output: price(pricing.output_per_million),
        cache_read: cachedInputPerMillion === undefined
          ? undefined
          : price(cachedInputPerMillion),
      };

  const limit = {
    context: limits.max_context_length ?? model.max_model_len ?? existing?.limit?.context,
    output: limits.max_output_tokens ?? existing?.limit?.output,
  };

  const values = {
    name: existing?.name ?? model.metadata.display_name,
    release_date: existing?.release_date
      ?? (model.created > 0 ? dateFromTimestamp(model.created) : undefined),
    last_updated: existing === undefined ? today : existing.last_updated,
    attachment: vision || audioInput,
    reasoning,
    tool_call: capabilities.tools,
    structured_output: capabilities.json_mode,
    knowledge: existing?.knowledge,
    status: model.metadata.deprecated === true ? "deprecated" : existing?.status,
    interleaved: existing?.interleaved ?? (reasoning === true ? true : undefined),
    cost,
    limit,
    modalities: {
      input: [
        "text",
        ...(vision ? ["image" as const] : []),
        ...(audioInput ? ["audio" as const] : []),
      ],
      output: ["text"],
    },
  } as SyncedFullModel;

  if (reasoning === true) {
    const supported = model.metadata.reasoning.supported_efforts ?? [];
    const ladder = REASONING_EFFORT_LADDER.filter((level) => supported.includes(level));
    const preserved = existing?.reasoning_options?.filter((option) => option.type !== "effort") ?? [];
    if (ladder.length === 0 && preserved.length === 0) {
      throw new MissingReasoningOptionsError(
        neuralwattID(model.id),
        `reasoning model (base ${baseModel ?? "unknown"}) that Neuralwatt's /v1/models exposes no`
          + " reasoning controls for; probe the route and author its reasoning_options by hand",
      );
    }
    values.reasoning_options = [
      ...(ladder.length > 0 ? [{ type: "effort" as const, values: [...ladder] }] : []),
      ...preserved,
    ];
  }

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
}

// existsSync is case-insensitive on Windows/macOS; verify the real on-disk
// filename case so the resolved base_model matches the canonical metadata
// exactly (and CI on Linux).
function canonicalModelFile(candidate: string): string | undefined {
  const separator = candidate.indexOf("/");
  if (separator === -1) return undefined;
  const lab = candidate.slice(0, separator);
  const expected = `${candidate.slice(separator + 1)}.toml`.toLowerCase();

  let labDir: string | undefined;
  try {
    labDir = readdirSync(MODELS_DIR, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === lab.toLowerCase())?.name;
  } catch {
    return undefined;
  }
  if (labDir === undefined) return undefined;

  let file: string | undefined;
  try {
    file = readdirSync(path.join(MODELS_DIR, labDir))
      .find((name) => name.toLowerCase() === expected);
  } catch {
    return undefined;
  }
  if (file === undefined) return undefined;
  return `${labDir}/${file.slice(0, -".toml".length)}`;
}

export async function fetchNeuralwattModels(fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Neuralwatt models request failed: ${response.status} ${response.statusText}`);
  }
  const raw = await response.json();
  const parsed = NeuralwattResponse.parse(raw);
  if (parsed.data.length < MIN_LIVE_MODELS) {
    throw new Error(
      `Neuralwatt returned ${parsed.data.length} models, below the ${MIN_LIVE_MODELS} needed to`
        + ` distinguish a retirement from a truncated response`,
    );
  }
  return raw;
}

export function parseModels(raw: unknown): NeuralwattModel[] {
  const data = NeuralwattResponse.parse(raw).data;
  if (data.length === 0) {
    throw new Error("Neuralwatt returned an empty model catalog");
  }
  return data;
}

const VARIANT_SUFFIX = /-(?:flex|fast|speed)$/;

export const neuralwatt = {
  id: "neuralwatt",
  name: "Neuralwatt",
  modelsDir: "providers/neuralwatt/models",
  // The wire-path comments below are regenerated on every sync so a file
  // never keeps controls that this host's API stopped documenting.
  authoritativeHeaders: true,
  // A model delisted from /v1/models is rewritten as status = "deprecated"
  // instead of being deleted: the entry keeps its metadata and pricing for
  // the deprecation window, and re-runs leave it untouched.
  deprecateMissing: true,
  async fetchModels() {
    return fetchNeuralwattModels();
  },
  parseModels,
  translateModel(model: NeuralwattModel, context) {
    const id = neuralwattID(model.id);
    const resolved = context.existing(id);
    const local = context.authored(id);
    // The runner's existing(id) resolves the previous base and merges it with
    // the local file, so base-derived identity fields would be re-pinned as
    // stale overrides whenever the base changes (e.g. onto a dated checkpoint
    // such as deepseek-v4-flash-0731). Carry only locally authored identity
    // over; an omitted field stays inherited through the new base.
    const existing = resolved === undefined ? undefined : {
      ...resolved,
      name: local?.name,
      release_date: local?.release_date,
      last_updated: local?.last_updated,
    };
    // nw-* entries are Neuralwatt-branded aliases for lab models the host also
    // serves under their own ids; the catalog does not author branded routes,
    // so these are reported as missing models instead of aliasing the lab file.
    if (id.startsWith("nw-")) return undefined;
    // Variant ids (flex/fast/speed) may lack their own huggingface_id; fall
    // back to the sibling entry's resolved base so the variant still factors
    // onto the same lab model.
    const sibling = id.replace(VARIANT_SUFFIX, "");
    const siblingBase = sibling === id ? undefined : context.existing(sibling)?.base_model;
    const base = resolveNeuralwattBaseModel(model, siblingBase);
    // A live model whose lab metadata cannot be resolved is skipped: the
    // runner preserves its TOML and reports it rather than expanding or
    // deleting the file.
    if (base === undefined) return undefined;
    const built = buildNeuralwattModel(model, existing, base);
    return { id, model: built, header: neuralwattHeader(built) };
  },
  sourceID(model: NeuralwattModel) {
    return neuralwattID(model.id);
  },
  missingModelID(model: NeuralwattModel) {
    return neuralwattID(model.id);
  },
  skippedNotice(ids: string[]) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} remote model(s) skipped: Neuralwatt-branded nw-* aliases are not authored, and other ids need a resolvable models/<lab>/<model>.toml base: ${ids.join(", ")}`,
    ];
  },
  missingNotice(paths: string[]) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local model(s) deleted after being removed from the Neuralwatt API: ${paths.join(", ")}`,
    ];
  },
} satisfies SyncProvider<NeuralwattModel>;

// Leading wire-path comments for every reasoning control this host authors on
// a file, matching the fields documented in providers/neuralwatt/provider.toml.
// With authoritativeHeaders enabled, this header replaces whatever was on disk.
const CHAT_COMPLETIONS_DOC_URL = "https://portal.neuralwatt.com/docs/api/chat-completions";

function neuralwattHeader(model: SyncedModel): string | undefined {
  const options = model.reasoning_options;
  if (options === undefined || options.length === 0) return undefined;
  const lines: string[] = [];
  for (const option of options) {
    if (option.type === "effort") {
      const values = option.values.length > 0
        ? option.values.map((value) => `"${value}"`).join(" | ")
        : "(model-specific accepted values)";
      lines.push(`# Effort: reasoning_effort = ${values}`);
    }
    if (option.type === "budget_tokens") {
      lines.push("# Budget: thinking_token_budget (integer reasoning tokens)");
    }
  }
  if (lines.length === 0) return undefined;
  lines.push(`# ${CHAT_COMPLETIONS_DOC_URL}`);
  return `${lines.join("\n")}\n`;
}

// The endpoint returns artifacts like 1.4000000000000001, so every published
// price is rounded.
function price(value: number): number {
  return Number(value.toFixed(6));
}

function dateFromTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}
