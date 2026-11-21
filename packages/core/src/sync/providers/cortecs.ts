import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AuthoredModelV2, LabModelV2, type ModalitiesV2 } from "../../schema-v2.js";
import type { SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
// CORTECS_MODELS_URL points the sync at a local or staging catalog.
const API_ENDPOINT = process.env.CORTECS_MODELS_URL ?? "https://api.cortecs.ai/v1/models";
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
  resolved_model: z.string().min(1).optional(),
  created: z.number().int().nonnegative(),
  description: z.string().optional(),
  pricing: z.object({
    currency: z.literal("EUR"),
    input_token: z.number().nonnegative(),
    output_token: z.number().nonnegative(),
    cache_read_cost: z.number().nonnegative().optional(),
    cache_write_cost: z.number().nonnegative().optional(),
    cache_write_1h_cost: z.number().nonnegative().optional(),
  }).passthrough(),
  context_size: z.number().int().positive(),
  max_output_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).transform(modalities).default(["text"]),
  output_modalities: z.array(z.string()).transform(modalities).default(["text"]),
  supported_features: z.array(z.string()).default([]),
}).passthrough().refine(
  (model) => !model.id.endsWith(":latest") || (model.resolved_model !== undefined && !model.resolved_model.includes(":")),
  { message: "Latest aliases require a concrete resolved_model" },
);

export const CortecsResponse = z.object({
  object: z.literal("list"),
  data: z.array(CortecsModel),
}).passthrough();

export type CortecsModel = z.infer<typeof CortecsModel>;

export const CortecsFile = AuthoredModelV2.omit({ id: true }).extend({ schema: z.literal(2) });
export type CortecsFile = z.infer<typeof CortecsFile>;

export const cortecs = {
  id: "cortecs",
  name: "Cortecs",
  modelsDir: "providers/cortecs/models",
  deleteMissing: true,
  authoritativeHeaders: true,
  sourceID: (model) => model.id,
  missingModelID: (model) => model.id,
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
    const alias = model.id.endsWith(":latest");
    const targetID = alias ? model.resolved_model! : model.id;
    const raw = context.v2?.(targetID);
    const existing = raw === undefined ? undefined : CortecsFile.parse(raw);
    if (!alias) {
      const v2 = buildCortecsModel(model, existing);
      return v2 === undefined ? undefined : {
        id: model.id,
        v2,
        header: existing === undefined ? undefined : modelHeader(this.modelsDir, targetID),
      };
    }
    const v2 = existing?.base_model === undefined ? undefined : buildCortecsModel({ ...model, id: targetID }, existing);
    if (v2?.base_model === undefined) return undefined;
    const lab = labModel(v2.base_model);
    if (lab.capabilities.reasoning.supported && v2.capabilities?.reasoning === undefined) return undefined;
    return {
      id: model.id,
      v2: { ...v2, v2_only: true, name: `${model.id} (${v2.name ?? lab.name})` },
      header: modelHeader(this.modelsDir, targetID),
    };
  },
} satisfies SyncProvider<CortecsModel>;

function modelHeader(modelsDir: string, id: string) {
  return readFileSync(path.join(modelsDir, `${id}.toml`), "utf8")
    .match(/^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*/)?.[0] ?? "";
}

// The catalog lists modality kinds only (image, audio). A new file takes the
// lab's exact MIME types of each listed kind, so it doesn't write the generic
// kind where the lab names formats. Returns nothing when that equals the lab's list.
export function exactModalities(model: CortecsModel) {
  const canonical = resolveCortecsBaseModel(model.id);
  if (canonical === undefined) return undefined;
  const lab = labModel(canonical).modalities;
  const input = exactKinds(model.input_modalities, lab.input);
  const output = exactKinds(model.output_modalities, lab.output);
  if (sameModalities({ input, output }, lab)) return undefined;
  return { modalities: { input, output } };
}

function sameModalities(a: ModalitiesV2, b: ModalitiesV2) {
  const same = (left: string[], right: string[]) => left.length === right.length && left.every((value) => right.includes(value));
  return same(a.input, b.input) && same(a.output, b.output);
}

function exactKinds(kinds: CortecsModality[], lab: string[]) {
  return kinds.flatMap((kind) => {
    const mime = kind === "pdf" ? "application/pdf" : kind;
    const exact = lab.filter((item) => item === mime || item.startsWith(`${mime}/`));
    return exact.length > 0 ? exact : [mime];
  });
}

export function inheritedOutput(canonical: string | undefined, context: number) {
  if (canonical === undefined) return context;
  const labOutput = (modelMetadata(canonical).limit as { output?: number } | undefined)?.output;
  return labOutput !== undefined && labOutput > context ? context : undefined;
}

const labModels = new Map<string, ReturnType<typeof readLabModel>>();
function labModel(canonical: string) {
  let model = labModels.get(canonical);
  if (model === undefined) labModels.set(canonical, model = readLabModel(canonical));
  return model;
}

function readLabModel(canonical: string) {
  const { schema: _schema, ...model } = LabModelV2.omit({ id: true })
    .extend({ schema: z.literal(2) })
    .parse(Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${canonical}.toml`), "utf8")));
  return model;
}

function usd(value: number) {
  return Math.round(value * EUR_TO_USD * 1_000) / 1_000;
}

export function buildCortecsModel(model: CortecsModel, existing: CortecsFile | undefined): CortecsFile | undefined {
  const canonical = existing?.base_model ?? resolveCortecsBaseModel(model.id);
  const lab = canonical === undefined ? undefined : labModel(canonical);
  const sourceReasoning = model.supported_features.includes("reasoning");
  if (existing === undefined && (sourceReasoning || lab?.capabilities.reasoning.supported === true)) {
    throw new MissingReasoningOptionsError(model.id, "Cortecs lists no reasoning controls; author them before creating this model");
  }
  if (existing === undefined && canonical === undefined) return undefined;
  const reportedOutput = model.max_output_tokens !== undefined && model.max_output_tokens < model.context_size
    ? model.max_output_tokens
    : undefined;
  const output = Math.min(reportedOutput ?? existing?.limit?.output ?? lab?.limit.output ?? model.context_size, model.context_size);
  const limit = {
    ...existing?.limit,
    context: model.context_size === lab?.limit.context ? undefined : model.context_size,
    output: output === lab?.limit.output ? undefined : output,
  };
  const current = existing?.modalities ?? lab?.modalities;
  const modalities = {
    input: exactKinds(model.input_modalities, current?.input ?? []),
    output: exactKinds(model.output_modalities, current?.output ?? []),
  };
  const input = existing?.cost?.text?.input;
  const tools = model.supported_features.includes("tools");
  return {
    ...existing,
    schema: 2,
    base_model: canonical,
    base_model_omit: existing?.base_model_omit ?? (
      lab?.limit.input !== undefined && lab.limit.context !== model.context_size && existing?.limit?.input === undefined
        ? ["limit.input"]
        : undefined
    ),
    capabilities: {
      ...existing?.capabilities,
      tools: tools === lab?.capabilities.tools.supported && existing?.capabilities?.tools === undefined
        ? undefined
        : tools ? { ...existing?.capabilities?.tools, supported: true } : { supported: false },
      reasoning: canonical === undefined
        ? sourceReasoning ? existing?.capabilities?.reasoning ?? { supported: true } : { supported: false }
        : existing?.capabilities?.reasoning,
      structured_output: model.supported_features.includes("json_mode"),
    },
    modalities: lab !== undefined && sameModalities(modalities, lab.modalities) ? undefined : modalities,
    limit: Object.values(limit).some((value) => value !== undefined) ? limit : undefined,
    cost: {
      ...existing?.cost,
      text: {
        ...existing?.cost?.text,
        input: { ...input, price: usd(model.pricing.input_token), cache: cacheCost(model.pricing, input?.cache) },
        output: { ...existing?.cost?.text?.output, price: usd(model.pricing.output_token) },
      },
    },
  };
}

type CacheCost = NonNullable<NonNullable<NonNullable<CortecsFile["cost"]>["text"]>["input"]>["cache"];

function cacheCost(pricing: CortecsModel["pricing"], cache: CacheCost | undefined) {
  const { cache_read_cost: read, cache_write_cost: write, cache_write_1h_cost: write1h } = pricing;
  if (cache === undefined && read === undefined && write === undefined && write1h === undefined) return undefined;
  const old = typeof cache?.write === "object" ? cache.write : undefined;
  const fiveMinutes = write === undefined ? old?.["5m"] ?? (typeof cache?.write === "number" ? cache.write : undefined) : usd(write);
  const oneHour = write1h === undefined ? old?.["1h"] : usd(write1h);
  return {
    ...cache,
    read: read === undefined ? cache?.read : usd(read),
    write: oneHour === undefined && old === undefined ? fiveMinutes : {
      ...old,
      ...(fiveMinutes === undefined ? {} : { "5m": fiveMinutes }),
      ...(oneHour === undefined ? {} : { "1h": oneHour }),
    },
  };
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
