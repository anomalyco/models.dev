import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { labEffortValues } from "./aimlapi.js";
import {
  factorBaseModel,
  modelMetadata,
  resolveCanonicalBaseModel,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// SovereignEG's model list needs an API key, so the sync reads
// SOVEREIGNEG_API_KEY. The same data is public as HTML at
// https://sovereigneg.com/models, but there is no public JSON endpoint.
const API_ENDPOINT = "https://backend.sovereigneg.com/v1/models";

// SovereignEG bills in Egyptian pounds and publishes EGP prices only. It sets
// the EGP prices of relayed models from their USD rate at an exchange rate it
// refreshes from this feed, so dividing by the same feed's rate gives the USD
// equivalent of what a customer pays.
const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

// The pound has traded between about 15 and 55 per dollar since 2020. A rate
// far outside that is a broken feed, not a price change.
const MIN_EGP_PER_USD = 10;
const MAX_EGP_PER_USD = 500;

// The platform reprices within about two hours of a rate move, so a USD
// equivalent computed between the two refreshes drifts by a fraction of a
// percent. An authored price within this band of the new one is kept, so the
// daily rate change does not rewrite every file.
const PRICE_TOLERANCE = 0.02;

// Egypt-hosted routes whose IDs don't resolve by name.
const BASE_MODELS: Record<string, string> = {
  "SovereignEG/Qwen3.8-27B-FP8": "alibaba/qwen3.8-27b",
};

const TokenLimit = z.number().int().positive().nullish();
const Price = z.number().nonnegative().nullish();

export const SovereignEGModel = z.object({
  id: z.string().min(1),
  display_name: z.string().nullish(),
  provider_handle: z.string().nullish(),
  modality: z.string().nullish(),
  status: z.string().nullish(),
  visibility: z.string().nullish(),
  context_window: TokenLimit,
  max_output_tokens: TokenLimit,
  deprecated_at: z.string().nullish(),
  pricing: z.object({
    input_per_1m_egp: Price,
    output_per_1m_egp: Price,
    cache_read_per_1m_egp: Price,
    cache_write_per_1m_egp: Price,
  }).passthrough().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  input_modalities: z.array(z.string()).nullish(),
  output_modalities: z.array(z.string()).nullish(),
}).passthrough();

export const SovereignEGResponse = z.object({
  data: z.array(SovereignEGModel).min(1, "SovereignEG returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "SovereignEG returned duplicate model IDs",
);

export const ExchangeRateResponse = z.object({
  result: z.literal("success"),
  rates: z.object({
    EGP: z.number().finite().min(MIN_EGP_PER_USD).max(MAX_EGP_PER_USD),
  }).passthrough(),
}).passthrough();

export const SovereignEGSource = z.object({
  catalog: SovereignEGResponse,
  egp_per_usd: z.number().finite().min(MIN_EGP_PER_USD).max(MAX_EGP_PER_USD),
});

export type SovereignEGModel = z.infer<typeof SovereignEGModel> & { egp_per_usd: number };

// OpenCode needs tool calls, so only live, public chat routes that accept
// `tools` are catalogued. Embedding, image, rerank and decision routes are
// left for hand-authored files.
function publicChatRoute(model: SovereignEGModel) {
  return model.modality === "chat"
    && model.status === "live"
    && model.visibility !== "private"
    && model.supported_parameters?.includes("tools") === true;
}

export const sovereigneg = {
  id: "sovereigneg",
  name: "SovereignEG",
  modelsDir: "providers/sovereigneg/models",
  preserveDescriptions: false,
  authoritativeHeaders: true,
  // A route without a lab entry needs lab metadata researched by hand. It is
  // reported in the sync notices rather than opened as one issue per route.
  trackMissingModels: false,
  fetchModels: fetchSovereignEGModels,
  parseModels(raw) {
    const source = SovereignEGSource.parse(raw);
    return source.catalog.data.map((model) => ({ ...model, egp_per_usd: source.egp_per_usd }));
  },
  sourceID(model) {
    return publicChatRoute(model) ? model.id : undefined;
  },
  missingModelID(model) {
    return publicChatRoute(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `SovereignEG chat models awaiting a lab base, a price or a context window: ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    if (!publicChatRoute(model)) return undefined;
    const pricing = model.pricing;
    if (
      model.context_window == null
      || pricing?.input_per_1m_egp == null || pricing.output_per_1m_egp == null
    ) return undefined;

    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    const baseModel = authored?.base_model ?? resolveSovereignEGBaseModel(model);
    if (baseModel === undefined) return undefined;

    const parameters = model.supported_parameters ?? [];
    // The catalog lists input kinds ("image"), not formats, so the lab's MIME
    // types are inherited. Only a text-only route of a multimodal lab model is
    // an override.
    const textOnly = model.input_modalities != null
      && model.input_modalities.length > 0
      && model.input_modalities.every((value) => value.toLowerCase() === "text");
    const limit = { context: model.context_window, output: model.max_output_tokens ?? undefined };

    const translated = factorBaseModel(baseModel, {
      // `display_name` is often the route ID, so the lab's name is inherited
      // and only a hand-authored name is kept.
      name: authored?.name,
      attachment: textOnly ? false : undefined,
      tool_call: true,
      reasoning_options: reasoningOptions(model, baseModel, authored),
      temperature: parameters.includes("temperature"),
      structured_output: parameters.includes("structured_outputs") || undefined,
      status: model.deprecated_at != null ? "deprecated" : existing?.status,
      cost: {
        input: usd(pricing.input_per_1m_egp, model.egp_per_usd, existing?.cost?.input),
        output: usd(pricing.output_per_1m_egp, model.egp_per_usd, existing?.cost?.output),
        cache_read: pricing.cache_read_per_1m_egp == null
          ? undefined
          : usd(pricing.cache_read_per_1m_egp, model.egp_per_usd, existing?.cost?.cache_read),
        cache_write: pricing.cache_write_per_1m_egp == null
          ? undefined
          : usd(pricing.cache_write_per_1m_egp, model.egp_per_usd, existing?.cost?.cache_write),
      },
      limit,
      modalities: textOnly ? { input: ["text"] } : undefined,
    }, limit, authored?.base_model_omit);

    return {
      id: model.id,
      model: translated,
      header: HEADER,
    };
  },
} satisfies SyncProvider<SovereignEGModel>;

// The header carries no rate or EGP figure: either would change on every run
// and rewrite every file.
const HEADER = [
  "# Generated by bun models:sync sovereigneg from https://backend.sovereigneg.com/v1/models.",
  "# SovereignEG bills in EGP. Prices are the EGP list prices (https://sovereigneg.com/pricing) converted to USD",
  "# at the market rate from https://open.er-api.com/v6/latest/USD; lab facts are inherited via base_model.",
  "# Effort, where listed: top-level reasoning_effort on Chat Completions.",
  "",
].join("\n");

/**
 * SovereignEG IDs are bare (`claude-sonnet-5.5`, `gpt-5.1`) and the catalog
 * names the lab in `provider_handle`, so the lab-qualified ID is tried first
 * and a bare ID only resolves when its filename is unique across every lab.
 */
export function resolveSovereignEGBaseModel(model: Pick<SovereignEGModel, "id" | "provider_handle">) {
  const explicit = BASE_MODELS[model.id];
  if (explicit !== undefined) return explicit;
  const bare = model.id.split("/").at(-1)!;
  const handle = model.provider_handle?.trim();
  if (handle) {
    const routed = resolveCanonicalBaseModel(`${handle}/${bare}`);
    if (routed !== undefined) return routed;
  }
  return resolveModelMetadataBaseModel(bare);
}

/**
 * USD per million tokens for an EGP price, to three significant figures. An
 * authored price within PRICE_TOLERANCE of the result is kept.
 */
export function usd(egp: number, egpPerUsd: number, authored?: number) {
  if (egp === 0) return 0;
  const value = Number((egp / egpPerUsd).toPrecision(3));
  if (authored !== undefined && authored > 0 && Math.abs(authored - value) / value <= PRICE_TOLERANCE) {
    return authored;
  }
  return value;
}

/**
 * The catalog says whether a route accepts `reasoning_effort` but not which
 * levels, so the levels come from the lab's own provider entry. Authored
 * controls are left alone (the runner keeps them). A new reasoning route
 * without a lab ladder is not created with invented levels.
 */
function reasoningOptions(
  model: SovereignEGModel,
  baseModel: string,
  authored: ExistingModel | undefined,
): SyncedModel["reasoning_options"] {
  if (authored?.reasoning_options !== undefined) return undefined;
  if (modelMetadata(baseModel).reasoning !== true) return undefined;
  if (!model.supported_parameters?.includes("reasoning_effort")) return [];
  const effort = ReasoningOption.safeParse({ type: "effort", values: labEffortValues(baseModel) });
  if (!effort.success || effort.data.type !== "effort" || effort.data.values.length === 0) {
    throw new MissingReasoningOptionsError(
      model.id,
      `reasoning model (base ${baseModel}) that accepts reasoning_effort on SovereignEG, but the lab publishes`
        + " no effort levels to copy; probe the route and author its reasoning_options by hand",
    );
  }
  return [effort.data];
}

export async function fetchSovereignEGModels(fetcher: typeof fetch = fetch) {
  const apiKey = process.env.SOVEREIGNEG_API_KEY;
  if (!apiKey) {
    throw new Error("SOVEREIGNEG_API_KEY is required: SovereignEG's /v1/models rejects unauthenticated requests");
  }
  const [catalog, rate] = await Promise.all([
    fetcher(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    }),
    fetcher(FX_ENDPOINT, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!catalog.ok) {
    throw new Error(`SovereignEG catalog request failed: ${catalog.status} ${catalog.statusText}`);
  }
  if (!rate.ok) {
    throw new Error(`SovereignEG exchange rate request failed: ${rate.status} ${rate.statusText}`);
  }
  return {
    catalog: SovereignEGResponse.parse(await catalog.json()),
    egp_per_usd: ExchangeRateResponse.parse(await rate.json()).rates.EGP,
  };
}
