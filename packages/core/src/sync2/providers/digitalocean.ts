// DigitalOcean: the account's models (https://api.digitalocean.com/v2/gen-ai/models,
// DIGITALOCEAN_API_TOKEN or DIGITALOCEAN_ACCESS_TOKEN) joined with the public
// catalog (https://api.digitalocean.com/v2/gen-ai/models/catalog and its
// per-model detail for serverless models). Only serverless models with text
// output are synced; embedding and reranking models are hand-authored.
// Authoritative: name, lifecycle status, input and output kinds, limits,
// whether a text model reasons and its efforts, token and cache prices, the
// long-context band, service-tier prices (Fast, Flex, Ultrafast), image token
// prices, and for chat models the Responses and Messages APIs and the web search price.
// Files the source stops listing are kept.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import { namespaceHints } from "../labs.js";
import { equal, getPath, isTable, setPath } from "../fields.js";
import type { Doc, Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

const MODELS_API = "https://api.digitalocean.com/v2/gen-ai/models?per_page=200";
const CATALOG_API = "https://api.digitalocean.com/v2/gen-ai/models/catalog?limit=200";
const CATALOG_DETAIL_API = "https://api.digitalocean.com/v2/gen-ai/models/catalog";

const Model = z.object({
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
  endpoints: z.array(z.object({ capabilities: z.array(z.string()).optional() }).passthrough()).optional(),
  context_window: z.union([z.number(), z.string()]).optional(),
  modalities: z.object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() }).optional(),
}).passthrough();
type Model = z.infer<typeof Model>;

const Pricing = z.object({
  input_price_per_million: z.number().optional(),
  output_price_per_million: z.number().optional(),
  cache_read_input_price_per_million: z.number().optional(),
  cache_write_5m_input_price_per_million: z.number().optional(),
  cache_write_1h_input_price_per_million: z.number().optional(),
  image_input_price_per_million: z.number().optional(),
  image_output_price_per_million: z.number().optional(),
  image_cache_read_input_price_per_million: z.number().optional(),
}).passthrough();
type Pricing = z.infer<typeof Pricing>;

const CatalogModel = z.object({
  id: z.string().min(1).optional(),
  model_id: z.string().min(1),
  name: z.string().min(1),
  creator: z.string().optional(),
  context_window: z.union([z.number(), z.string()]).nullish(),
  max_output_tokens: z.union([z.number(), z.string()]).nullish(),
  availability: z.array(z.string()).optional(),
  modalities: z.object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() }).nullish(),
  pricing: Pricing.nullish(),
  pricing_detail: z.object({
    variants: z.array(z.object({ tier: z.string().nullish(), label: z.string().optional(), mode: z.string().optional(), prices: Pricing.nullish() }).passthrough()),
  }).nullish(),
}).passthrough();
type CatalogModel = z.infer<typeof CatalogModel>;

const Raw = z.object({ models: z.array(Model), catalog: z.array(CatalogModel) });

const Page = z.object({
  links: z.object({ pages: z.object({ next: z.string().nullable().optional() }).passthrough().optional() }).passthrough().optional(),
  meta: z.object({ page: z.number().int().positive(), pages: z.number().int().nonnegative() }).passthrough().optional(),
}).passthrough();

// Chat models answer POST /v1/chat/completions (the provider default). Models the
// catalog flags `responses` also answer POST /v1/responses. POST /v1/messages
// (Anthropic format) serves those and the DigitalOcean-hosted models (the ones
// with their own `endpoints`).
// https://docs.digitalocean.com/products/inference/how-to/si-endpoints/
// https://docs.digitalocean.com/products/inference/how-to/use-messages-api/
// OpenAI models are relayed to OpenAI, where every model answers Responses; the
// catalog leaves the flag off older ones (live 2026-10-22).
const RESPONSES_CREATORS = new Set(["OpenAI"]);
const RESPONSES_API = { sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" } };
const MESSAGES_API = { sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" } };

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

// The catalog advertises these inputs, but the standard serverless endpoint
// rejects them (400 "unsupported multimodal content", verified 2026-10-16).
const UNSUPPORTED_INPUT: Record<string, string[]> = { "glm-5.3-flash": ["image", "video"] };

const KINDS = new Set(["text", "audio", "image", "video", "pdf"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface Prices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

export const digitalocean: SyncModule<unknown> = {
  id: "digitalocean",
  name: "DigitalOcean",
  policy: {
    owns: [
      "name",
      "status",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.reasoning.supported",
      "capabilities.reasoning.effort",
      "capabilities.service_tier",
      "limit.context",
      "limit.output",
      { path: "api", merge: "tables" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands", replaces: ["service_tier"], optional: true },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands", replaces: ["service_tier"], optional: true },
      "cost.image",
      "cost.web_search",
    ],
    creates: "auto",
    removals: "keep",
    omitLabInput: true,
  },
  async fetch() {
    const key = requireEnv("DigitalOcean", "DIGITALOCEAN_API_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN");
    const [models, catalog] = await Promise.all([
      pages(MODELS_API, "DigitalOcean models", { ...bearer(key), "Content-Type": "application/json" }, "models"),
      pages(CATALOG_API, "DigitalOcean catalog", { "Content-Type": "application/json", "User-Agent": "models.dev/digitalocean-sync" }, "data"),
    ]);
    // Modalities and price variants are only on a serverless model's detail page.
    const detailed = await Promise.all((catalog as CatalogModel[]).map(async (model) => {
      if (model.id === undefined || model.availability?.includes("serverless") !== true) return model;
      const detail = await fetchJSON(`${CATALOG_DETAIL_API}/${model.id}`, { source: "DigitalOcean catalog detail", headers: { "User-Agent": "models.dev/digitalocean-sync" } });
      const data = CatalogModel.parse((detail as { data: unknown }).data);
      return { ...model, modalities: data.modalities ?? model.modalities, pricing_detail: data.pricing_detail ?? model.pricing_detail };
    }));
    return { models, catalog: detailed };
  },
  observe(raw) {
    const { models, catalog } = Raw.parse(raw);
    const byID = new Map(catalog.map((model) => [model.model_id, model]));
    return models.flatMap((model) => {
      const entry = byID.get(model.id);
      const output = kinds((entry?.modalities ?? model.modalities)?.output ?? []);
      if (entry?.availability?.includes("serverless") !== true || !output.includes("text") || model.type === "embedding" || model.type === "reranking") return [];
      return [observe(model, entry, output)];
    });
  },
  refine(observation, file) {
    let refined = keepBandCache(observation, file);
    // An active model clears deprecated or beta, never another status.
    if (refined.status === null && file !== undefined && file.status !== "deprecated" && file.status !== "beta") {
      const { status: _status, ...rest } = refined;
      refined = rest;
    }
    return refined;
  },
};

// A long-context band keeps the file's cache prices the catalog doesn't list.
function keepBandCache(observation: Observation, file: Doc | undefined): Observation {
  const overrides = observation.cost?.text?.input?.overrides;
  const own = getPath(file, "cost.text.input.overrides");
  if (!Array.isArray(overrides) || !Array.isArray(own)) return observation;
  const contextOnly = (item: unknown) => isTable(item) && isTable(item.when) && Object.keys(item.when).join() === "context";
  const next = overrides.map((band) => {
    if (!contextOnly(band)) return band;
    const match = own.find((item) => contextOnly(item) && equal(item.when, band.when));
    if (!isTable(match) || !isTable(match.cache)) return band;
    return { ...band, cache: { ...match.cache, ...(isTable(band.cache) ? band.cache : {}) } };
  });
  const refined = structuredClone(observation) as Doc;
  setPath(refined, "cost.text.input.overrides", next);
  return refined as Observation;
}

async function pages(start: string, source: string, headers: Record<string, string>, key: "models" | "data") {
  const items: unknown[] = [];
  const visited = new Set<string>();
  let url: string | undefined = start;
  while (url !== undefined) {
    if (visited.has(url)) throw new Error(`${source} pagination repeated URL: ${url}`);
    visited.add(url);
    const body = await fetchJSON(url, { source, headers }) as Record<string, unknown>;
    const list = body[key];
    if (!Array.isArray(list)) throw new Error(`${source} returned no ${key} list`);
    items.push(...list);
    const page = Page.parse(body);
    const next = page.links?.pages?.next;
    if (next) url = new URL(next, url).toString();
    else if (page.meta !== undefined && page.meta.page < page.meta.pages) {
      const following: URL = new URL(url);
      following.searchParams.set("page", String(page.meta.page + 1));
      url = following.toString();
    } else url = undefined;
  }
  return items;
}

function observe(model: Model, entry: CatalogModel, output: string[]): Observation {
  const id = model.id;
  const prices = pricing(entry);
  const context = count(entry.context_window ?? model.context_window);
  const maxOutput = count(entry.max_output_tokens ?? undefined);
  // Without both token prices, or (for a new model) a context window and output
  // limit, the model is only matched so its file isn't reported as dropped.
  if (prices?.input === undefined || prices.output === undefined) return { id, updateOnly: true };
  const complete = context !== undefined && context > 0 && maxOutput !== undefined && maxOutput > 0;

  const unsupported = UNSUPPORTED_INPUT[id] ?? [];
  const input = kinds((entry.modalities ?? model.modalities)?.input ?? []).filter((kind) => !unsupported.includes(kind));
  const textOnly = !output.includes("image") && !output.includes("video");
  const efforts = [...new Set((model.reasoning_efforts ?? []).map((value) => value.trim().toLowerCase().replaceAll("_", "-").replace(/^x-high$/, "xhigh")))]
    .filter((value) => EFFORTS.has(value));
  const reasoning = !textOnly
    ? undefined
    : model.thinking === true || efforts.length > 0
      ? { supported: true, ...(efforts.length > 0 ? { effort: reasoningControls({ effort: efforts }).effort } : {}) }
      : model.thinking === false ? { supported: false } : undefined;

  const chat = model.type === "chat" && output.every((kind) => kind === "text");
  const responses = model.capabilities?.includes("responses") === true || RESPONSES_CREATORS.has(entry.creator ?? "");
  const hosted = model.endpoints?.some((endpoint) => endpoint.capabilities?.includes("chat_completions")) === true;
  const tiers = serviceTiers(entry.creator, prices.serviceTiers);
  const extended = prices.extended?.input !== undefined && prices.extended.output !== undefined ? prices.extended : undefined;
  const when = extended === undefined ? undefined : { context: { gt: extended.context } };

  return {
    id,
    base: baseHints(id),
    ...(complete ? {} : { updateOnly: true }),
    name: entry.name,
    status: status(model.lifecycle_status),
    modalities: {
      ...(input.length > 0 ? { input: input.map(format) } : {}),
      ...(output.length > 0 ? { output: output.map(format) } : {}),
    },
    capabilities: {
      ...(reasoning === undefined ? {} : { reasoning }),
      service_tier: tiers.names.length > 0 ? tiers.names : null,
    },
    limit: { ...(context === undefined ? {} : { context }), ...(maxOutput === undefined ? {} : { output: maxOutput }) },
    ...(chat ? { api: { responses: responses ? RESPONSES_API : null, messages: responses || hosted ? MESSAGES_API : null } } : {}),
    cost: {
      text: {
        input: {
          price: prices.input,
          ...(prices.cacheRead === undefined && prices.cacheWrite === undefined
            ? {}
            : { cache: { ...(prices.cacheRead === undefined ? {} : { read: prices.cacheRead }), ...(prices.cacheWrite === undefined ? {} : { write: write(prices.cacheWrite, prices.cacheWrite1h) }) } }),
          overrides: [
            ...(extended === undefined ? [] : [{ when, price: extended.input, ...cache(extended) }]),
            ...tiers.input,
          ],
        },
        output: {
          price: prices.output,
          overrides: [...(extended === undefined ? [] : [{ when, price: extended.output }]), ...tiers.output],
        },
      },
      ...(prices.image === undefined ? {} : { image: prices.image }),
      ...(chat ? { web_search: { price: entry.creator === "Anthropic" ? 0 : WEB_SEARCH_PRICE } } : {}),
    },
  } as Observation;
}

function pricing(model: CatalogModel) {
  if (model.pricing == null) return undefined;
  const interactive = (model.pricing_detail?.variants ?? []).filter((variant) => variant.mode === "MODEL_BILLING_MODE_INTERACTIVE");
  const standard = interactive.find((variant) => variant.tier === "MODEL_PRICING_TIER_STANDARD")?.prices;
  const long = interactive.find((variant) => variant.tier?.startsWith("MODEL_PRICING_TIER_EXTENDED_") === true || longContextLabel(variant.label) !== undefined);
  const context = tierContext(long?.tier ?? undefined) ?? longContextLabel(long?.label);
  const serviceTiers = interactive.flatMap((variant) =>
    variant.label !== undefined && tierLabel(variant.label) !== undefined && variant.prices != null ? [{ label: variant.label, prices: variantPrices(variant.prices) }] : []);
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
    extended: context === undefined || long?.prices == null ? undefined : { context, ...variantPrices(long.prices) },
    serviceTiers,
    image: image.input === undefined && image.output === undefined
      ? undefined
      : {
          ...(image.input === undefined ? {} : { input: { price: image.input, ...(image.cacheRead === undefined ? {} : { cache: { read: image.cacheRead } }) } }),
          ...(image.output === undefined ? {} : { output: { price: image.output } }),
        },
  };
}

function variantPrices(prices: Pricing): Prices {
  return {
    input: perMillion(prices.input_price_per_million),
    output: perMillion(prices.output_price_per_million),
    cacheRead: perMillion(prices.cache_read_input_price_per_million),
    cacheWrite: perMillion(prices.cache_write_5m_input_price_per_million),
    cacheWrite1h: perMillion(prices.cache_write_1h_input_price_per_million),
  };
}

// Service-tier prices as overrides, plain ones before long-context ones (the later override wins).
function serviceTiers(creator: string | undefined, variants: Array<{ label: string; prices: Prices }>) {
  const input: Array<Record<string, unknown>> = [];
  const output: Array<Record<string, unknown>> = [];
  const names = new Set<string>();
  for (const { label, prices } of variants) {
    const parsed = tierLabel(label)!;
    const tier = SERVICE_TIERS[creator ?? ""]?.[parsed.mode];
    if (tier === undefined) continue;
    names.add(tier);
    const when = { service_tier: { equals: tier }, ...(parsed.context === undefined ? {} : { context: { gt: parsed.context } }) };
    if (prices.input !== undefined) input.push({ when, price: prices.input, ...cache(prices) });
    if (prices.output !== undefined) output.push({ when, price: prices.output });
  }
  const byContext = (a: Record<string, unknown>, b: Record<string, unknown>) => Number("context" in (a.when as object)) - Number("context" in (b.when as object));
  return {
    input: input.sort(byContext),
    output: output.sort(byContext),
    names: [...names].sort((a, b) => SERVICE_TIER_ORDER.indexOf(a) - SERVICE_TIER_ORDER.indexOf(b)),
  };
}

function cache(prices: Prices) {
  const value = {
    ...(prices.cacheRead === undefined ? {} : { read: prices.cacheRead }),
    ...(prices.cacheWrite === undefined ? {} : { write: write(prices.cacheWrite, prices.cacheWrite1h) }),
  };
  return Object.keys(value).length > 0 ? { cache: value } : {};
}

function write(write5m: number, write1h: number | undefined) {
  return write1h === undefined ? write5m : { "5m": write5m, "1h": write1h };
}

// "Fast Mode", "Flex Mode", "Ultrafast Mode", each optionally followed by
// " (Prompts > 272K tokens)" for its long-context price.
function tierLabel(label: string) {
  const match = label.match(/^(Fast|Flex|Ultrafast) Mode(?: \(Prompts > (\d+)K tokens\))?$/);
  if (match === null) return undefined;
  return { mode: match[1]!.toLowerCase() as "fast" | "flex" | "ultrafast", context: match[2] === undefined ? undefined : Number(match[2]) * 1_000 };
}

// Untiered long-context variants carry the threshold in the label: "Long form context (> 100k)".
function longContextLabel(label: string | undefined) {
  const match = label?.match(/^Long form context \(> (\d+)k\)$/i);
  return match ? Number(match[1]) * 1_000 : undefined;
}

// Tier names describe capacity; Anthropic's 1M surcharge starts above 200K.
function tierContext(tier: string | undefined) {
  if (tier === "MODEL_PRICING_TIER_EXTENDED_1M") return 200_000;
  if (tier === "MODEL_PRICING_TIER_EXTENDED_272K") return 272_000;
  return undefined;
}

// The catalog returns per-token rates despite the `per_million` field names.
function perMillion(value: number | undefined) {
  if (value === undefined) return undefined;
  const normalized = value < 0.001 ? value * 1_000_000 : value;
  return Math.round(normalized * 10_000) / 10_000;
}

function count(value: string | number | undefined | null) {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function kinds(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()).map((value) => (value === "code" ? "text" : value)).filter((value) => KINDS.has(value)))];
}

const format = (kind: string) => (kind === "pdf" ? "application/pdf" : kind);

// Retired models stay in the models feed with no lifecycle status.
function status(lifecycle: string | undefined) {
  if (lifecycle === undefined) return "deprecated";
  const value = lifecycle.trim().toLowerCase().replaceAll("_", "-");
  if (value === "") return undefined;
  if (value === "deprecated" || value === "end-of-life") return "deprecated";
  if (value === "public-preview" || value === "preview") return "beta";
  return null;
}

// DigitalOcean IDs name the lab with a prefix: `openai-gpt-5`, `anthropic-claude-5-sonnet`.
function baseHints(id: string) {
  const candidates: string[] = [];
  if (id.startsWith("openai-")) candidates.push(`openai/${id.slice("openai-".length)}`);
  if (id.startsWith("deepseek-")) candidates.push(`deepseek/${id}`, `deepseek/${id.replace(/^deepseek-4-/, "deepseek-v4-")}`);
  if (id.startsWith("glm-")) candidates.push(`zai/${id}`);
  if (id.startsWith("kimi-")) candidates.push(`moonshotai/${id}`);
  if (id.startsWith("minimax-")) candidates.push(`minimax/${id}`);
  if (id.startsWith("mimo-")) candidates.push(`xiaomi/${id}`, `xiaomi/${id.replace(/^mimo-v(\d+)-(\d+)/, "mimo-v$1.$2")}`);
  if (id.startsWith("nvidia-")) candidates.push(`nvidia/${id.slice("nvidia-".length)}`);
  if (id.startsWith("alibaba-")) candidates.push(`qwen/${id.slice("alibaba-".length)}`);
  if (id.startsWith("qwen")) candidates.push(`qwen/${id}`);
  if (id.startsWith("llama")) candidates.push(`meta/${id}`);
  if (id.startsWith("mistral") || id.startsWith("ministral")) candidates.push(`mistralai/${id}`);
  if (id.startsWith("gemma")) candidates.push(`google/${id}`);
  // anthropic-claude-5-sonnet → anthropic/claude-sonnet-5
  const swapped = id.match(/^anthropic-claude-(\d+(?:\.\d+)?)-([a-z]+)$/);
  if (swapped !== null) candidates.push(`anthropic/claude-${swapped[2]}-${swapped[1]}`);
  // anthropic-claude-opus-4.6 → anthropic/claude-opus-4.6, anthropic/claude-opus-4-6
  const family = id.match(/^anthropic-claude-([a-z]+)-(\d+(?:\.\d+)?)$/);
  if (family !== null) candidates.push(`anthropic/claude-${family[1]}-${family[2]}`, `anthropic/claude-${family[1]}-${family[2]!.replaceAll(".", "-")}`);
  if (id.startsWith("anthropic-")) candidates.push(`anthropic/${id.slice("anthropic-".length)}`);
  return [...new Set(candidates.flatMap(namespaceHints))];
}
