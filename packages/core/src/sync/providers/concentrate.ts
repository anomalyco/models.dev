import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.concentrate.ai/v1/models";
const DETAIL_CONCURRENCY = 12;

const Money = z.object({
  price: z.object({ USD: z.number().nonnegative() }).passthrough(),
  units: z.number().positive(),
}).passthrough();

const TokenCache = z.object({
  read: Money.optional(),
  write: z.object({ cache_write_tokens: Money.optional() }).passthrough().optional(),
}).passthrough();

const TokenTier = z.object({
  above: z.number().int().nonnegative(),
  input: Money,
  output: Money,
  cache: TokenCache.optional(),
}).passthrough();

const TokenPricing = z.object({
  input: Money,
  output: Money,
  cache: TokenCache.optional(),
  tiers: z.array(TokenTier).optional(),
}).passthrough();

const InputSupport = z.object({
  text: z.boolean().optional(),
  image: z.union([z.boolean(), z.record(z.boolean())]).optional(),
  file: z.union([z.boolean(), z.record(z.boolean())]).optional(),
}).passthrough();

const ProviderRoute = z.object({
  provider_slug: z.string(),
  pricing: z.object({ tokens: TokenPricing }).passthrough(),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  supports: z.object({
    input: InputSupport.optional(),
    reasoning: z.object({ effort: z.record(z.boolean()).optional() }).passthrough().optional(),
    temperature: z.boolean().optional(),
    text: z.object({
      format: z.object({
        json_schema: z.boolean().optional(),
        json_object: z.boolean().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
    tools: z.object({ function_calling: z.boolean().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

const EffortSupport = z.object({
  supported: z.boolean(),
  none: z.object({ supported: z.boolean() }).optional(),
  minimal: z.object({ supported: z.boolean() }).optional(),
  low: z.object({ supported: z.boolean() }).optional(),
  medium: z.object({ supported: z.boolean() }).optional(),
  high: z.object({ supported: z.boolean() }).optional(),
  xhigh: z.object({ supported: z.boolean() }).optional(),
  max: z.object({ supported: z.boolean() }).optional(),
}).passthrough();

const ConcentrateListModel = z.object({
  id: z.string(),
  display_name: z.string(),
  owned_by: z.string(),
  created_at: z.string(),
  max_input_tokens: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
  capabilities: z.object({
    effort: EffortSupport,
    image_input: z.object({ supported: z.boolean() }).passthrough(),
    pdf_input: z.object({ supported: z.boolean() }).passthrough(),
    structured_outputs: z.object({ supported: z.boolean() }).passthrough(),
    thinking: z.object({
      supported: z.boolean(),
      types: z.object({
        adaptive: z.object({ supported: z.boolean() }).optional(),
        enabled: z.object({ supported: z.boolean() }).optional(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const ConcentrateListResponse = z.object({
  data: z.array(ConcentrateListModel),
  has_more: z.boolean(),
}).passthrough();

const ConcentrateDetail = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  release_date: z.number(),
  author: z.object({ slug: z.string() }).passthrough(),
  providers: z.record(ProviderRoute),
}).passthrough();

export const ConcentrateModel = z.object({
  summary: ConcentrateListModel,
  detail: ConcentrateDetail,
});

const ConcentrateResponse = z.object({ data: z.array(ConcentrateModel) });

export type ConcentrateModel = z.infer<typeof ConcentrateModel>;
export type ConcentrateRoute = z.infer<typeof ProviderRoute>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Concentrate owner slugs that differ from the canonical metadata prefix. Slugs
// that already match one (anthropic, deepseek, google, openai, xai, moonshot,
// zai) need no entry and fall through unchanged.
const OWNER_PREFIXES: Record<string, string> = {
  mistral: "mistralai",
  stepfunai: "stepfun",
};

// Concentrate intentionally exposes stable, punctuation-light aliases. Map the
// aliases whose canonical models.dev IDs carry dates, sizes, or lab casing.
const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
  "gemma-4-26b": "google/gemma-4-26b-a4b-it",
  "grok-4.20-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
  "deepseek-v3-1": "deepseek/deepseek-v3.1",
  "deepseek-v4-flash-0423": "deepseek/deepseek-v4-flash",
};

// A few catalog entries advertise routes that do not serve normal traffic, so
// the cheapest advertised price is not what callers are billed. The generic
// GPT-OSS IDs list a $0 Blue Lobster route and sub-cent DeepInfra/Novita routes,
// but live completions on 2026-08-19 were relayed through Fireworks and returned
// that route's non-zero billed cost. Pin the observed serving route for those
// IDs; everything else keeps the cheapest-advertised-route baseline.
const SERVING_ROUTE_OVERRIDES: Record<string, string> = {
  "gpt-oss-120b": "fireworks",
  "gpt-oss-20b": "fireworks",
};

export const concentrate = {
  id: "concentrate",
  name: "Concentrate",
  modelsDir: "providers/concentrate/models",
  // Concentrate normalizes reasoning effort across upstreams and may degrade
  // unsupported controls. New files need a lab/peer baseline before publishing
  // exact caller-visible reasoning options.
  skipCreates: true,
  trackMissingModels: false,
  deleteMissing: false,
  sourceID(model) {
    return model.summary.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Concentrate models were not added automatically because relay reasoning controls require per-model review.`,
      `Remote IDs not currently curated: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  fetchModels() {
    return fetchConcentrateModels();
  },
  parseModels(raw) {
    return ConcentrateResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const translated = buildConcentrateModel(model, context.existing(model.summary.id));
    return translated === undefined ? undefined : { id: model.summary.id, model: translated };
  },
} satisfies SyncProvider<ConcentrateModel>;

export async function fetchConcentrateModels(fetcher: Fetcher = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Concentrate model list request failed: ${response.status} ${response.statusText}`);
  }
  const list = ConcentrateListResponse.parse(await response.json());
  if (list.has_more) throw new Error("Concentrate model list unexpectedly returned a partial page");

  const batches = Array.from(
    { length: Math.ceil(list.data.length / DETAIL_CONCURRENCY) },
    (_, index) => list.data.slice(index * DETAIL_CONCURRENCY, (index + 1) * DETAIL_CONCURRENCY),
  );
  const data: ConcentrateModel[] = [];
  for (const batch of batches) {
    data.push(...await Promise.all(batch.map(async (summary) => {
      const detailResponse = await fetcher(`${API_ENDPOINT}/${encodeURIComponent(summary.id)}`);
      if (!detailResponse.ok) {
        throw new Error(
          `Concentrate model detail request failed for ${summary.id}: ${detailResponse.status} ${detailResponse.statusText}`,
        );
      }
      const detail = ConcentrateDetail.parse(await detailResponse.json());
      if (detail.slug !== summary.id) {
        throw new Error(`Concentrate model detail ID mismatch: expected ${summary.id}, received ${detail.slug}`);
      }
      return { summary, detail };
    })));
  }
  return { data };
}

export function resolveConcentrateBaseModel(model: ConcentrateModel) {
  const alias = BASE_MODEL_ALIASES[model.summary.id];
  if (alias !== undefined) return alias;
  const prefix = OWNER_PREFIXES[model.summary.owned_by] ?? model.summary.owned_by;
  return resolveCanonicalBaseModel(`${prefix}/${model.summary.id}`);
}

export function selectConcentratePricingRoute(model: ConcentrateModel) {
  // Concentrate can serve one model through several upstreams. Its catalog UI
  // presents the lowest available token price. Select that route for cost only;
  // gateway-wide capabilities and limits come from aggregate list/detail data.
  const routes = Object.entries(model.detail.providers).map(([id, route]) => ({
    id,
    route,
    cost: money(route.pricing.tokens.input) + money(route.pricing.tokens.output),
  }));

  // Where a live probe showed which upstream actually serves the ID, bill from
  // that route instead of the cheapest advertised one. See SERVING_ROUTE_OVERRIDES.
  const pinned = SERVING_ROUTE_OVERRIDES[model.summary.id];
  const served = pinned === undefined ? undefined : routes.find((entry) => entry.id === pinned);
  if (served !== undefined) return served;

  return routes.reduce<{ id: string; route: ConcentrateRoute; cost: number } | undefined>(
    (best, entry) => (best === undefined || entry.cost < best.cost ? entry : best),
    undefined,
  );
}

export function concentrateSurface(
  model: ConcentrateModel,
  outputLimit = model.summary.max_tokens,
) {
  const routes = Object.values(model.detail.providers);
  return {
    input: [
      "text" as const,
      ...(model.summary.capabilities.image_input.supported
        || routes.some((route) => supported(route.supports.input?.image))
        ? ["image" as const]
        : []),
      ...(model.summary.capabilities.pdf_input.supported
        || routes.some((route) => supported(route.supports.input?.file))
        ? ["pdf" as const]
        : []),
    ],
    limit: {
      context: model.summary.max_input_tokens,
      output: Math.min(model.summary.max_tokens, outputLimit),
    },
    tool_call: routes.some((route) => route.supports.tools?.function_calling === true),
    // The gateway-level capability is authoritative for structured output: a
    // route can advertise json_schema while the relay in front of it does not
    // expose the feature. claude-opus-4-1 lists structured_outputs.supported =
    // false even though its anthropic route advertises json_schema, and the
    // OpenRouter peer for that same base model also publishes false. Trusting
    // any permissive route here would overstate what callers can actually use.
    structured_output: model.summary.capabilities.structured_outputs.supported,
  };
}

export function buildConcentrateModel(
  model: ConcentrateModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  const baseModel = existing?.base_model ?? resolveConcentrateBaseModel(model);
  if (baseModel === undefined) return undefined;
  const selected = selectConcentratePricingRoute(model);
  if (selected === undefined) return undefined;

  const pricingRoute = selected.route;
  const surface = concentrateSurface(model, canonicalOutputLimit(baseModel));
  const tokens = pricingRoute.pricing.tokens;
  // A context tier only bills once a request exceeds its threshold, so a tier at
  // or above the model's own context window can never be entered and would
  // advertise a price nobody can be charged. Concentrate publishes exactly that
  // for the Claude Sonnet IDs it caps at 200k while carrying Anthropic's
  // long-context band at above = 200_000. Drop unreachable tiers rather than
  // relaying them.
  const tiers = tokens.tiers
    ?.filter((tier) => tier.above < surface.limit.context)
    .map((tier) => ({
      tier: { type: "context" as const, size: tier.above },
      input: money(tier.input),
      output: money(tier.output),
      cache_read: optionalMoney(tier.cache?.read),
      cache_write: optionalMoney(tier.cache?.write?.cache_write_tokens),
    }));
  const cost = {
    input: money(tokens.input),
    output: money(tokens.output),
    cache_read: optionalMoney(tokens.cache?.read),
    cache_write: optionalMoney(tokens.cache?.write?.cache_write_tokens),
    tiers: tiers !== undefined && tiers.length > 0 ? tiers : undefined,
  };

  return factorBaseModel(baseModel, {
    attachment: surface.input.some((value) => value !== "text"),
    // Concentrate Chat exposes reasoning_effort and reports model-specific
    // support per upstream route. Preserve the reviewed lab/peer intersection
    // authored in each provider TOML rather than treating the gateway's full
    // normalization enum as native support for every model.
    // https://concentrate.ai/docs/api-reference/endpoint/chat-completions
    // https://concentrate.ai/docs/api-reference/endpoint/get-model
    reasoning_options: existing?.reasoning_options,
    // interleaved isn't reported by the API either — it's a hand-authored
    // reading of which field (reasoning_content vs reasoning_details) a
    // model's route actually streams reasoning through. Preserve it the
    // same way reasoning_options is preserved above, or the next sync drops
    // every model's [interleaved] block silently.
    interleaved: existing?.interleaved,
    // status/provider/experimental are never derived from Concentrate's
    // catalog either — same peer pattern as openrouter.ts/nano-gpt.ts, so a
    // curator marking a model deprecated, or adding a per-model request
    // override, survives the next sync instead of being silently dropped.
    status: existing?.status,
    provider: existing?.provider,
    experimental: existing?.experimental,
    tool_call: surface.tool_call,
    structured_output: surface.structured_output,
    cost,
    limit: surface.limit,
    modalities: { input: surface.input, output: ["text"] },
  }, surface.limit, existing?.base_model_omit);
}

function canonicalOutputLimit(baseModel: string) {
  const limit = modelMetadata(baseModel).limit;
  if (limit === null || typeof limit !== "object" || Array.isArray(limit)) return undefined;
  return typeof limit.output === "number" ? limit.output : undefined;
}

function supported(value: boolean | Record<string, boolean> | undefined) {
  if (typeof value === "boolean") return value;
  return value !== undefined && Object.values(value).some(Boolean);
}

function money(value: z.infer<typeof Money>) {
  return Math.round((value.price.USD * 1_000_000 / value.units) * 1_000_000) / 1_000_000;
}

function optionalMoney(value: z.infer<typeof Money> | undefined) {
  return value === undefined ? undefined : money(value);
}
