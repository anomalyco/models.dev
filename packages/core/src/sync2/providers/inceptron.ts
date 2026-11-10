// Inceptron: https://api.inceptron.io/v1/models (public; INCEPTRON_MODELS_URL
// overrides it). Each ready model carries its own models.dev metadata (lab
// model, reasoning controls, reasoning field, status), checked before
// anything is written. Authoritative for the name, token and cache prices,
// context and output limits, input and output kinds, tools, structured
// output, temperature, reasoning with its controls, the reasoning field and
// status. New models are created from the lab model it names; dropped and
// unready models are deleted.

import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.inceptron.io/v1/models";
const KINDS = new Set(["text", "audio", "image", "video", "pdf"]);
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

const ReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).strict(),
  z.object({ type: z.literal("effort"), values: z.array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])) }).strict(),
  z.object({ type: z.literal("budget_tokens"), min: z.number().int().optional(), max: z.number().int().optional() }).strict(),
]);

const ModelsDevMetadata = z.object({
  base_model: z.string().regex(/^[^./\\][^/\\]*\/[^./\\][^/\\]*$/),
  reasoning_options: z.array(ReasoningOption).optional(),
  interleaved: z.union([z.literal(true), z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict()]).optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
}).strict();

const InceptronModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  is_ready: z.boolean().optional(),
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive(),
  input_modalities: z.array(z.string()).min(1),
  output_modalities: z.array(z.string()).min(1),
  supported_features: z.array(z.string()),
  supported_sampling_parameters: z.array(z.string()),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_reads: z.string().optional(),
    input_cache_writes: z.string().optional(),
  }),
  models_dev: ModelsDevMetadata.optional(),
});
type InceptronModel = z.infer<typeof InceptronModel>;

const InceptronResponse = z.object({ object: z.literal("list"), data: z.array(InceptronModel) }).strict();

export const inceptron: SyncModule<unknown> = {
  id: "inceptron",
  name: "Inceptron",
  policy: {
    owns: [
      "name",
      "status",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "capabilities.temperature",
      "limit.context",
      "limit.output",
      "api.chat-completions.compatibility.reasoning_field",
      "api.chat-completions.legacy_interleaved",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(process.env.INCEPTRON_MODELS_URL ?? API_ENDPOINT, { source: "Inceptron models" }),
  observe: (raw) => InceptronResponse.parse(raw).data.filter((model) => model.is_ready !== false).map(observe),
};

function observe(model: InceptronModel): Observation {
  const meta = model.models_dev;
  if (meta === undefined) throw new Error(`Ready Inceptron model ${model.id} is missing models_dev metadata`);
  if (!existsSync(path.join(REPO_ROOT, "models", `${meta.base_model}.toml`))) {
    throw new Error(`Ready Inceptron model ${model.id} refers to missing base model ${meta.base_model}`);
  }
  const features = new Set(model.supported_features);
  const reasoning = features.has("reasoning");
  const options = meta.reasoning_options;
  if (reasoning !== (options !== undefined)) throw new Error(`Inceptron model ${model.id} must expose reasoning_options exactly when reasoning is supported`);
  if (meta.interleaved !== undefined && !reasoning) throw new Error(`Inceptron model ${model.id} exposes interleaving without reasoning`);
  const types = options?.map((option) => option.type) ?? [];
  if (new Set(types).size !== types.length) throw new Error(`Inceptron model ${model.id} has duplicate reasoning option types`);
  if (types.includes("effort") !== model.supported_sampling_parameters.includes("reasoning_effort")) {
    throw new Error(`Inceptron model ${model.id} must advertise reasoning_effort exactly when effort options are exposed`);
  }
  const kinds = (direction: string, values: string[]) => {
    const unique = [...new Set(values)];
    for (const value of unique) if (!KINDS.has(value)) throw new Error(`Inceptron model ${model.id} has unsupported ${direction} modality: ${value}`);
    return unique.map((value) => (value === "pdf" ? "application/pdf" : value));
  };
  const effort = options?.find((option) => option.type === "effort");
  const budget = options?.find((option) => option.type === "budget_tokens");
  return {
    id: model.id,
    base: [meta.base_model],
    name: model.name,
    status: meta.status ?? null,
    modalities: { input: kinds("input", model.input_modalities), output: kinds("output", model.output_modalities) },
    capabilities: {
      tools: { supported: features.has("tools") },
      reasoning: reasoning
        ? {
          supported: true,
          toggle: types.includes("toggle") ? true : null,
          effort: effort === undefined ? null : [...effort.values].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)),
          budget: budget === undefined ? null : Object.fromEntries(Object.entries({ min: budget.min, max: budget.max }).filter(([, value]) => value !== undefined)),
        }
        : { supported: false },
      structured_output: features.has("structured_outputs"),
      temperature: model.supported_sampling_parameters.includes("temperature"),
    },
    limit: { context: model.context_length, output: model.max_output_length },
    api: {
      "chat-completions": {
        legacy_interleaved: meta.interleaved === true ? true : null,
        compatibility: { reasoning_field: meta.interleaved === undefined || meta.interleaved === true ? null : meta.interleaved.field },
      },
    },
    cost: {
      text: {
        input: { price: perMillion(model.pricing.prompt), cache: { read: optional(model.pricing.input_cache_reads), write: optional(model.pricing.input_cache_writes) } },
        output: { price: perMillion(model.pricing.completion) },
      },
    },
  } as Observation;
}

function optional(value: string | undefined) {
  return value === undefined ? null : perMillion(value);
}

/** A non-negative decimal USD/token string as USD/1M tokens, without floating-point multiplication. */
function perMillion(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new Error(`Invalid Inceptron per-token price: ${value}`);
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`.replace(/^0+(?=\d)/, "");
  const places = fraction.length - 6;
  const scaled = places <= 0 ? `${digits}${"0".repeat(-places)}` : `${digits.slice(0, -places) || "0"}.${digits.slice(-places).padStart(places, "0")}`;
  const result = Number(scaled);
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid Inceptron per-token price: ${value}`);
  return result;
}
