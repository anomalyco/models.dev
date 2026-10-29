import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

// Abacus serves third-party models through RouteLLM. Its model endpoint is
// public and carries the host-specific data the catalog needs (rates,
// modalities, context, tools, `thinking`). RouteLLM publishes those rates in
// USD per token: https://abacus.ai/help/route-llm/ (accessed 2026-10-29).
// https://routellm.abacus.ai/v1/models
const API_ENDPOINT = process.env.ABACUS_MODELS_URL ?? "https://routellm.abacus.ai/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// IDs whose lab entry the generic resolver can't derive: a serving tier
// (contributor pricing, fast lane) of an existing lab model.
const BASE_MODEL_OVERRIDES: Record<string, string> = {
  "claude-opus-5-5-fast": "anthropic/claude-opus-5-5",
  "muse-spark-1.3-contributor": "meta/muse-spark-1.3",
};

// Serving tiers of a lab model need a distinct label, and the contributor tier
// has a privacy-relevant term the lab entry cannot state.
const CURATED_LABELS: Record<string, { name: string; description: string }> = {
  "claude-opus-5-5-fast": {
    name: "Claude Opus 5.5 Fast",
    description: "Fast lane of Claude Opus 5.5, served by Abacus at a higher per-token rate",
  },
  "muse-spark-1.3-contributor": {
    name: "Muse Spark 1.3 Contributor",
    description:
      "Contributor tier of Muse Spark 1.3: the same model at heavily discounted rates in exchange for Meta using prompts and completions to train future Meta models",
  },
};

// Source evidence for values the feed states but the lab does not.
const HEADER_NOTES: Record<string, string[]> = {
  "muse-spark-1.3-contributor": [
    "# Contributor-tier terms: this id's RouteLLM description states \"heavily discounted",
    "# rates in exchange for Meta using prompts and completions to train future Meta",
    "# models\" (accessed 2026-10-29).",
  ],
  "Qwen/Qwen3.8-27B": [
    "# Host limit: the feed publishes max_completion_tokens 131,072; the lab documents",
    "# an output cap of 32,768. The host value is the override below.",
  ],
  "Qwen/Qwen3.8-Flash-Next": [
    "# Host context: the feed publishes context_length 1,000,000; the lab documents",
    "# 262,144 native with extension up to 1M. The host advertises the extended window.",
  ],
};

// RouteLLM files these under `text_generation`, but they are transcription
// endpoints. The Abacus provider entry has never carried STT SKUs (#4705, #7901).
const TRANSCRIPTION_IDS = new Set([
  "gpt-realtime-whisper",
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

const Rate = z.union([z.string(), z.number()]);

export const AbacusModel = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    display_name: z.string().optional(),
    description: z.string().optional(),
    model_type: z.string(),
    input_modalities: z.array(z.string()).default([]),
    output_modalities: z.array(z.string()).default([]),
    input_token_rate: Rate.optional(),
    output_token_rate: Rate.optional(),
    cached_input_token_rate: Rate.nullish().transform((value) => value ?? undefined),
    context_length: z.number().int().positive().nullish().transform((value) => value ?? undefined),
    max_completion_tokens: z.number().int().positive().nullish().transform((value) => value ?? undefined),
    provider: z.string().optional(),
    api_formats: z.array(z.string()).optional(),
    agentic: z.boolean().optional(),
    code_agent: z.boolean().optional(),
    tools: z.boolean().optional(),
    thinking: z.boolean().nullish().transform((value) => value ?? undefined),
  })
  .passthrough();

export const AbacusResponse = z
  .object({
    data: z.array(AbacusModel),
  })
  .passthrough();

export type AbacusModel = z.infer<typeof AbacusModel>;

export const abacus = {
  id: "abacus",
  name: "Abacus",
  modelsDir: "providers/abacus/models",
  // /v1/models is the served catalog, but retired IDs keep their entries: the
  // migration in #10776 marked 40 of them `status = "deprecated"` for manual
  // lifecycle review, and the feed has no lifecycle metadata of its own.
  deleteMissing: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Abacus models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = AbacusResponse.parse(raw).data.filter((model) => model.model_type === "text_generation");
    if (models.length === 0) {
      throw new Error("Abacus catalog returned no text-generation models; refusing an empty feed as authoritative");
    }
    return models;
  },
  sourceID(model) {
    return intentionalSkip(model, resolveAbacusBaseModel(model.id)) ? undefined : model.id;
  },
  missingModelID(model) {
    // Intentional skips need no issue; anything else without a lab entry needs
    // a researched full definition.
    return intentionalSkip(model, resolveAbacusBaseModel(model.id)) ? undefined : model.id;
  },
  translateModel(model, context) {
    if (intentionalSkip(model, resolveAbacusBaseModel(model.id, context.authored(model.id)?.base_model))) {
      return undefined;
    }

    const built = buildAbacusModel(
      model,
      context.authored(model.id),
      context.v2?.(model.id),
    );
    if (built === undefined) return undefined;

    return {
      id: model.id,
      model: built.model,
      header: built.header,
      v2Set: built.v2Set,
    };
  },
} satisfies SyncProvider<AbacusModel>;

export function buildAbacusModel(
  model: AbacusModel,
  authored: ExistingModel | undefined,
  existingToml?: Record<string, unknown>,
): { model: SyncedModel; header: string; v2Set?: Record<string, unknown> } | undefined {
  const baseModel = resolveAbacusBaseModel(model.id, authored?.base_model);
  // Without a lab entry the module cannot author name, description, dates or
  // open_weights; the runner reports it as a missing model instead.
  if (baseModel === undefined) return undefined;
  if (intentionalSkip(model, baseModel)) return undefined;

  const inputKinds = kinds(model.input_modalities);
  const outputKinds = kinds(model.output_modalities);
  const labInput = labInputModalities(baseModel);
  const previousInput = modalityList(existingToml?.modalities, "input");
  const narrowedInput = labInput === undefined
    ? [...inputKinds].sort()
    : narrowInputs(labInput, previousInput, inputKinds);

  const reasoning = model.thinking === true
    ? true
    : authored?.reasoning;
  const reasoningOptions = reasoning === true
    ? authored?.reasoning_options ?? []
    : undefined;

  const limit = {
    context: model.context_length ?? authored?.limit?.context,
    input: authored?.limit?.input,
    output: model.max_completion_tokens ?? authored?.limit?.output,
  };

  const cost = {
    input: perMillion(model.input_token_rate),
    output: perMillion(model.output_token_rate),
    cache_read: perMillion(model.cached_input_token_rate),
    reasoning: authored?.cost?.reasoning,
    tiers: authored?.cost?.tiers,
  };

  const modalities = {
    input: toV1Modalities(labInput === undefined ? [...inputKinds].sort() : narrowedInput),
    output: toV1Modalities([...outputKinds].sort()),
  };

  const label = CURATED_LABELS[model.id];
  const modelValues = {
    name: authored?.name ?? label?.name,
    description: authored?.description ?? label?.description,
    attachment: modalities.input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: authored?.temperature,
    tool_call: model.tools === true ? true : authored?.tool_call,
    structured_output: authored?.structured_output,
    interleaved: authored?.interleaved,
    status: authored?.status,
    limit,
    modalities,
    cost,
  };

  const v2Set = narrowedInput !== undefined && isNarrower(narrowedInput, labInput)
    ? {
      "modalities.input": narrowedInput,
      "modalities.output": toMime(labOutputModalities(baseModel) ?? [...outputKinds]),
    }
    : undefined;

  return {
    model: factorBaseModel(
      baseModel,
      modelValues,
      limit,
      authored?.base_model === baseModel ? authored?.base_model_omit : undefined,
    ),
    header: header(model),
    v2Set,
  };
}

export function resolveAbacusBaseModel(modelID: string, existingBase?: string) {
  if (existingBase !== undefined) return existingBase;
  const override = BASE_MODEL_OVERRIDES[modelID];
  if (override !== undefined) return override;

  const direct = resolveModelMetadataBaseModel(modelID);
  if (direct !== undefined) return direct;

  const slash = modelID.indexOf("/");
  if (slash === -1) return undefined;
  return resolveModelMetadataBaseModel(modelID.slice(slash + 1));
}

function kinds(values: string[]) {
  return new Set(values.map((value) => modalityKind(value.toLowerCase())));
}

function modalityKind(value: string) {
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "audio";
  if (value.startsWith("video/")) return "video";
  if (value === "pdf" || value === "application/pdf") return "pdf";
  return value;
}

function toV1Modalities(values: string[]) {
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  return [...new Set(values.map(modalityKind))].filter((value) => allowed.has(value));
}

function perMillion(rate: string | number | undefined) {
  if (rate === undefined) return undefined;
  return Math.round(Number(rate) * 1_000_000 * 1_000_000) / 1_000_000;
}

function intentionalSkip(model: AbacusModel, baseModel: string | undefined) {
  if (TRANSCRIPTION_IDS.has(model.id)) return true;
  if (baseModel === undefined) return false;
  const type = labType(baseModel);
  return type !== undefined && type !== "chat";
}

function isNarrower(values: string[], full: string[]) {
  return values.length < full.length;
}

// Keep the authored order (and MIME variants) when the feed still accepts the
// same set; otherwise fall back to the lab list, filtered to the accepted kinds.
function narrowInputs(labInput: string[], previous: string[] | undefined, accepted: Set<string>) {
  const fromLab = labInput.filter((value) => accepted.has(modalityKind(value)));
  const fromPrevious = previous?.filter((value) => accepted.has(modalityKind(value)));
  return fromPrevious !== undefined && fromPrevious.length === fromLab.length ? fromPrevious : fromLab;
}

function header(model: AbacusModel) {
  const lines = [
    "# Source: https://routellm.abacus.ai/v1/models",
    "# RouteLLM reasoning: /v1/models exposes only `thinking`; the provider API has no",
    "# toggle, effort or budget request field (provider.toml audit, 2026-06-25).",
    ...(HEADER_NOTES[model.id] ?? []),
    `# RouteLLM input_modalities: ${JSON.stringify(model.input_modalities)}`,
    `# RouteLLM output_modalities: ${JSON.stringify(model.output_modalities)}`,
    `# RouteLLM context_length: ${model.context_length ?? "None"}`,
    `# RouteLLM max_completion_tokens: ${model.max_completion_tokens ?? "None"}`,
    `# RouteLLM input_token_rate: ${model.input_token_rate ?? "None"}`,
    `# RouteLLM output_token_rate: ${model.output_token_rate ?? "None"}`,
    `# RouteLLM cached_input_token_rate: ${model.cached_input_token_rate ?? "None"}`,
    `# RouteLLM thinking: ${model.thinking === true ? "True" : "None"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function labInputModalities(baseModel: string) {
  const toml = readLabToml(baseModel);
  if (toml === undefined) return undefined;
  return modalityList(toml.modalities, "input");
}

function labType(baseModel: string) {
  const toml = readLabToml(baseModel);
  const type = toml?.type;
  return typeof type === "string" ? type : undefined;
}

function labOutputModalities(baseModel: string) {
  const toml = readLabToml(baseModel);
  if (toml === undefined) return undefined;
  return modalityList(toml.modalities, "output");
}

function modalityList(value: unknown, side: "input" | "output") {
  if (value === null || typeof value !== "object") return undefined;
  const list = (value as Record<string, unknown>)[side];
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) return undefined;
  return list as string[];
}

function toMime(values: string[]) {
  return values.map((value) => value === "pdf" ? "application/pdf" : value);
}

const labTomlCache = new Map<string, Record<string, unknown> | undefined>();

function readLabToml(baseModel: string) {
  if (labTomlCache.has(baseModel)) return labTomlCache.get(baseModel);
  let toml: Record<string, unknown> | undefined;
  try {
    toml = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    toml = undefined;
  }
  labTomlCache.set(baseModel, toml);
  return toml;
}
