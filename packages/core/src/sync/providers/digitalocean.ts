import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const MODELS_API = "https://api.digitalocean.com/v2/gen-ai/models?per_page=200";
const CATALOG_API = "https://api.digitalocean.com/v2/gen-ai/models/catalog?limit=200";

export const DigitalOceanModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // The models endpoint also returns retired rows absent from the public catalog.
  lifecycle_status: z.string().optional(),
  type: z.string().optional(),
  thinking: z.boolean().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
  // Feature flags; `responses` marks models served on POST /v1/responses.
  capabilities: z.array(z.string()).optional(),
  // DigitalOcean-hosted models list their own inference endpoints.
  endpoints: z.array(z.object({
    capabilities: z.array(z.string()).optional(),
  }).passthrough()).optional(),
  context_window: z.union([z.number(), z.string()]).optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  }).optional(),
  settings: z.array(z.object({
    name: z.string(),
    max: z.number().optional(),
    default_value: z.number().optional(),
  })).optional(),
  created_at: z.string().optional(),
}).passthrough();

const DigitalOceanModelsResponse = z.object({
  models: z.array(DigitalOceanModel),
  links: z.object({
    pages: z.object({
      next: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const DigitalOceanCatalogPricing = z.object({
  input_price_per_million: z.number().optional(),
  output_price_per_million: z.number().optional(),
  cache_read_input_price_per_million: z.number().optional(),
  cache_write_5m_input_price_per_million: z.number().optional(),
  cache_write_1h_input_price_per_million: z.number().optional(),
  image_input_price_per_million: z.number().optional(),
  image_output_price_per_million: z.number().optional(),
  image_cache_read_input_price_per_million: z.number().optional(),
}).passthrough();

const DigitalOceanCatalogModel = z.object({
  id: z.string().min(1).optional(),
  model_id: z.string().min(1),
  name: z.string().min(1),
  creator: z.string().optional(),
  context_window: z.union([z.number(), z.string()]).nullish(),
  max_output_tokens: z.union([z.number(), z.string()]).nullish(),
  availability: z.array(z.string()).optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  }).nullish(),
  pricing: DigitalOceanCatalogPricing.nullish(),
  pricing_detail: z.object({
    variants: z.array(z.object({
      tier: z.string().optional(),
      label: z.string().optional(),
      mode: z.string().optional(),
      prices: DigitalOceanCatalogPricing.nullish(),
    }).passthrough()),
  }).nullish(),
}).passthrough();

const DigitalOceanCatalogResponse = z.object({
  data: z.array(DigitalOceanCatalogModel),
  links: z.object({
    pages: z.object({
      next: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  meta: z.object({
    page: z.number().int().positive(),
    pages: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).passthrough().optional(),
}).passthrough();

const DigitalOceanCatalogDetailResponse = z.object({
  data: DigitalOceanCatalogModel,
}).passthrough();

const DigitalOceanResponse = z.object({
  models: z.array(DigitalOceanModel),
  catalog: z.array(DigitalOceanCatalogModel),
});

export type DigitalOceanModel = z.infer<typeof DigitalOceanModel>;
type DigitalOceanCatalogModel = z.infer<typeof DigitalOceanCatalogModel>;

interface Prices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

interface ModelPricing extends Prices {
  extended?: Prices & { context: number };
  // Interactive service-tier variants (Fast, Flex, Ultrafast), by catalog label.
  serviceTiers?: Array<{ label: string; prices: Prices }>;
  image?: { input?: number; output?: number; cacheRead?: number };
}

type ReasoningEffort =
  | null
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

export interface DigitalOceanSourceModel extends DigitalOceanModel {
  creator?: string;
  max_output_tokens?: string | number | null;
  availability?: string[];
  pricing?: ModelPricing;
}

export const digitalocean = {
  id: "digitalocean",
  name: "DigitalOcean",
  modelsDir: "providers/digitalocean/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} DigitalOcean text models could not be translated because required metadata was unavailable.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local DigitalOcean models were outside the managed text-model catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.DIGITALOCEAN_API_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN;
    if (!key) {
      throw new Error("DigitalOcean sync requires DIGITALOCEAN_API_TOKEN or DIGITALOCEAN_ACCESS_TOKEN");
    }
    return fetchDigitalOceanModels(key);
  },
  parseModels(raw) {
    return parseDigitalOceanModels(raw);
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const contextWindow = number(model.context_window);
    const outputLimit = number(model.max_output_tokens ?? undefined);
    if (model.pricing?.input === undefined || model.pricing.output === undefined) return undefined;
    if (
      existing === undefined
      && (
        contextWindow === undefined
        || contextWindow <= 0
        || outputLimit === undefined
        || outputLimit <= 0
      )
    ) return undefined;
    // Only auto-resolve base_model for newly created files. Existing full
    // definitions stay hand-authored unless they already declare base_model.
    const baseModel = existing !== undefined
      ? existing.base_model
      : resolveDigitalOceanBaseModel(model.id);
    return {
      id: model.id,
      model: buildDigitalOceanModel(model, existing, baseModel),
      v2Set: digitalOceanV2Set(model),
    };
  },
} satisfies SyncProvider<DigitalOceanSourceModel>;

// Chat models answer POST /v1/chat/completions (the provider default). Models the
// catalog flags `responses` also answer POST /v1/responses. POST /v1/messages
// (Anthropic format) serves those and the DigitalOcean-hosted models (the ones
// with their own `endpoints`); for the rest it 404s "not available via the
// Responses API" (live 2026-10-22).
// https://docs.digitalocean.com/products/inference/how-to/si-endpoints/
// https://docs.digitalocean.com/products/inference/how-to/use-messages-api/
// OpenAI models are relayed to OpenAI, where every model answers Responses; the
// catalog leaves the flag off older ones (gpt-4o, gpt-4.1, gpt-5, o1, o3 all
// answered /v1/responses and /v1/messages live 2026-10-22).
const RESPONSES_CREATORS = new Set(["OpenAI"]);
const RESPONSES_API = {
  sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
};
const MESSAGES_API = {
  sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" },
};

// Web search: $10 per 1,000 requests, not charged on Anthropic models.
// https://docs.digitalocean.com/products/inference/details/pricing/#tools-usage
const WEB_SEARCH_PRICE = 10;

// The request's service tier for each catalog price mode. OpenAI models take
// OpenAI's `service_tier` (fast mode is `priority`); Anthropic fast mode is
// DigitalOcean's `speed = "fast"`, Anthropic's `fast` tier (live 2026-10-22).
const SERVICE_TIERS: Record<string, Partial<Record<"fast" | "flex" | "ultrafast", string>>> = {
  OpenAI: { fast: "priority", flex: "flex", ultrafast: "ultrafast" },
  Anthropic: { fast: "fast" },
};
const SERVICE_TIER_ORDER = ["flex", "priority", "fast", "ultrafast"];

type Override = { when: Record<string, unknown>; [key: string]: unknown };

// v2 data v1 fields can't carry: the model's APIs, web search price, cache-write
// prices per TTL, image token prices and service-tier prices.
export function digitalOceanV2Set(model: DigitalOceanSourceModel): Record<string, unknown> {
  const pricing = model.pricing;
  const output = normalizeModalities(model.modalities?.output ?? [], []);
  const chat = model.type === "chat" && output.every((value) => value === "text");
  const tiers = serviceTierOverrides(model);
  const set: Record<string, unknown> = {
    "cost.text.input.overrides": (current: unknown) => {
      const extended = pricing?.extended;
      const context = contextOverrides(current).map((override) => {
        const cache = override.cache as { write?: unknown } | undefined;
        const write = cacheWrite(firstWrite(cache?.write), extended?.cacheWrite1h);
        const gt = (override.when.context as { gt?: unknown } | undefined)?.gt;
        return extended !== undefined && gt === extended.context && typeof write === "object"
          ? { ...override, cache: { ...cache, write } }
          : override;
      });
      const next = [...context, ...tiers.input];
      return next.length > 0 ? next : undefined;
    },
    "cost.text.output.overrides": (current: unknown) => {
      const next = [...contextOverrides(current), ...tiers.output];
      return next.length > 0 ? next : undefined;
    },
    "capabilities.service_tier": tiers.names.length > 0 ? tiers.names : undefined,
  };
  const write = cacheWrite(pricing?.cacheWrite, pricing?.cacheWrite1h);
  if (typeof write === "object") set["cost.text.input.cache.write"] = write;
  if (pricing?.image !== undefined) {
    set["cost.image"] = withoutUndefined({
      input: pricing.image.input === undefined
        ? undefined
        : withoutUndefined({
            price: pricing.image.input,
            cache: pricing.image.cacheRead === undefined ? undefined : { read: pricing.image.cacheRead },
          }),
      output: pricing.image.output === undefined ? undefined : { price: pricing.image.output },
    });
  }
  if (chat) {
    const responses = model.capabilities?.includes("responses") === true || RESPONSES_CREATORS.has(model.creator ?? "");
    const hosted = model.endpoints?.some((endpoint) => endpoint.capabilities?.includes("chat_completions")) === true;
    const extra = {
      ...(responses ? { responses: RESPONSES_API } : {}),
      ...(responses || hosted ? { messages: MESSAGES_API } : {}),
    };
    // The first table stays as it is (v1 reads it).
    set.api = (current: unknown) => {
      const tables = isRecord(current) ? current : {};
      if (current === undefined && Object.keys(extra).length === 0) return undefined;
      const first = Object.keys(tables)[0] ?? "chat-completions";
      return { [first]: tables[first] ?? {}, ...structuredClone(extra) };
    };
    set["cost.web_search"] = { price: model.creator === "Anthropic" ? 0 : WEB_SEARCH_PRICE };
  }
  return set;
}

function serviceTierOverrides(model: DigitalOceanSourceModel) {
  const input: Override[] = [];
  const output: Override[] = [];
  const names = new Set<string>();
  for (const { label, prices } of model.pricing?.serviceTiers ?? []) {
    const parsed = serviceTierLabel(label);
    const tier = parsed === undefined ? undefined : SERVICE_TIERS[model.creator ?? ""]?.[parsed.mode];
    if (parsed === undefined || tier === undefined) continue;
    names.add(tier);
    const when = {
      service_tier: { equals: tier },
      ...(parsed.context === undefined ? {} : { context: { gt: parsed.context } }),
    };
    const write = cacheWrite(prices.cacheWrite, prices.cacheWrite1h);
    const cache = withoutUndefined({ read: prices.cacheRead, write });
    if (prices.input !== undefined) {
      input.push(withoutUndefined({ when, price: prices.input, cache: Object.keys(cache).length > 0 ? cache : undefined }));
    }
    if (prices.output !== undefined) output.push({ when, price: prices.output });
  }
  // Long-context tier prices come after the plain ones, so they win when both match.
  const byContext = (a: Override, b: Override) => Number("context" in a.when) - Number("context" in b.when);
  return {
    input: input.sort(byContext),
    output: output.sort(byContext),
    names: [...names].sort((a, b) => SERVICE_TIER_ORDER.indexOf(a) - SERVICE_TIER_ORDER.indexOf(b)),
  };
}

function contextOverrides(current: unknown): Override[] {
  if (!Array.isArray(current)) return [];
  return current.filter((override): override is Override =>
    isRecord(override)
    && isRecord(override.when)
    && Object.keys(override.when).every((key) => key === "context")
  );
}

function cacheWrite(write5m: number | undefined, write1h: number | undefined) {
  if (write5m === undefined) return undefined;
  return write1h === undefined ? write5m : { "5m": write5m, "1h": write1h };
}

function firstWrite(write: unknown) {
  if (typeof write === "number") return write;
  return isRecord(write) && typeof write["5m"] === "number" ? write["5m"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export async function fetchDigitalOceanModels(key: string, fetcher: typeof fetch = fetch) {
  const [models, catalog] = await Promise.all([
    fetchAllDigitalOceanModels(key, fetcher),
    fetchAllDigitalOceanCatalog(fetcher),
  ]);
  return { models, catalog };
}

async function fetchAllDigitalOceanModels(key: string, fetcher: typeof fetch) {
  const models: DigitalOceanModel[] = [];
  const visited = new Set<string>();
  let url: string | undefined = MODELS_API;

  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`DigitalOcean models pagination repeated URL: ${url}`);
    visited.add(url);

    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean models request failed: ${response.status} ${response.statusText}`);
    }

    const page = DigitalOceanModelsResponse.parse(await response.json());
    models.push(...page.models);
    const next = page.links?.pages?.next;
    url = next ? new URL(next, url).toString() : undefined;
  }
  return models;
}

async function fetchAllDigitalOceanCatalog(fetcher: typeof fetch) {
  const catalog: DigitalOceanCatalogModel[] = [];
  const visited = new Set<string>();
  let url: string | undefined = CATALOG_API;

  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`DigitalOcean catalog pagination repeated URL: ${url}`);
    visited.add(url);

    const response = await fetcher(url, {
      headers: { "Content-Type": "application/json", "User-Agent": "models.dev/digitalocean-sync" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean catalog request failed: ${response.status} ${response.statusText}`);
    }

    const page = DigitalOceanCatalogResponse.parse(await response.json());
    catalog.push(...page.data);
    const next = page.links?.pages?.next;
    if (next) {
      url = new URL(next, url).toString();
    } else if (page.meta !== undefined && page.meta.page < page.meta.pages) {
      const nextPage = new URL(url);
      nextPage.searchParams.set("page", String(page.meta.page + 1));
      url = nextPage.toString();
    } else {
      url = undefined;
    }
  }

  return Promise.all(catalog.map(async (model) => {
    if (model.id === undefined || model.availability?.includes("serverless") !== true) return model;
    const response = await fetcher(`https://api.digitalocean.com/v2/gen-ai/models/catalog/${model.id}`, {
      headers: { "Content-Type": "application/json", "User-Agent": "models.dev/digitalocean-sync" },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean catalog detail request failed: ${response.status} ${response.statusText}`);
    }
    const detail = DigitalOceanCatalogDetailResponse.parse(await response.json()).data;
    return {
      ...model,
      modalities: detail.modalities ?? model.modalities,
      pricing_detail: detail.pricing_detail ?? model.pricing_detail,
    };
  }));
}

export function parseDigitalOceanModels(raw: unknown): DigitalOceanSourceModel[] {
  const response = DigitalOceanResponse.parse(raw);
  const catalog = new Map(response.catalog.map((model) => [model.model_id, model]));
  return response.models
    .map((model) => mergeCatalogModel(model, catalog.get(model.id)))
    .filter(isManagedTextModel);
}

function mergeCatalogModel(
  model: DigitalOceanModel,
  catalog: DigitalOceanCatalogModel | undefined,
): DigitalOceanSourceModel {
  return {
    ...model,
    name: catalog?.name ?? model.name,
    creator: catalog?.creator,
    context_window: catalog?.context_window ?? model.context_window,
    max_output_tokens: catalog?.max_output_tokens,
    modalities: catalog?.modalities ?? model.modalities,
    availability: catalog?.availability,
    pricing: catalogPricing(catalog),
  };
}

function isManagedTextModel(model: DigitalOceanSourceModel) {
  const output = normalizeModalities(model.modalities?.output ?? [], []);
  return model.availability?.includes("serverless") === true
    && output.includes("text")
    && model.type !== "embedding"
    && model.type !== "reranking";
}

function catalogPricing(model: DigitalOceanCatalogModel | undefined): ModelPricing | undefined {
  if (model?.pricing == null) return undefined;
  const standard = model.pricing_detail?.variants.find((variant) =>
    variant.mode === "MODEL_BILLING_MODE_INTERACTIVE"
    && variant.tier === "MODEL_PRICING_TIER_STANDARD"
  )?.prices;
  const extended = model.pricing_detail?.variants.find((variant) =>
    variant.mode === "MODEL_BILLING_MODE_INTERACTIVE"
    && (
      variant.tier?.startsWith("MODEL_PRICING_TIER_EXTENDED_") === true
      || longContextLabel(variant.label) !== undefined
    )
  );
  const extendedContext = pricingTierContext(extended?.tier) ?? longContextLabel(extended?.label);
  const serviceTiers = (model.pricing_detail?.variants ?? []).flatMap((variant) =>
    variant.mode === "MODEL_BILLING_MODE_INTERACTIVE"
      && variant.label !== undefined
      && serviceTierLabel(variant.label) !== undefined
      && variant.prices != null
      ? [{ label: variant.label, prices: variantPrices(variant.prices) }]
      : []
  );
  const image = {
    input: perMillion(model.pricing.image_input_price_per_million),
    output: perMillion(model.pricing.image_output_price_per_million),
    cacheRead: perMillion(model.pricing.image_cache_read_input_price_per_million),
  };
  return {
    input: perMillion(model.pricing.input_price_per_million),
    output: perMillion(model.pricing.output_price_per_million),
    cacheRead: perMillion(model.pricing.cache_read_input_price_per_million),
    cacheWrite: perMillion(standard?.cache_write_5m_input_price_per_million),
    cacheWrite1h: perMillion(standard?.cache_write_1h_input_price_per_million),
    extended: extendedContext === undefined || extended?.prices == null
      ? undefined
      : { context: extendedContext, ...variantPrices(extended.prices) },
    serviceTiers: serviceTiers.length > 0 ? serviceTiers : undefined,
    image: image.input !== undefined || image.output !== undefined ? image : undefined,
  };
}

function variantPrices(prices: z.infer<typeof DigitalOceanCatalogPricing>): Prices {
  return {
    input: perMillion(prices.input_price_per_million),
    output: perMillion(prices.output_price_per_million),
    cacheRead: perMillion(prices.cache_read_input_price_per_million),
    cacheWrite: perMillion(prices.cache_write_5m_input_price_per_million),
    cacheWrite1h: perMillion(prices.cache_write_1h_input_price_per_million),
  };
}

// Catalog labels: "Fast Mode", "Flex Mode", "Ultrafast Mode", each optionally
// followed by " (Prompts > 272K tokens)" for its long-context price.
function serviceTierLabel(label: string) {
  const match = label.match(/^(Fast|Flex|Ultrafast) Mode(?: \(Prompts > (\d+)K tokens\))?$/);
  if (match === null) return undefined;
  return {
    mode: match[1]!.toLowerCase() as "fast" | "flex" | "ultrafast",
    context: match[2] === undefined ? undefined : Number(match[2]) * 1_000,
  };
}

// Untiered long-context variants carry the threshold in the label, e.g.
// "Long form context (> 100k)".
function longContextLabel(label: string | undefined) {
  const match = label?.match(/^Long form context \(> (\d+)k\)$/i);
  return match ? Number(match[1]) * 1_000 : undefined;
}

function pricingTierContext(tier: string | undefined) {
  // Tier names describe capacity; Anthropic's 1M surcharge starts above 200K.
  if (tier === "MODEL_PRICING_TIER_EXTENDED_1M") return 200_000;
  if (tier === "MODEL_PRICING_TIER_EXTENDED_272K") return 272_000;
  return undefined;
}

function perMillion(value: number | undefined) {
  if (value === undefined) return undefined;
  // The live catalog currently returns per-token rates despite the field names.
  const normalized = value < 0.001 ? value * 1_000_000 : value;
  return Math.round(normalized * 10_000) / 10_000;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

// The catalog advertises these inputs, but the standard serverless endpoint
// rejects them. Remove an entry once DigitalOcean serves the modality.
const UNSUPPORTED_INPUT_MODALITIES: Record<string, Set<Modality>> = {
  // 400 "unsupported multimodal content: image_url" / "video_url" (verified 2026-10-16).
  // DigitalOcean confirmed the standard endpoint lacks multimodal support and a fix is in progress.
  "glm-5.3-flash": new Set(["image", "video"]),
};

function normalizeModalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const normalized = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "code" ? "text" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function normalizeEffortToken(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "x-high" || normalized === "xhigh") return "xhigh";
  if (normalized === "null") return "null";
  return normalized;
}

function number(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => target.includes(family.toLowerCase()));
}

function reasoningOptionsFor(
  model: DigitalOceanSourceModel,
  existing: ExistingModel | undefined,
): ExistingModel["reasoning_options"] {
  if (model.reasoning_efforts === undefined || model.reasoning_efforts.length === 0) {
    return existing?.reasoning_options;
  }
  const remoteValues = reasoningEfforts(model);
  const preserved = existing?.reasoning_options?.filter((option) => option.type !== "effort") ?? [];
  return remoteValues.length > 0
    ? [...preserved, { type: "effort", values: remoteValues }]
    : existing?.reasoning_options;
}

const EFFORT_ORDER: ReasoningEffort[] = [null, "none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

// Sorted low to high: v2 files compare effort lists in order, so a reordered
// catalog list must not rewrite them.
function reasoningEfforts(model: DigitalOceanSourceModel) {
  return [...new Set((model.reasoning_efforts ?? [])
    .map((value) => {
      const normalized = normalizeEffortToken(value);
      return normalized === "null" ? null : normalized;
    })
    .filter(isReasoningEffort))]
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

function isReasoningEffort(value: string | null): value is ReasoningEffort {
  return value === null
    || value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "default";
}

function status(
  lifecycleStatus: string | undefined,
  existing: ExistingModel["status"],
): ExistingModel["status"] {
  // Retired models can remain in the models feed with no lifecycle status.
  if (lifecycleStatus === undefined) return "deprecated";
  const lifecycle = lifecycleStatus.trim().toLowerCase().replaceAll("_", "-");
  if (lifecycle.length === 0) return existing;
  if (lifecycle === "deprecated" || lifecycle === "end-of-life") return "deprecated";
  if (lifecycle === "public-preview" || lifecycle === "preview") return "beta";
  return existing === "deprecated" || existing === "beta" ? undefined : existing;
}

function cost(model: DigitalOceanSourceModel, existing: ExistingModel | undefined) {
  const input = model.pricing?.input ?? existing?.cost?.input;
  const output = model.pricing?.output ?? existing?.cost?.output;
  if (input === undefined || output === undefined) return existing?.cost;

  const existingTiers = existing?.cost?.tiers ?? [];
  const longContext = existingTiers.find((tier) =>
    (tier.tier.type === undefined || tier.tier.type === "context") && tier.tier.size >= 200_000
  );
  const extended = model.pricing?.extended;
  const hasLongContextPricing = extended?.input !== undefined && extended.output !== undefined;
  const tiers = hasLongContextPricing
    ? [
        ...existingTiers.filter((tier) => tier !== longContext),
        {
          tier: { type: "context" as const, size: extended.context },
          input: extended.input!,
          output: extended.output!,
          reasoning: longContext?.reasoning,
          cache_read: extended.cacheRead ?? longContext?.cache_read,
          cache_write: extended.cacheWrite ?? longContext?.cache_write,
        },
      ]
    : existingTiers;

  return {
    input,
    output,
    reasoning: existing?.cost?.reasoning,
    cache_read: model.pricing?.cacheRead ?? existing?.cost?.cache_read,
    cache_write: model.pricing?.cacheWrite ?? existing?.cost?.cache_write,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

export function buildDigitalOceanModel(
  model: DigitalOceanSourceModel,
  existing: ExistingModel | undefined,
  baseModel = existing !== undefined
    ? existing.base_model
    : resolveDigitalOceanBaseModel(model.id),
): SyncedModel {
  const remoteInput = normalizeModalities(model.modalities?.input ?? [], []);
  const remoteOutput = normalizeModalities(model.modalities?.output ?? [], []);
  const unsupportedInput = UNSUPPORTED_INPUT_MODALITIES[model.id];
  const input = (remoteInput.length > 0 ? remoteInput : existing?.modalities?.input ?? ["text"])
    .filter((value) => !unsupportedInput?.has(value as Modality));
  const output = remoteOutput.length > 0 ? remoteOutput : existing?.modalities?.output ?? ["text"];
  const context = number(model.context_window) ?? existing?.limit?.context ?? 0;
  const maxTokens = number(model.max_output_tokens ?? undefined);
  const limit = {
    context,
    input: existing?.limit?.input,
    output: maxTokens ?? existing?.limit?.output ?? 0,
  };
  const textOutput = output.includes("text") && !output.includes("image") && !output.includes("video");
  const remoteEfforts = reasoningEfforts(model);
  const providerReasoning = !textOutput
    ? existing?.reasoning
    : model.thinking === true || remoteEfforts.length > 0
    ? true
    : model.thinking === false
    ? false
    : existing?.reasoning;
  const reasoning = providerReasoning ?? false;
  const reasoningOptions = reasoning === true ? reasoningOptionsFor(model, existing) : undefined;
  const modelStatus = status(model.lifecycle_status, existing?.status);
  const releaseDate = existing?.release_date ?? model.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const attachment = input.some((value) => value !== "text");
  const values: Partial<SyncedFullModel> = {
    name: model.name,
    description: existing?.description ?? describeModel({
      id: model.id,
      name: model.name,
      family: existing?.family ?? inferFamily(model.id, model.name),
      reasoning,
      tool_call: existing?.tool_call ?? textOutput,
      structured_output: existing?.structured_output,
      open_weights: existing?.open_weights ?? false,
      limit,
      modalities: { input, output },
    }),
    family: existing?.family ?? inferFamily(model.id, model.name),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: existing?.temperature ?? true,
    tool_call: existing?.tool_call ?? textOutput,
    structured_output: existing?.structured_output,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: modelStatus,
    interleaved: existing?.interleaved,
    cost: cost(model, existing),
    limit,
    modalities: { input, output },
    provider: existing?.provider,
    experimental: existing?.experimental,
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, {
      name: model.name,
      description: existing?.description,
      attachment,
      modalities: { input, output },
      reasoning: providerReasoning,
      reasoning_options: reasoningOptions,
      temperature: existing?.temperature,
      tool_call: existing?.tool_call,
      structured_output: existing?.structured_output,
      status: modelStatus,
      interleaved: existing?.interleaved,
      cost: cost(model, existing),
      limit,
      provider: existing?.provider,
      experimental: existing?.experimental,
    }, limit, existing?.base_model_omit);
  }

  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    tool_call: z.boolean(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    limit: z.object({ context: z.number().nonnegative(), output: z.number().nonnegative() }),
    modalities: z.object({ input: z.array(z.string()).min(1), output: z.array(z.string()).min(1) }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`DigitalOcean model ${model.id} has incomplete metadata required for sync`);
  }
  return values as SyncedFullModel;
}

export function resolveDigitalOceanBaseModel(id: string) {
  const candidates: string[] = [];
  if (id.startsWith("openai-")) candidates.push(`openai/${id.slice("openai-".length)}`);
  if (id.startsWith("deepseek-")) {
    candidates.push(`deepseek/${id}`);
    candidates.push(`deepseek/${id.replace(/^deepseek-4-/, "deepseek-v4-")}`);
  }
  if (id.startsWith("glm-")) candidates.push(`zai/${id}`);
  if (id.startsWith("kimi-")) candidates.push(`moonshotai/${id}`);
  if (id.startsWith("minimax-")) candidates.push(`minimax/${id}`);
  if (id.startsWith("mimo-")) {
    const normalized = id.replace(/^mimo-v(\d+)-(\d+)/, "mimo-v$1.$2");
    candidates.push(`xiaomi/${id}`);
    candidates.push(`xiaomi/${normalized}`);
  }
  if (id.startsWith("nvidia-")) candidates.push(`nvidia/${id.slice("nvidia-".length)}`);
  if (id.startsWith("alibaba-")) candidates.push(`qwen/${id.slice("alibaba-".length)}`);
  if (id.startsWith("qwen")) candidates.push(`qwen/${id}`);
  if (id.startsWith("llama")) candidates.push(`meta/${id}`);
  if (id.startsWith("mistral") || id.startsWith("ministral")) candidates.push(`mistralai/${id}`);
  if (id.startsWith("gemma")) candidates.push(`google/${id}`);

  // anthropic-claude-5-sonnet → anthropic/claude-sonnet-5
  const anthropicSwapped = id.match(/^anthropic-claude-(\d+(?:\.\d+)?)-([a-z]+)$/);
  if (anthropicSwapped !== null) {
    candidates.push(`anthropic/claude-${anthropicSwapped[2]}-${anthropicSwapped[1]}`);
  }
  // anthropic-claude-opus-5 → anthropic/claude-opus-5
  // also normalize dotted versions: anthropic-claude-opus-4.6 → anthropic/claude-opus-4-6
  const anthropicFamily = id.match(/^anthropic-claude-([a-z]+)-(\d+(?:\.\d+)?)$/);
  if (anthropicFamily !== null) {
    const version = anthropicFamily[2].replaceAll(".", "-");
    candidates.push(`anthropic/claude-${anthropicFamily[1]}-${anthropicFamily[2]}`);
    candidates.push(`anthropic/claude-${anthropicFamily[1]}-${version}`);
  }
  if (id.startsWith("anthropic-")) candidates.push(`anthropic/${id.slice("anthropic-".length)}`);

  for (const candidate of candidates) {
    const resolved = resolveCanonicalBaseModel(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
