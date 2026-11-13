import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const API_ENDPOINT = "https://api.cortecs.ai/v1/models";
const CANONICAL_BASE_MODEL_EXCEPTIONS = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4-0",
} as const;
// Cortecs publishes its default catalog prices in EUR per million tokens.
// Exchange rate used by the existing Cortecs entries, as of 2026-07-30.
const EUR_TO_USD = 1.114;

const CortecsModality = z.enum(["text", "audio", "image", "video", "pdf"]);
type CortecsModality = z.infer<typeof CortecsModality>;

function modalities(values: string[]): CortecsModality[] {
  const allowed = new Set<CortecsModality>(CortecsModality.options);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value): value is CortecsModality => allowed.has(value as CortecsModality));
  return [...new Set<CortecsModality>(result.length > 0 ? result : ["text"])];
}

export const CortecsModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  description: z.string().optional(),
  pricing: z.object({
    currency: z.literal("EUR"),
    input_token: z.number().nonnegative(),
    output_token: z.number().nonnegative(),
    cache_read_cost: z.number().nonnegative().optional(),
    cache_write_cost: z.number().nonnegative().optional(),
  }).passthrough(),
  context_size: z.number().int().positive(),
  max_output_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).transform(modalities).default(["text"]),
  output_modalities: z.array(z.string()).transform(modalities).default(["text"]),
  supported_features: z.array(z.string()).default([]),
}).passthrough();

export const CortecsResponse = z.object({
  object: z.literal("list"),
  data: z.array(CortecsModel),
}).passthrough();

export type CortecsModel = z.infer<typeof CortecsModel>;

export const cortecs = {
  id: "cortecs",
  name: "Cortecs",
  modelsDir: "providers/cortecs/models",
  deleteMissing: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Cortecs models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return CortecsResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    // The catalog says nothing about which reasoning_effort levels a model
    // takes, so a new reasoning model needs them researched before it's created.
    if (existing === undefined && cortecsReasons(model)) {
      throw new MissingReasoningOptionsError(model.id, "Cortecs lists no reasoning controls; author them before creating this model");
    }
    return {
      id: model.id,
      model: buildCortecsModel(model, existing, context.authored(model.id)),
      v2Set: existing === undefined ? exactModalities(model) : undefined,
    };
  },
} satisfies SyncProvider<CortecsModel>;

// The catalog lists modality kinds only (image, audio). A new file takes the
// lab's exact MIME types of each listed kind, so it doesn't write the generic
// kind where the lab names formats. Returns nothing when that equals the lab's list.
export function exactModalities(model: CortecsModel) {
  const canonical = resolveCortecsBaseModel(model.id);
  if (canonical === undefined) return undefined;
  const lab = labModalities(canonical);
  if (lab === undefined) return undefined;
  const input = exactKinds(model.input_modalities, lab.input);
  const output = exactKinds(model.output_modalities, lab.output);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value) => b.includes(value));
  if (same(input, lab.input) && same(output, lab.output)) return undefined;
  return { modalities: { input, output } };
}

function exactKinds(kinds: CortecsModality[], lab: string[]) {
  return kinds.flatMap((kind) => {
    const mime = kind === "pdf" ? "application/pdf" : kind;
    const exact = lab.filter((item) => item === mime || item.startsWith(`${mime}/`));
    return exact.length > 0 ? exact : [mime];
  });
}

function labModalities(modelID: string) {
  try {
    const lab = Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8")) as {
      modalities?: { input?: string[]; output?: string[] };
    };
    return lab.modalities?.input === undefined || lab.modalities.output === undefined
      ? undefined
      : { input: lab.modalities.input, output: lab.modalities.output };
  } catch {
    return undefined;
  }
}

function cortecsReasons(model: CortecsModel) {
  if (model.supported_features.includes("reasoning")) return true;
  const canonical = resolveCortecsBaseModel(model.id);
  return canonical !== undefined && modelMetadata(canonical).reasoning === true;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function usd(value: number | undefined) {
  if (value === undefined) return undefined;
  return Math.round(value * EUR_TO_USD * 1_000) / 1_000;
}

export function buildCortecsModel(
  model: CortecsModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
): SyncedModel {
  const features = new Set(model.supported_features);
  const input = model.input_modalities;
  const output = model.output_modalities;
  const canonical = existing?.base_model ?? resolveCortecsBaseModel(model.id);
  const sourceReasoning = features.has("reasoning");
  const reasoning = canonical === undefined ? sourceReasoning : existing?.reasoning ?? sourceReasoning;
  const reasoningOptions = canonical === undefined
    ? (sourceReasoning ? existing?.reasoning_options ?? [] : undefined)
    : (existing?.reasoning === true ? existing.reasoning_options : undefined);
  // A max_output_tokens at or above the context window is the window repeated,
  // not a per-request cap. Keep an authored output limit; a linked file otherwise
  // inherits the lab's.
  const reportedOutput = model.max_output_tokens !== undefined && model.max_output_tokens < model.context_size
    ? model.max_output_tokens
    : undefined;
  const limit = {
    context: model.context_size,
    input: existing?.limit?.input,
    output: reportedOutput ?? authored?.limit?.output ?? (canonical === undefined ? model.context_size : undefined),
  } as SyncedFullModel["limit"];
  const cost = {
    input: usd(model.pricing.input_token),
    output: usd(model.pricing.output_token),
    cache_read: usd(model.pricing.cache_read_cost) ?? existing?.cost?.cache_read,
    cache_write: usd(model.pricing.cache_write_cost) ?? existing?.cost?.cache_write,
    reasoning: existing?.cost?.reasoning,
    tiers: existing?.cost?.tiers,
  };
  if (canonical !== undefined) {
    // Model facts (family, dates, knowledge, open_weights) come from the lab
    // file. A display name or description stays only where it differs from
    // the lab's (factorBaseModel drops values equal to the lab).
    return factorBaseModel(canonical, {
      name: existing?.name,
      description: existing?.description,
      attachment: input.some((value) => value !== "text"),
      reasoning,
      reasoning_options: reasoningOptions,
      temperature: existing?.temperature,
      tool_call: features.has("tools"),
      structured_output: features.has("json_mode"),
      status: existing?.status,
      interleaved: existing?.interleaved,
      limit,
      modalities: { input, output },
      cost,
    }, limit, existing?.base_model_omit);
  }

  const family = existing?.family;
  return {
    name: existing?.name ?? model.id,
    description: existing?.description ?? model.description ?? describeModel({
      id: model.id,
      name: model.id,
      family,
      reasoning,
      tool_call: features.has("tools"),
      structured_output: features.has("json_mode"),
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? false,
    tool_call: features.has("tools"),
    structured_output: features.has("json_mode"),
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function resolveCortecsBaseModel(modelID: string) {
  const exception = CANONICAL_BASE_MODEL_EXCEPTIONS[
    modelID as keyof typeof CANONICAL_BASE_MODEL_EXCEPTIONS
  ];
  if (exception !== undefined) return resolveModelMetadataBaseModel(exception);

  const trailingFamily = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/.exec(modelID);
  if (trailingFamily !== null) {
    const [, major, minor, family] = trailingFamily;
    return resolveModelMetadataBaseModel(`anthropic/claude-${family}-${major}-${minor}`);
  }

  const compactFamily = /^claude-(opus|sonnet|haiku)(\d+)-(\d+)$/.exec(modelID);
  if (compactFamily !== null) {
    const [, family, major, minor] = compactFamily;
    return resolveModelMetadataBaseModel(`anthropic/claude-${family}-${major}-${minor}`);
  }

  return resolveModelMetadataBaseModel(modelID);
}
