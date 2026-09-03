import { z } from "zod";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const MODELS_ENDPOINT = "https://api.neosantara.xyz/v1/models";
const PRICING_ENDPOINT = "https://api.neosantara.xyz/v1/public/pricing";
const MIN_CONTEXT_WINDOW = 100_000;

const Pricing = z.object({
  currency: z.enum(["USD", "IDR"]),
  prompt: z.number().nonnegative().optional(),
  completion: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
}).passthrough();

export const NeosantaraModel = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.string(),
  description: z.string(),
  context_window: z.number().int().nonnegative().nullable(),
  max_output_tokens: z.number().int().nonnegative().nullable(),
  pricing: Pricing,
  discount: z.number().min(0).max(100).optional(),
  capabilities: z.array(z.string()),
  // Future-proofing: Neosantara does not publish per-model effort levels today. When it does,
  // this optional array is consumed automatically (see neosantaraReasoningEfforts).
  reasoning_efforts: z.array(z.string()).optional(),
  deprecated: z.boolean(),
  deprecation_alternatives: z.array(z.string()),
}).passthrough();

export const NeosantaraModelsResponse = z.object({
  object: z.literal("list"),
  data: z.array(NeosantaraModel),
}).passthrough();

const PublicPricing = z.object({
  currency: z.enum(["USD", "IDR"]).optional(),
  per_million_tokens: z.object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  }).optional(),
}).passthrough();

// Only `name` and `raw_pricing` are consumed. Everything else is descriptive and optional so a
// single omission cannot fail the whole catalog sync.
const PublicPricingModel = z.object({
  name: z.string(),
  capabilities: z.array(z.string()).optional(),
  context_window: z.number().int().nonnegative().nullable().optional(),
  description: z.string().optional(),
  raw_pricing: PublicPricing,
}).passthrough();

export const NeosantaraPricingResponse = z.object({
  data: z.array(PublicPricingModel),
  meta: z.object({
    count: z.number().int().nonnegative(),
    updated_at: z.string(),
    exchange_rate: z.object({
      usd_idr: z.number().positive(),
      currency: z.literal("IDR"),
      source: z.string(),
    }),
  }),
}).passthrough();

const NeosantaraCombinedResponse = z.object({
  models: z.unknown(),
  pricing: z.unknown(),
});

export type NeosantaraSourceModel = z.infer<typeof NeosantaraModel> & {
  exchange_rate: number;
  exchange_rate_source: string;
  exchange_rate_updated_at: string;
};

/**
 * Neosantara serves bare model ids, so the canonical metadata tree resolves most of them on
 * its own and newly launched models are picked up without a code change. Only ids the tree
 * cannot resolve are aliased here (renamed generations, aliases pointing at another model,
 * and vendor-specific suffixes).
 */
const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-3-haiku": "anthropic/claude-3-haiku-20240307",
  "claude-4.5-opus": "anthropic/claude-opus-4-5",
  "claude-4.5-sonnet": "anthropic/claude-sonnet-4-5",
  "claude-opus-7": "anthropic/claude-opus-4-7",
  "claude-opus-8": "anthropic/claude-opus-4-8",
  "devstral-2": "mistral/devstral-2512",
  // Neosantara routes its coding alias at Grok 4.3.
  "grok-code-fast": "xai/grok-4.3",
  "qwen3-235b-wse": "alibaba/qwen3-235b-a22b-instruct-2507",
};

export function resolveNeosantaraBaseModel(id: string) {
  return BASE_MODEL_ALIASES[id] ?? resolveModelMetadataBaseModel(id);
}

export function mergeNeosantaraCatalogs(
  models: z.infer<typeof NeosantaraModelsResponse>,
  pricing: z.infer<typeof NeosantaraPricingResponse>,
): NeosantaraSourceModel[] {
  const modelPricing = new Map(models.data.map((model) => [model.id, model.pricing] as const));
  const publicPricing = new Map(pricing.data.map((model) => {
    const raw = model.raw_pricing;
    const tokens = raw.per_million_tokens;
    // Cache rates may only be surfaced by /v1/models. Inherit them so publishing does not
    // silently drop cost data, but never across a currency change: the two figures would
    // otherwise be mixed into one scale.
    const fallback = modelPricing.get(model.name);
    const cache = fallback?.currency === raw.currency ? fallback : undefined;
    const normalized =
      raw.currency === undefined || tokens?.input === undefined || tokens.output === undefined
        ? undefined
        : {
            currency: raw.currency,
            prompt: tokens.input,
            completion: tokens.output,
            cache_read: tokens.cache_read ?? cache?.cache_read,
            cache_write: tokens.cache_write ?? cache?.cache_write,
          };
    return [model.name, normalized] as const;
  }));
  return models.data.map((model) => ({
    ...model,
    pricing: publicPricing.get(model.id) ?? model.pricing,
    exchange_rate: pricing.meta.exchange_rate.usd_idr,
    exchange_rate_source: pricing.meta.exchange_rate.source,
    exchange_rate_updated_at: pricing.meta.updated_at,
  }));
}

type ReasoningControls = NonNullable<SyncedFullModel["reasoning_options"]>;

/**
 * Reasoning controls (AGENTS.md → "Reasoning options").
 *
 * Neosantara is a relay. It normalizes every upstream model's reasoning onto a single
 * OpenAI-compatible `reasoning_effort` field and maps each native shape (Anthropic thinking
 * budgets, DeepSeek/GLM toggles, OpenAI effort, …) behind it, so a caller never sends an
 * upstream-native control here. Its catalog advertises only *whether* a model reasons, never
 * per-model effort granularity, so this module does not derive per-model control sets from lab
 * or peer files — every reasoning-capable model advertises the host's accepted effort enum.
 *
 * `HOST_EFFORTS` is a host fact (the request schema's enum), not a per-model choice. Verified
 * live via the AI SDK: `max` is rejected (HTTP 400: `none|minimal|low|medium|high|xhigh`) while
 * those six are accepted. `none` is the off value for models that support switching reasoning
 * off; always-on models ignore it upstream but still accept it on the wire.
 *
 * Future-proof: if the catalog begins publishing per-model effort levels (optional
 * `reasoning_efforts`), they are honored automatically after filtering to the host enum;
 * until then the full enum is advertised. New models — reasoning or not — need no code change.
 */
const HOST_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const HOST_EFFORT_SET: ReadonlySet<string> = new Set(HOST_EFFORTS);

/**
 * Leading note stamped on every generated reasoning TOML. It exists so a reviewer comparing
 * this file to the model's own lab entry or another provider understands the divergence: the
 * effort list is Neosantara's mapped request surface, not the upstream provider's native API.
 */
const REASONING_NOTE = `# Reasoning: Neosantara relays this model and normalizes reasoning onto a
# single OpenAI-compatible \`reasoning_effort\` field, mapping the upstream model's native shape
# (Anthropic thinking budget, DeepSeek/GLM toggle, OpenAI effort, …) behind it. The catalog
# advertises only that the model reasons, not its effort levels, so this entry lists the host's
# accepted effort enum rather than the upstream/lab control set. This is Neosantara's request
# surface, not the origin provider's API. https://docs.neosantara.xyz
`;

/**
 * Effort levels this host accepts for a model: catalog-advertised when present (future-proofing
 * for when Neosantara starts publishing them), otherwise the full host enum, because today the
 * catalog exposes reasoning capability but not grades.
 */
function neosantaraReasoningEfforts(model: NeosantaraSourceModel): string[] {
  const advertised = Array.isArray(model.reasoning_efforts)
    ? model.reasoning_efforts.filter(
        (effort): effort is string => typeof effort === "string" && HOST_EFFORT_SET.has(effort),
      )
    : [];
  return advertised.length > 0 ? advertised : [...HOST_EFFORTS];
}

/** Uniform for every reasoning-capable model, including relayed DeepSeek: the host maps effort,
 * so the same request surface applies regardless of the upstream provider's native control. */
export function neosantaraReasoningControls(model: NeosantaraSourceModel): ReasoningControls {
  return [{ type: "effort", values: neosantaraReasoningEfforts(model) as never }];
}

/** Reasoning TOMLs carry the note above; non-reasoning models carry none. */
export function neosantaraReasoningHeader(controls: ReasoningControls | undefined) {
  return controls === undefined ? undefined : REASONING_NOTE;
}


/** Image models are priced per image and carry no context window, so they skip the token filters. */
function isImageModel(model: NeosantaraSourceModel) {
  return model.capabilities.includes("image_generation");
}

/** Display names for ids whose canonical entry is a different model (see BASE_MODEL_ALIASES). */
const NAME_OVERRIDES: Record<string, string> = {
  "grok-code-fast": "Grok Code Fast",
};

/** Leading provenance for prices converted from IDR into models.dev's required USD units. */
export function neosantaraFxHeader(model: NeosantaraSourceModel) {
  if (model.pricing.currency !== "IDR") return undefined;
  const date = model.exchange_rate_updated_at.slice(0, 10);
  const source = model.exchange_rate_source.replace(/[\r\n]+/g, " ");
  return `# FX: IDR prices converted to USD at 1 USD = ${model.exchange_rate} IDR` +
    ` (${source}, ${date}).\n`;
}

function neosantaraModelHeader(
  model: NeosantaraSourceModel,
  controls: ReasoningControls | undefined,
) {
  const headers = [
    neosantaraFxHeader(model),
    controls === undefined ? undefined : neosantaraReasoningHeader(controls),
  ].filter((header): header is string => header !== undefined);
  return headers.length === 0 ? undefined : headers.join("");
}

/** Models this host publishes at all, regardless of whether we can translate them yet. */
export function meetsNeosantaraPublicFilter(model: NeosantaraSourceModel) {
  return (
    isImageModel(model) ||
    (model.context_window !== null &&
      model.context_window >= MIN_CONTEXT_WINDOW &&
      model.capabilities.includes("function_calling"))
  );
}

export function shouldSyncNeosantaraModel(model: NeosantaraSourceModel) {
  const baseModel = resolveNeosantaraBaseModel(model.id);
  if (model.deprecated || baseModel === undefined) return false;
  if (!meetsNeosantaraPublicFilter(model)) return false;
  if (isImageModel(model)) return true;
  // Skip rather than throw: one missing catalog field must cost a single model, not the run.
  if (model.pricing.prompt === undefined || model.pricing.completion === undefined) return false;
  return true;
}

function effectiveUsd(value: number | undefined, model: NeosantaraSourceModel) {
  if (value === undefined) return undefined;
  const usd = model.pricing.currency === "IDR" ? value / model.exchange_rate : value;
  const discount = model.discount === undefined ? 1 : (100 - model.discount) / 100;
  return Math.round(usd * discount * 1_000_000) / 1_000_000;
}

/** Input modalities this host accepts, derived from the advertised understanding capabilities. */
export function neosantaraInputModalities(capabilities: string[]) {
  return [
    "text" as const,
    ...(capabilities.includes("vision") ? (["image"] as const) : []),
    ...(capabilities.includes("video_understanding") ? (["video"] as const) : []),
  ];
}

export function buildNeosantaraModel(
  model: NeosantaraSourceModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const baseModel = resolveNeosantaraBaseModel(model.id);
  if (baseModel === undefined) {
    throw new Error(`No canonical base model mapping for Neosantara model '${model.id}'`);
  }

  const limit = {
    context: model.context_window ?? undefined,
  };

  // models.dev has no per-image cost field, so per-image pricing is left unpublished and
  // every other trait is inherited from the canonical lab entry.
  if (isImageModel(model)) {
    return factorBaseModel(
      baseModel,
      { status: model.deprecated ? "deprecated" : existing?.status },
      limit,
      existing?.base_model === baseModel ? existing.base_model_omit : undefined,
    );
  }

  // Capabilities come from this host's catalog, never from the lab entry: the gateway enforces
  // its own list and answers HTTP 400 when a request uses a capability the model does not
  // advertise here (`reasoning_effort` on a model without `reasoning`), no matter what the
  // underlying model can do elsewhere. Reading them live means a capability the host adds later
  // is picked up by the next sync with no code change.
  const reasoning = model.capabilities.includes("reasoning");
  const reasoningOptions = reasoning ? neosantaraReasoningControls(model) : undefined;
  const inputCost = effectiveUsd(model.pricing.prompt, model);
  const outputCost = effectiveUsd(model.pricing.completion, model);
  if (inputCost === undefined || outputCost === undefined) {
    throw new Error(`Missing token pricing for Neosantara model '${model.id}'`);
  }
  const cost = {
    input: inputCost,
    output: outputCost,
    cache_read: effectiveUsd(model.pricing.cache_read, model),
    cache_write: effectiveUsd(model.pricing.cache_write, model),
  };

  return factorBaseModel(
    baseModel,
    {
      name: NAME_OVERRIDES[model.id],
      reasoning,
      reasoning_options: reasoningOptions,
      // Reasoning is streamed back in `reasoning_content`, whichever lab built the model.
      interleaved: reasoning ? { field: "reasoning_content" as const } : undefined,
      attachment: model.capabilities.includes("vision"),
      tool_call: model.capabilities.includes("function_calling"),
      structured_output: model.capabilities.includes("json_mode"),
      modalities: {
        input: neosantaraInputModalities(model.capabilities),
        output: ["text"],
      },
      status: model.deprecated ? "deprecated" : existing?.status,
      limit,
      cost,
    },
    limit,
    existing?.base_model === baseModel ? existing.base_model_omit : undefined,
  );
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Neosantara request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const neosantara = {
  id: "neosantara",
  name: "Neosantara",
  modelsDir: "providers/neosantara/models",
  authoritativeHeaders: true,
  sourceID(model) {
    if (model.deprecated) return undefined;
    // Report anything the public filter accepts but translateModel skipped, whether the cause is
    // a missing canonical entry, unusable upstream pricing, or controls that still need review.
    return meetsNeosantaraPublicFilter(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Neosantara models were not created because they lack a canonical \`models/\` entry to inherit, because the Neosantara catalog reported no usable token pricing, or because their reasoning controls still need review against this host's request schema.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a `models/<provider>/<model>.toml` entry (and, for reasoning models, a reviewed control set) to include them in the next sync.",
    ];
  },
  async fetchModels() {
    const [models, pricing] = await Promise.all([
      fetchJson(MODELS_ENDPOINT),
      fetchJson(PRICING_ENDPOINT),
    ]);
    return { models, pricing };
  },
  parseModels(raw) {
    const combined = NeosantaraCombinedResponse.parse(raw);
    return mergeNeosantaraCatalogs(
      NeosantaraModelsResponse.parse(combined.models),
      NeosantaraPricingResponse.parse(combined.pricing),
    );
  },
  translateModel(model, context) {
    if (!shouldSyncNeosantaraModel(model)) return undefined;
    const translated = buildNeosantaraModel(model, context.existing(model.id));
    return {
      id: model.id,
      model: translated,
      header: neosantaraModelHeader(model, translated.reasoning_options),
    };
  },
} satisfies SyncProvider<NeosantaraSourceModel>;
