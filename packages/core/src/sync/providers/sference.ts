import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

// The OpenAI-compatible /v1/models endpoint is public (auth-optional): anonymous
// callers get the platform_status=available catalog with per-1M-token USD
// pricing, so no SFERENCE_API_KEY is required for sync. A key, when set, only
// unlocks private BYOM models and per-user pricing overrides.
const API_ENDPOINT = "https://api.sference.com/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

// Map the org prefix in sference model IDs (e.g. "zai-org/GLM-5.2") to the
// models.dev metadata provider namespace where the canonical entry lives. Only
// non-identity mappings are listed; an org absent here falls back to itself.
const ORG_TO_MODEL_PROVIDER: Record<string, string | undefined> = {
  Qwen: "alibaba",
  "zai-org": "zhipuai",
  MiniMaxAI: "minimax",
  "deepseek-ai": "deepseek",
  "meta-llama": "meta",
};

const CapabilityFlag = z
  .object({
    supported: z.boolean().default(false),
  })
  .passthrough();

const ThinkingCapability = z
  .object({
    supported: z.boolean().default(false),
    types: z
      .object({
        enabled: CapabilityFlag.optional(),
        adaptive: CapabilityFlag.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ModelCapabilities = z
  .object({
    image_input: CapabilityFlag.optional(),
    pdf_input: CapabilityFlag.optional(),
    thinking: ThinkingCapability.optional(),
    tools: CapabilityFlag.optional(),
  })
  .passthrough();

const Pricing = z
  .object({
    input_per_million_usd: z.number().nullable().optional(),
    output_per_million_usd: z.number().nullable().optional(),
    cached_input_per_million_usd: z.number().nullable().optional(),
  })
  .passthrough();

export const SferenceModel = z
  .object({
    id: z.string(),
    object: z.literal("model").default("model"),
    created: z.number(),
    owned_by: z.string().default("sference"),
    display_name: z.string(),
    provider: z.string().nullable().optional(),
    modality: z.enum(["text_generation", "text_embedding"]).default("text_generation"),
    capabilities: ModelCapabilities.optional(),
    context_tokens: z.number().int().nullable().optional(),
    // Per-1M-token USD pricing (nullable when a model has no list price).
    pricing: Pricing.nullable().optional(),
    // Maximum output tokens the platform enforces (nullable when no catalog
    // metadata); the sync writes it as an authoritative limit.output override.
    max_output_tokens: z.number().int().nullable().optional(),
    // ISO 8601 release date (YYYY-MM-DD), curated per model; distinct from
    // `created`, which is just int(time.time()) for cache-busting.
    released: z.string().nullable().optional(),
  })
  .passthrough();

export const SferenceResponse = z
  .object({
    object: z.literal("list").default("list"),
    data: z.array(SferenceModel),
  })
  .passthrough();

export type SferenceModel = z.infer<typeof SferenceModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

export const sference = {
  id: "sference",
  name: "sference",
  modelsDir: "providers/sference/models",
  async fetchModels() {
    // The /v1/models endpoint is public (auth-optional): models.dev only ever
    // syncs the public catalog, so no SFERENCE_API_KEY is needed.
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`sference /v1/models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return SferenceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // The public endpoint already filters to available models and excludes
    // embeddings from the chat catalog; skip any remaining embedding rows.
    if (model.modality === "text_embedding") return undefined;

    const existing = context.existing(model.id);
    return {
      id: model.id,
      model: buildSferenceModel(model, existing, resolveBaseModel(model.id)),
    };
  },
} satisfies SyncProvider<SferenceModel>;

export function buildSferenceModel(
  model: SferenceModel,
  existing: ExistingModel | undefined,
  baseModel: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const caps = model.capabilities ?? {};
  const thinking = caps.thinking?.supported === true;
  const tools = caps.tools?.supported === true;
  const imageInput = caps.image_input?.supported === true;
  const pdfInput = caps.pdf_input?.supported === true;

  // The catalog exposes an `enable_thinking` toggle (thinking.types.enabled)
  // and the API accepts OpenAI `reasoning_effort` / `reasoning.effort`, but
  // the catalog does not surface which effort levels each model acts on — and
  // a silently-dropped level is not a supported control. Effort is therefore
  // hand-authored per model: preserve any hand-authored reasoning_options and
  // default new reasoning models to a toggle (the documented
  // enable_thinking = true|false control).
  const reasoningOptions = thinking
    ? (existing?.reasoning_options ?? [{ type: "toggle" as const }])
    : undefined;

  // The public /v1/models endpoint exposes context_tokens, max_output_tokens,
  // released, and capabilities. For factored models, only API-authoritative
  // values are written as overrides; fields the API omits (input limit, full
  // modality arrays, knowledge) inherit from base_model metadata. Setting a
  // field to undefined lets factorBaseModel strip it so it inherits from base.
  const contextTokens = model.context_tokens ?? 0;
  const apiContext = contextTokens > 0 ? contextTokens : undefined;
  const apiOutput = model.max_output_tokens ?? undefined;
  // `limit` for factorBaseModel must be a complete ProviderModelLimit; the
  // values.limit below carries only the API-authoritative overrides so missing
  // fields (output, input) inherit from base metadata instead of being zeroed.
  const limit = {
    context: apiContext ?? existing?.limit?.context ?? 0,
    input: existing?.limit?.input,
    output: apiOutput ?? existing?.limit?.output ?? 0,
  };
  const valuesLimit: Partial<SyncedFullModel["limit"]> = {
    context: apiContext,
    input: existing?.limit?.input,
    output: apiOutput ?? existing?.limit?.output,
  };

  // Pricing is already per-1M-token USD — no conversion needed. A free model
  // surfaces a pricing block with zeros; a model with no list price omits it.
  const pricing = model.pricing;
  const inputCost = pricing?.input_per_million_usd;
  const outputCost = pricing?.output_per_million_usd;
  const cacheRead = pricing?.cached_input_per_million_usd;
  const cost = pricing != null
    ? {
        input: inputCost ?? 0,
        output: outputCost ?? 0,
        cache_read: cacheRead != null && cacheRead > 0 ? cacheRead : undefined,
      }
    : existing?.cost;

  const name = existing?.name ?? model.display_name;

  // sference serves open-weight checkpoints; the catalog does not flag weights
  // per model, so inherit from existing or default to open weights.
  const openWeights = existing?.open_weights ?? true;

  // /v1/models surfaces image/pdf via capabilities but not full modality arrays.
  // For factored models the richer base metadata wins (leave input undefined so
  // it inherits); for inline models derive what the API exposes plus any extra
  // existing modalities.
  const apiInput: Modality[] = [
    "text",
    ...(imageInput ? (["image"] as Modality[]) : []),
    ...(pdfInput ? (["pdf"] as Modality[]) : []),
  ];
  const inheritedInput = existing?.modalities?.input ?? [];
  const input = baseModel == null
    ? [...new Set([...apiInput, ...inheritedInput.filter((m) => m !== "text")])]
    : undefined;
  const attachment = baseModel == null
    ? apiInput.some((value) => value !== "text") || (existing?.attachment ?? false)
    : existing?.attachment;

  // `created` is the current request time (int(time.time())), not the model
  // release date, so it is not a useful release_date source. The catalog's
  // `released` field (ISO YYYY-MM-DD) is the authoritative release date; when
  // absent, factored models inherit it from base metadata and inline models
  // default to today. `last_updated` is not exposed by the API, so preserve any
  // hand-authored value or default to today for inline models.
  const apiReleased = model.released ?? undefined;
  const values: Partial<SyncedFullModel> = {
    name,
    description: existing?.description ?? (baseModel == null ? describeModel({
      id: model.id,
      name,
      family: inferFamily(model.id, name) ?? existing?.family,
      reasoning: thinking,
      tool_call: tools,
      structured_output: existing?.structured_output,
      open_weights: openWeights,
      limit,
      modalities: { input: apiInput, output: ["text"] },
    }) : undefined),
    family: baseModel == null ? inferFamily(model.id, name) ?? existing?.family : existing?.family,
    release_date: apiReleased ?? existing?.release_date ?? (baseModel == null ? today : undefined),
    last_updated: existing?.last_updated ?? (baseModel == null ? today : undefined),
    attachment,
    reasoning: thinking,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature,
    tool_call: tools,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: openWeights,
    status: existing?.status,
    // sference returns reasoning via the OpenAI-style reasoning_content field on
    // chat completions, so reasoning models declare an interleaved block.
    interleaved: thinking ? (existing?.interleaved ?? { field: "reasoning_content" as const }) : existing?.interleaved,
    cost,
    limit,
    modalities: input === undefined ? undefined : { input, output: ["text"] },
  };

  if (baseModel == null) return values as SyncedFullModel;
  // For factored models, swap in the partial limit so unset fields (output,
  // input) inherit from base metadata instead of being overridden with zeros.
  const factored = { ...values, limit: valuesLimit } as Partial<SyncedFullModel>;
  return factorBaseModel(baseModel, factored, limit, existing?.base_model_omit);
}

function resolveBaseModel(modelId: string): string | undefined {
  const [org, ...modelParts] = modelId.split("/");
  if (org === undefined || modelParts.length === 0) return undefined;
  // Use the explicit mapping when present, otherwise fall back to the org
  // name itself (identity mapping) so unmapped orgs still resolve.
  const provider = ORG_TO_MODEL_PROVIDER[org] ?? org;
  const lower = modelParts.join("/").toLowerCase();
  return [lower, lower.replace(/-turbo$/, "-it")]
    .map((candidate) => `${provider}/${candidate}`)
    .find(canonicalExists);
}

// existsSync is case-insensitive on macOS/Windows; verify the real on-disk
// filename so the resolved base_model matches the canonical metadata exactly.
function canonicalExists(candidate: string): boolean {
  const file = path.join(MODELS_DIR, `${candidate}.toml`);
  if (!existsSync(file)) return false;
  try {
    return readdirSync(path.dirname(file)).includes(path.basename(file));
  } catch {
    return false;
  }
}

function inferFamily(id: string, name: string) {
  const kimiFamily = inferKimiFamily(id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}
