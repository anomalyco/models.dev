import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

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

const OWNER_PREFIXES: Record<string, string> = {
  mistral: "mistralai",
  moonshot: "moonshot",
  stepfunai: "stepfun",
  zai: "zai",
};

// Concentrate intentionally exposes stable, punctuation-light aliases. Map the
// aliases whose canonical models.dev IDs carry dates, sizes, or lab casing.
const BASE_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4": "anthropic/claude-sonnet-4-20250514",
  "gemma-4-26b": "google/gemma-4-26b-a4b-it",
  "gemma-4-e4b": "google/gemma-4-E4B-it",
  "gemma-4-31b": "google/gemma-4-31b-it",
  "grok-4.20-non-reasoning": "xai/grok-4.20-0309-non-reasoning",
  "deepseek-r1-0528": "deepseek/deepseek-r1",
  "deepseek-r1-distill-32b": "deepseek/deepseek-r1-distill-qwen-32b",
  "deepseek-v3-1": "deepseek/deepseek-v3.1",
  "deepseek-v3-2": "deepseek/deepseek-v3.2",
  "deepseek-v4-flash-0423": "deepseek/deepseek-v4-flash",
  "qwen3-235b-a22b-instruct": "alibaba/qwen3-235b-a22b-instruct-2507",
  "qwen3-235b-a22b-thinking": "alibaba/qwen3-235b-a22b",
  "qwen3-max-thinking": "alibaba/qwen3-max",
  "qwen3-coder-480b-a35b": "alibaba/qwen3-coder-480b-a35b-instruct",
  "qwen3-30b": "alibaba/qwen3-30b-a3b",
  "qwen3.6-35b": "alibaba/qwen3.6-35b-a3b",
  "qwen3-coder-30b-a3b": "alibaba/qwen3-coder-30b-a3b-instruct",
  "qwen3-next-80b-a3b": "alibaba/qwen3-next-80b-a3b-instruct",
  "qwen3-vl-235b-a22b": "alibaba/qwen3-vl-235b-a22b-instruct",
  "kimi-k2-7-code": "moonshotai/kimi-k2.7-code",
  "kimi-k2-6": "moonshotai/kimi-k2.6",
  "kimi-k2-5": "moonshotai/kimi-k2.5",
  "minimax-m2-7-highspeed": "minimax/MiniMax-M2.7-highspeed",
  "minimax-m2-7": "minimax/MiniMax-M2.7",
  "minimax-m2-5-highspeed": "minimax/MiniMax-M2.5-highspeed",
  "minimax-m2-5": "minimax/MiniMax-M2.5",
  "minimax-m2-1-highspeed": "minimax/MiniMax-M2.1",
  "minimax-m2-1": "minimax/MiniMax-M2.1",
  "nemotron-3-nano-30b": "nvidia/nemotron-3-nano-30b-a3b",
  "nemotron-3-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nemotron-3-ultra-nvfp4": "nvidia/nemotron-3-ultra-550b-a55b",
  "step-3-7-flash": "stepfun/step-3.7-flash",
  "llama-4-maverick": "meta/llama-4-maverick-17b-instruct",
  "llama-4-scout": "meta/llama-4-scout-17b-instruct",
  "llama-3.2-3b-instruct": "meta/llama-3.2-3b",
  "llama-3.2-1b-instruct": "meta/llama-3.2-1b",
  "mistral-large-3": "mistral/mistral-large-2512",
  "mistral-medium-3": "mistral/mistral-medium-2505",
  "mistral-small-3.1": "mistral/mistral-small-3-1-24b-instruct-2503",
  "mistral-small-3.2": "mistral/mistral-small-2506",
  "devstral-2": "mistral/devstral-2512",
  "codestral": "mistral/codestral-latest",
  "command-a": "cohere/command-a-03-2025",
  "command-a-vision": "cohere/command-a-vision-07-2025",
};

export const concentrate = {
  id: "concentrate",
  name: "Concentrate",
  modelsDir: "providers/concentrate/models",
  sourceID(model) {
    return model.summary.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Concentrate models were skipped because models.dev has no canonical metadata for them yet.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
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

export function selectConcentrateRoute(model: ConcentrateModel) {
  // Concentrate can serve one model through several upstreams. Its catalog UI
  // presents the lowest available token price, so use that route as the stable
  // models.dev baseline while runtime routing remains configurable by users.
  return Object.entries(model.detail.providers).reduce<
    { id: string; route: ConcentrateRoute; cost: number } | undefined
  >((best, [id, route]) => {
    const cost = money(route.pricing.tokens.input) + money(route.pricing.tokens.output);
    if (best === undefined || cost < best.cost) return { id, route, cost };
    return best;
  }, undefined);
}

export function buildConcentrateModel(
  model: ConcentrateModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  const baseModel = existing?.base_model ?? resolveConcentrateBaseModel(model);
  if (baseModel === undefined) return undefined;
  const selected = selectConcentrateRoute(model);
  if (selected === undefined) return undefined;

  const route = selected.route;
  const input = [
    "text" as const,
    ...(supported(route.supports.input?.image) || model.summary.capabilities.image_input.supported
      ? ["image" as const]
      : []),
    ...(supported(route.supports.input?.file) || model.summary.capabilities.pdf_input.supported
      ? ["pdf" as const]
      : []),
  ];
  const reasoning = model.summary.capabilities.effort.supported
    || model.summary.capabilities.thinking.supported;
  const limit = {
    context: route.context_window,
    output: route.max_output_tokens,
  };
  const tokens = route.pricing.tokens;
  const cost = {
    input: money(tokens.input),
    output: money(tokens.output),
    cache_read: optionalMoney(tokens.cache?.read),
    cache_write: optionalMoney(tokens.cache?.write?.cache_write_tokens),
    tiers: tokens.tiers?.map((tier) => ({
      tier: { type: "context" as const, size: tier.above },
      input: money(tier.input),
      output: money(tier.output),
      cache_read: optionalMoney(tier.cache?.read),
      cache_write: optionalMoney(tier.cache?.write?.cache_write_tokens),
    })),
  };

  return factorBaseModel(baseModel, {
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoning ? reasoningOptions(model, route) : undefined,
    temperature: route.supports.temperature,
    tool_call: route.supports.tools?.function_calling,
    structured_output: route.supports.text?.format?.json_schema === true
      || route.supports.text?.format?.json_object === true
      || model.summary.capabilities.structured_outputs.supported,
    cost,
    limit,
    modalities: { input, output: ["text"] },
  }, limit, existing?.base_model_omit);
}

function reasoningOptions(
  model: ConcentrateModel,
  route: ConcentrateRoute,
): NonNullable<SyncedFullModel["reasoning_options"]> {
  const advertised = model.summary.capabilities.effort;
  const routeEfforts = route.supports.reasoning?.effort;
  const efforts = [
    ["none", advertised.none],
    ["minimal", advertised.minimal],
    ["low", advertised.low],
    ["medium", advertised.medium],
    ["high", advertised.high],
    ["xhigh", advertised.xhigh],
    ["max", advertised.max],
  ] as const;
  const supportedEfforts = efforts
    .filter(([effort, summary]) => routeEfforts?.[effort] === true || summary?.supported === true)
    .map(([effort]) => effort);
  const toggle = model.summary.capabilities.thinking.types.enabled?.supported === true
    && !supportedEfforts.includes("none");
  return [
    ...(toggle ? [{ type: "toggle" as const }] : []),
    ...(supportedEfforts.length > 0 ? [{ type: "effort" as const, values: supportedEfforts }] : []),
  ];
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
