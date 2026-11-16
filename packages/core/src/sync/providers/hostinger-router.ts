import { z } from "zod";

import { describeModel } from "../../describe.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// Hostinger Router publishes its catalog without authentication.
const API_ENDPOINT = "https://router.hostinger.com/v1/models";

// Catalog prices are credits per token; billing is USD at 1 credit = $0.01,
// and this catalog keeps USD per million tokens.
const CREDITS_TO_USD_PER_MILLION = 10_000;

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];

function modalities(values: string[] | null | undefined): Modality[] {
  const allowed = new Set<string>(MODALITIES);
  const result = (values ?? []).filter((value): value is Modality => allowed.has(value));
  return result.length > 0 ? [...new Set(result)] : ["text"];
}

const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] as const;
type EffortValue = (typeof EFFORT_VALUES)[number];

function effortValues(values: unknown[]): EffortValue[] {
  const allowed = new Set<string>(EFFORT_VALUES);
  return values.filter((value): value is EffortValue => typeof value === "string" && allowed.has(value));
}

const CHAT_ENDPOINTS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"];
const EMBEDDING_ENDPOINT = "/v1/embeddings";
const REGION_PIN = /-(eu|us)$/;

const TOGGLE_HEADER =
  '# Toggle: reasoning = {"enabled": true|false} (catalog supported_parameters: reasoning)\n';
const EFFORT_HEADER =
  "# Effort: reasoning_effort (catalog supported_parameters: reasoning_effort)\n";

const HostingerPricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  input_cache_write_1h: z.string().optional(),
}).passthrough();

const HostingerModel = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  name: z.string().optional(),
  context_length: z.number().int().nonnegative(),
  max_input_tokens: z.number().int().positive().nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  pricing: HostingerPricing,
  supported_parameters: z.array(z.string()).nullish(),
  supported_endpoints: z.array(z.string()).nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
  }).nullish(),
}).passthrough();

export type HostingerModel = z.infer<typeof HostingerModel>;

const HostingerResponse = z.object({
  object: z.literal("list"),
  data: z.array(HostingerModel),
}).passthrough();

export const hostingerRouter = {
  id: "hostinger-router",
  name: "Hostinger Router",
  modelsDir: "providers/hostinger-router/models",
  // New models are curated by hand: reasoning controls need host-specific
  // verification, so mass creation from the flat catalog would invent data
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Hostinger Router models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = HostingerResponse.parse(raw).data;
    // Fail closed on a truncated catalog: with deleteMissing enabled, a short
    // read would otherwise wipe the curated files. The full catalog is ~149 rows
    if (models.length < 50) {
      throw new Error(`Hostinger Router catalog looks truncated: only ${models.length} models`);
    }
    return models;
  },
  translateModel(model, context) {
    const translated = buildHostingerModel(model, context.existing(model.id), context.authored(model.id));
    if (translated === undefined) return undefined;
    const options = "reasoning_options" in translated ? translated.reasoning_options : undefined;
    const header = options?.some((option) => option.type === "toggle")
      ? TOGGLE_HEADER + (options.some((option) => option.type === "effort") ? EFFORT_HEADER : "")
      : options?.some((option) => option.type === "effort")
        ? EFFORT_HEADER
        : undefined;
    return { id: model.id, model: translated, header };
  },
  sourceID(model) {
    return skippable(model) ? undefined : model.id;
  },
} satisfies SyncProvider<HostingerModel>;

function skippable(model: HostingerModel): boolean {
  // Region-pinned variants duplicate the base model at a markup
  if (REGION_PIN.test(model.id)) return true;
  const endpoints = model.supported_endpoints ?? [];
  return !endpoints.some((endpoint) => CHAT_ENDPOINTS.includes(endpoint) || endpoint === EMBEDDING_ENDPOINT);
}

export function buildHostingerModel(
  model: HostingerModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined,
): SyncedModel | undefined {
  if (skippable(model)) return undefined;

  const endpoints = new Set(model.supported_endpoints ?? []);
  const params = new Set(model.supported_parameters ?? []);
  const embeddingOnly = !CHAT_ENDPOINTS.some((endpoint) => endpoints.has(endpoint));
  // Dimensions are unknowable from the catalog, so embedding entries stay curated
  if (embeddingOnly && existing === undefined && authored === undefined) return undefined;

  const canonical = existing?.base_model ?? resolveHostingerBaseModel(model.id);
  const base = canonical === undefined ? undefined : modelMetadata(canonical);
  const sourceReasoning = params.has("reasoning") || params.has("reasoning_effort");
  const reasoning = canonical === undefined ? sourceReasoning : existing?.reasoning ?? sourceReasoning;

  // Reasoning controls come from authored files first, then the lab baseline
  // intersected with the catalog's supported_parameters; when a reasoning model
  // has neither, fail closed so the authored file survives and the gap is reported
  let reasoningOptions = existing?.reasoning_options ?? labReasoningOptions(base, params);
  if (reasoningOptions === undefined && sourceReasoning && !embeddingOnly) {
    if (reasoning) {
      throw new MissingReasoningOptionsError(
        model.id,
        "catalog lists reasoning parameters but no authored or lab controls resolve",
      );
    }
    reasoningOptions = undefined;
  }

  // Rows with max_output_tokens equal to the context window carry a catalog
  // data error; inherit the lab/authored output limit instead
  const guardedOutput = model.max_output_tokens !== null && model.max_output_tokens !== undefined
    && model.max_output_tokens < model.context_length
    ? model.max_output_tokens
    : (authored?.limit?.output ?? existing?.limit?.output);
  const outputLimit = embeddingOnly
    ? (authored?.limit?.output ?? existing?.limit?.output)
    : (guardedOutput ?? (canonical === undefined ? model.context_length : undefined));
  const limit: { context: number; input?: number; output?: number } = { context: model.context_length };
  // input equal to context is noise, not a constraint
  if (model.max_input_tokens != null && model.max_input_tokens < model.context_length) {
    limit.input = model.max_input_tokens;
  }
  if (outputLimit !== undefined) limit.output = outputLimit;

  const promptPrice = Number(model.pricing.prompt);
  const cacheWrite = model.pricing.input_cache_write === undefined ? undefined : Number(model.pricing.input_cache_write);
  const cost: NonNullable<SyncedFullModel["cost"]> = {
    input: usdRequired(model.pricing.prompt),
    output: usdRequired(model.pricing.completion),
  };
  const cacheRead = usd(model.pricing.input_cache_read) ?? existing?.cost?.cache_read;
  if (cacheRead !== undefined) cost.cache_read = cacheRead;
  // The router fills cache_write with the plain input price when caching is unpriced
  const cacheWriteUsd = cacheWrite === undefined || cacheWrite === promptPrice
    ? existing?.cost?.cache_write
    : usd(model.pricing.input_cache_write);
  if (cacheWriteUsd !== undefined) cost.cache_write = cacheWriteUsd;
  if (existing?.cost?.reasoning !== undefined) cost.reasoning = existing.cost.reasoning;
  if (existing?.cost?.tiers !== undefined) cost.tiers = existing.cost.tiers;

  const mods: { input: Modality[]; output: Modality[] } = {
    input: modalities(model.architecture?.input_modalities),
    output: modalities(model.architecture?.output_modalities),
  };
  // attachment from the catalog's probed-types architecture field would stamp
  // false over lab capabilities (PDF/vision pass through), so authored wins
  const attachment = existing?.attachment ?? (!embeddingOnly
    && (model.architecture?.input_modalities ?? ["text"]).some((value) => value !== "text" && MODALITIES.includes(value as Modality)));
  const toolCall = !embeddingOnly && params.has("tools");
  const structuredOutput = !embeddingOnly && params.has("structured_outputs");
  const temperature = !embeddingOnly && (existing?.temperature ?? params.has("temperature"));

  // Modalities are inherited from the lab for factored models: the catalog's
  // architecture field lists only probed types (e.g. no pdf), while probes show
  // the lab features (PDF, vision) pass through
  const shared: Parameters<typeof factorBaseModel>[1] = {
    attachment,
    reasoning: embeddingOnly ? false : reasoning,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    status: existing?.status,
    interleaved: existing?.interleaved,
    limit,
    cost,
    ...(!embeddingOnly && reasoningOptions !== undefined && { reasoning_options: reasoningOptions }),
    ...(canonical === undefined && !embeddingOnly && { modalities: mods }),
  };

  if (canonical !== undefined) {
    return factorBaseModel(canonical, {
      description: existing?.description,
      ...shared,
    }, limit, existing?.base_model_omit);
  }

  const family = existing?.family;
  return {
    name: existing?.name ?? model.name ?? model.id,
    description: existing?.description ?? describeModel({
      id: model.id,
      name: model.name ?? model.id,
      family,
      reasoning: embeddingOnly ? false : reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: mods,
    }),
    family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    attachment,
    reasoning: embeddingOnly ? false : reasoning,
    temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    limit: { ...limit, output: limit.output ?? model.context_length },
    cost,
    ...(!embeddingOnly && reasoningOptions !== undefined && { reasoning_options: reasoningOptions }),
    modalities: mods,
    ...(existing?.status !== undefined && { status: existing.status }),
    ...(existing?.interleaved !== undefined && { interleaved: existing.interleaved }),
  } satisfies SyncedFullModel;
}

type LabModel = ReturnType<typeof modelMetadata>;

function labReasoningOptions(
  base: LabModel | undefined,
  params: Set<string>,
): SyncedFullModel["reasoning_options"] {
  if (base === undefined) return undefined;
  const lab = (base as Record<string, unknown>).reasoning_options;
  if (!Array.isArray(lab)) return undefined;
  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  for (const option of lab as Array<Record<string, unknown>>) {
    if (option?.type === "toggle" && params.has("reasoning")) options.push({ type: "toggle" });
    if (option?.type === "effort" && params.has("reasoning_effort") && Array.isArray(option.values)) {
      const values = effortValues(option.values);
      if (values.length > 0) options.push({ type: "effort", values });
    }
  }
  return options.length > 0 ? options : undefined;
}

function resolveHostingerBaseModel(modelID: string) {
  const direct = resolveModelMetadataBaseModel(modelID);
  if (direct !== undefined) return direct;
  // Anthropic lab IDs use dashes where the router uses dots (claude-haiku-4.5 -> claude-haiku-4-5)
  const dashed = modelID.replace(/(\d+)\.(\d+)/g, "$1-$2");
  if (dashed !== modelID) return resolveModelMetadataBaseModel(dashed);
  return undefined;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function usd(value: string | undefined) {
  if (value === undefined) return undefined;
  return usdRequired(value);
}

function usdRequired(value: string) {
  return Math.round(Number(value) * CREDITS_TO_USD_PER_MILLION * 1_000) / 1_000;
}
