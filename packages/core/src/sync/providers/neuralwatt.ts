import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.neuralwatt.com/v1/models";

// Flex is billed at 65% of standard, but /v1/models quotes the standard rate
// for -flex IDs. https://portal.neuralwatt.com/docs/guides/flex-tier
const FLEX_MULTIPLIER = 0.65;

// Serving tiers Neuralwatt layers onto a base checkpoint.
const TIER_SUFFIX = /-(fast|flex|short)$/;

// Quantization and checkpoint-date suffixes on Hugging Face repo names.
const REPO_SUFFIX = /-(nvfp4|fp8|awq|int4|\d{4})$/;

// A rewrite drops interior comments, so document the budget control, which
// the endpoint never describes, in the header the runner re-attaches.
const BUDGET_HEADER = "# Budget: thinking_token_budget (integer reasoning tokens)\n";

// A canonical ID may carry an MoE active-parameter suffix the served ID drops.
const MOE_SUFFIX = /^-a\d+b$/;

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Catalog effort levels; formatToml orders them weakest to strongest.
const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Effort = (typeof EFFORT_VALUES)[number];

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const Metadata = z.object({
  display_name: z.string(),
  description: z.string(),
  huggingface_id: z.string().nullish(),
  pricing: z.object({
    input_per_million: z.number().nullish(),
    output_per_million: z.number().nullish(),
    cached_input_per_million: z.number().nullish(),
    pricing_tbd: z.boolean().optional(),
  }).passthrough(),
  capabilities: z.object({
    tools: z.boolean(),
    json_mode: z.boolean(),
    vision: z.boolean(),
    reasoning: z.boolean(),
  }).passthrough(),
  reasoning: z.object({
    supported_efforts: z.array(z.string()),
  }).passthrough(),
  limits: z.object({
    max_context_length: z.number().nullish(),
    max_output_tokens: z.number().nullish(),
  }).passthrough(),
  deprecated: z.boolean().optional(),
}).passthrough();

export const NeuralwattModel = z.object({
  id: z.string(),
  max_model_len: z.number().optional(),
  metadata: Metadata,
}).passthrough();

export const NeuralwattResponse = z.object({
  data: z.array(NeuralwattModel),
}).passthrough();

export type NeuralwattModel = z.infer<typeof NeuralwattModel>;

export const neuralwatt = {
  id: "neuralwatt",
  name: "Neuralwatt",
  modelsDir: "providers/neuralwatt/models",
  // Beta models are listed only for accounts granted access to each one.
  deleteMissing: false,
  async fetchModels() {
    const headers = process.env.NEURALWATT_API_KEY
      ? { Authorization: `Bearer ${process.env.NEURALWATT_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Neuralwatt request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return NeuralwattResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const translated = buildNeuralwattModel(model, context.existing(model.id), context.authored(model.id));
    return {
      id: model.id,
      model: translated,
      header: translated.reasoning_options?.some((option) => option.type === "budget_tokens")
        ? BUDGET_HEADER
        : undefined,
    };
  },
} satisfies SyncProvider<NeuralwattModel>;

export function buildNeuralwattModel(
  model: NeuralwattModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const { capabilities, limits, pricing } = model.metadata;
  const flex = model.id.endsWith("-flex");

  const context = limits.max_context_length ?? model.max_model_len ?? existing?.limit?.context ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    // The API reports no output cap for models that can fill the context.
    output: limits.max_output_tokens ?? existing?.limit?.output ?? context,
  };

  const name = existing?.name ?? model.metadata.display_name;
  const modalities: { input: Modality[]; output: Modality[] } = {
    // Neuralwatt only advertises vision, never video or audio input.
    input: capabilities.vision ? ["text", "image"] : ["text"],
    output: ["text"],
  };

  // Always factor onto canonical metadata; keep an authored pointer we cannot
  // re-derive, such as a canonical ID carrying a suffix the served ID drops.
  const baseModel = resolveBaseModel(model) ?? authored?.base_model;

  const values: Omit<SyncedFullModel, "description" | "release_date" | "last_updated"> = {
    name,
    family: existing?.family,
    attachment: capabilities.vision,
    reasoning: capabilities.reasoning,
    reasoning_options: capabilities.reasoning ? reasoningOptions(model, authored) : undefined,
    temperature: existing?.temperature,
    tool_call: capabilities.tools,
    structured_output: capabilities.json_mode,
    knowledge: existing?.knowledge,
    // Neuralwatt serves open models only; huggingface_id is often null anyway.
    open_weights: existing?.open_weights ?? true,
    // A revived model clears the flag; hand-authored beta/alpha stays.
    status: model.metadata.deprecated === true
      ? "deprecated"
      : existing?.status === "deprecated"
        ? undefined
        : existing?.status,
    // Reasoning traces always come back on a `reasoning` field, provider-wide.
    interleaved: existing?.interleaved ?? (capabilities.reasoning || undefined),
    cost: pricing.pricing_tbd === true ? existing?.cost : {
      input: price(pricing.input_per_million, flex) ?? 0,
      output: price(pricing.output_per_million, flex) ?? 0,
      cache_read: price(pricing.cached_input_per_million, flex),
    },
    limit,
    modalities,
  };

  // A factored model inherits the canonical blurb and dates; a standalone one
  // needs its own, and every entry reports created = 0, so it gets the run date.
  if (baseModel !== undefined) {
    const overrides = {
      ...values,
      description: existing?.description,
      release_date: existing?.release_date,
      last_updated: existing?.last_updated,
    };
    return factorBaseModel(baseModel, overrides, limit, authored?.base_model_omit);
  }

  return {
    ...values,
    release_date: existing?.release_date ?? today,
    last_updated: existing?.last_updated ?? today,
    description: existing?.description ?? describeModel({
      id: model.id,
      name,
      reasoning: capabilities.reasoning,
      tool_call: capabilities.tools,
      structured_output: capabilities.json_mode,
      open_weights: true,
      limit,
      modalities,
    }),
  };
}

// Match on the bare slug. The Hugging Face org is no help: repacks are served
// under the quantizer's namespace, not the lab's.
function resolveBaseModel(model: NeuralwattModel): string | undefined {
  const repo = model.metadata.huggingface_id?.split("/")[1];
  const slugs = [strip(model.id, TIER_SUFFIX)];
  if (repo !== undefined) slugs.push(strip(repo.toLowerCase(), REPO_SUFFIX));

  for (const slug of slugs) {
    const match = resolveModelMetadataBaseModel(slug) ?? resolveMoeBaseModel(slug);
    if (match !== undefined) return match;
  }
  return undefined;
}

let canonicalIDs: string[] | undefined;

function resolveMoeBaseModel(slug: string): string | undefined {
  canonicalIDs ??= [...new Bun.Glob("**/*.toml").scanSync({ cwd: MODELS_DIR })]
    .map((file) => file.slice(0, -5).split(path.sep).join("/"));

  const matches = canonicalIDs.filter((id) => {
    const name = id.split("/").at(-1) ?? "";
    return name.startsWith(slug) && MOE_SUFFIX.test(name.slice(slug.length));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function strip(value: string, suffix: RegExp) {
  let result = value;
  while (suffix.test(result)) result = result.replace(suffix, "");
  return result;
}

// The API knows the effort ladder; budget controls stay hand-authored.
function reasoningOptions(
  model: NeuralwattModel,
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const values = model.metadata.reasoning.supported_efforts
    .filter((effort): effort is Effort => EFFORT_VALUES.includes(effort as Effort));
  const others = authored?.reasoning_options?.filter((option) => option.type !== "effort") ?? [];
  return values.length > 0 ? [{ type: "effort", values }, ...others] : others;
}

// toPrecision drops the float error in products like 4.5 * 0.65.
function price(value: number | null | undefined, flex: boolean) {
  if (value == null) return undefined;
  return flex ? Number((value * FLEX_MULTIPLIER).toPrecision(12)) : value;
}
