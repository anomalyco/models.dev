import path from "node:path";
import { z } from "zod";

import type {
  ExistingModel,
  SyncProvider,
  SyncedBaseModel,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

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

// thinking_token_budget is accepted on every model except these two, which
// reject it with a 400. Serving tiers share their base model's behaviour.
// https://portal.neuralwatt.com/docs/api/chat-completions
const BUDGET_REJECTORS = new Set(["deepseek-v4-flash", "gemma-4-31b"]);

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
  // Optional: `capabilities.reasoning` is the authoritative flag, and a model
  // with no reasoning at all has no reason to carry an effort ladder.
  reasoning: z.object({
    supported_efforts: z.array(z.string()),
  }).passthrough().optional(),
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
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Neuralwatt models were not created because no canonical \`models/\` entry resolved for them, or because the API published no usable price.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a `models/<lab>/<model>.toml` entry to include them in the next sync.",
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Neuralwatt models were absent from the live API and were retained; a run cannot tell a retired model from a beta this account was never granted.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
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
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);

    // The endpoint supplies no description, dates or knowledge cutoff, so a
    // new ID needs canonical metadata to inherit and a real price. Never
    // author a standalone definition for a lab model from the API alone.
    if (
      existing === undefined
      && (baseModelFor(model, authored) === undefined || buildCost(model, undefined) === undefined)
    ) {
      return undefined;
    }

    const translated = buildNeuralwattModel(model, existing, authored);
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
): SyncedModel {
  const { capabilities, limits } = model.metadata;

  const context = limits.max_context_length ?? model.max_model_len ?? existing?.limit?.context ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    // The API reports no output cap for models that can fill the context.
    output: limits.max_output_tokens ?? existing?.limit?.output ?? context,
  };

  const modalities: { input: Modality[]; output: Modality[] } = {
    // Neuralwatt only advertises vision, never video or audio input.
    input: capabilities.vision ? ["text", "image"] : ["text"],
    output: ["text"],
  };

  const baseModel = baseModelFor(model, authored);

  const values: Partial<SyncedFullModel> = {
    name: existing?.name ?? model.metadata.display_name,
    description: existing?.description,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
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
    cost: buildCost(model, existing),
    limit,
    modalities,
  };

  if (baseModel !== undefined) {
    const factored = factorBaseModel(
      baseModel,
      values,
      limit,
      authored?.base_model_omit,
    ) as SyncedBaseModel;
    return capabilities.reasoning ? factored : omitInheritedReasoningOptions(factored, baseModel);
  }

  // Only a model that already has a local TOML reaches this branch: creates
  // are skipped without canonical metadata, so nothing here is invented.
  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    cost: z.object({ input: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`Neuralwatt model ${model.id} has incomplete local metadata required for sync`);
  }
  return values as SyncedFullModel;
}

// Always factor onto canonical metadata; fall back to an authored pointer we
// cannot re-derive, such as a canonical ID with a suffix the served ID drops.
function baseModelFor(model: NeuralwattModel, authored: ExistingModel | undefined) {
  return resolveBaseModel(model) ?? authored?.base_model;
}

// The catalog rejects reasoning_options on a non-reasoning model, so a fast
// variant has to drop the options its canonical entry declares.
function omitInheritedReasoningOptions(factored: SyncedBaseModel, baseModel: string) {
  if (modelMetadata(baseModel).reasoning_options === undefined) return factored;
  const omit = factored.base_model_omit ?? [];
  if (omit.includes("reasoning_options")) return factored;
  return { ...factored, base_model_omit: [...omit, "reasoning_options"] };
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

// The API knows the effort ladder but never describes thinking_token_budget,
// so the budget control comes from the provider docs and authored min/max is
// carried over.
function reasoningOptions(
  model: NeuralwattModel,
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const authoredOptions = authored?.reasoning_options ?? [];
  const efforts = model.metadata.reasoning?.supported_efforts;
  const values = (efforts ?? [])
    .filter((effort): effort is Effort => EFFORT_VALUES.includes(effort as Effort));
  const options: NonNullable<SyncedFullModel["reasoning_options"]> = authoredOptions
    .filter((option) => option.type !== "effort");

  if (values.length > 0) {
    options.unshift({ type: "effort", values });
  } else if (efforts === undefined) {
    // No reasoning block at all is silence, not "this model has no effort
    // levels", so an authored ladder is kept rather than deleted.
    const authoredEffort = authoredOptions.find((option) => option.type === "effort");
    if (authoredEffort !== undefined) options.unshift(authoredEffort);
  }

  if (
    !BUDGET_REJECTORS.has(strip(model.id, TIER_SUFFIX))
    && !options.some((option) => option.type === "budget_tokens")
  ) {
    options.push({ type: "budget_tokens" });
  }
  return options;
}

// The API is authoritative for pricing, but a partial payload must never be
// published as free: keep the authored cost until real numbers come back.
function buildCost(
  model: NeuralwattModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] | undefined {
  const { pricing } = model.metadata;
  const flex = model.id.endsWith("-flex");
  const input = price(pricing.input_per_million, flex);
  const output = price(pricing.output_per_million, flex);

  if (pricing.pricing_tbd === true || input === undefined || output === undefined) {
    return existing?.cost;
  }
  return { input, output, cache_read: price(pricing.cached_input_per_million, flex) };
}

// toPrecision drops the float error in products like 4.5 * 0.65.
function price(value: number | null | undefined, flex: boolean) {
  if (value == null) return undefined;
  return flex ? Number((value * FLEX_MULTIPLIER).toPrecision(12)) : value;
}
