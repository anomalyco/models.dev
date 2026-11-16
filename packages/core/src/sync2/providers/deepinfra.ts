// Deep Infra: the public deploy catalog (https://api.deepinfra.com/models/list?type=text-generation;
// DEEPINFRA_API_KEY optional). Richer than /v1/openai/models: capability tags,
// token prices with cache rates and service tiers, the served context window
// and deprecation.
// Authoritative: token and cache prices (context bands parsed from the
// free-text `full` price), service tiers and their multipliers, prompt
// caching, the context window and deprecation. Tags only ever turn tools,
// structured output, reasoning and input kinds on (only `non-reasoning` turns
// reasoning off), and `can-disable-reasoning` seeds a toggle on a file that
// doesn't state its reasoning controls yet. Embedding files are hand-authored.
// New models are created from a lab file when they're priced and not
// deprecated. Models the API drops are kept for review.

import { z } from "zod";

import { bearer, fetchJSON } from "../http.js";
import { namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.deepinfra.com/models/list?type=text-generation";

const DeepInfraModel = z.object({
  model_name: z.string().min(1),
  type: z.string(),
  tags: z.array(z.string()).nullish(),
  pricing: z.object({
    cents_per_input_token: z.number().nullish(),
    cents_per_output_token: z.number().nullish(),
    // Cache rates are multipliers on the input price, not prices.
    rate_per_input_token_cached: z.number().nullish(),
    rate_per_input_token_cache_write: z.number().nullish(),
    // Prompt cache retention (`prompt_cache_options.ttl`): the write rate per
    // TTL, and the block size cached prefixes are rounded down to.
    rate_per_explicit_cache_write_token: z.record(z.number()).nullish(),
    explicit_cache_granularity_tokens: z.number().int().positive().nullish(),
    // `service_tier` price multipliers.
    rate_per_service_tier_priority: z.number().nullish(),
    rate_per_service_tier_flex: z.number().nullish(),
    // Free text; lists context bands when the model has them.
    full: z.string().nullish(),
  }).passthrough().nullish(),
  // The served context window, not a completion cap.
  max_tokens: z.number().int().positive().nullish(),
  // null when active; a unix timestamp (maybe in the future) when scheduled.
  deprecated: z.union([z.number(), z.string(), z.boolean()]).nullish(),
  private: z.number().nullish(),
}).passthrough();
type DeepInfraModel = z.infer<typeof DeepInfraModel>;

// Proprietary models Deep Infra resells aren't in this provider's catalog
// (open Gemma models are; only Gemini is left out).
const EXCLUDED = [/^anthropic\//, /^google\/gemini/];

// Deep Infra's Hugging Face style namespaces, as the lab namespaces the shared resolver knows.
const NAMESPACES: Record<string, string> = {
  ByteDance: "bytedance-seed",
  "deepseek-ai": "deepseek",
  "meta-llama": "meta",
  google: "google",
  microsoft: "microsoft",
  MiniMaxAI: "minimax",
  mistralai: "mistralai",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  Qwen: "qwen",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

// Deep Infra tags the whole Gemma 4 family `input-audio`, but its model page
// limits audio input to the E2B and E4B variants.
const UNSUPPORTED_INPUT: Record<string, string[]> = {
  "google/gemma-4-31B-it": ["audio"],
};

export const deepinfra: SyncModule<unknown> = {
  id: "deepinfra",
  name: "Deep Infra",
  policy: {
    owns: [
      { path: "status", merge: "deprecated" },
      { path: "modalities.input", merge: "kinds", addOnly: true },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      { path: "capabilities.reasoning.toggle", merge: "seed" },
      "capabilities.structured_output",
      "capabilities.cache",
      "capabilities.prompt_cache_key",
      "capabilities.service_tier",
      "limit.context",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.input.cache.explicit",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
      "cost.multipliers",
    ],
    creates: "auto",
    // Deep Infra rotates models often; a dropped model is reviewed by hand.
    removals: "keep",
    omitLabInput: true,
  },
  fetch: () => {
    const key = process.env.DEEPINFRA_API_KEY;
    return fetchJSON(API_ENDPOINT, { source: "Deep Infra models", headers: key ? bearer(key) : {} });
  },
  observe(raw) {
    return z.array(DeepInfraModel).parse(raw)
      .filter((model) => (model.type === "text-generation" || model.type === "embeddings") && !model.private && !excluded(model.model_name))
      .map((model) => observe(model));
  },
  manages: (id) => !excluded(id),
};

function excluded(id: string) {
  return EXCLUDED.some((pattern) => pattern.test(id));
}

function observe(model: DeepInfraModel, now = Date.now()): Observation {
  const id = model.model_name;
  // Embedding files are hand-authored; keep them as written.
  if (model.type === "embeddings") return { id, updateOnly: true };
  const tags = new Set(model.tags ?? []);
  const input = perMillion(model.pricing?.cents_per_input_token);
  const output = perMillion(model.pricing?.cents_per_output_token);
  const deprecated = isDeprecated(model, now);
  const reasoning = tags.has("reasoning") || tags.has("can-disable-reasoning") ? true : tags.has("non-reasoning") ? false : undefined;
  const unsupported = UNSUPPORTED_INPUT[id] ?? [];
  const kinds = [
    ...(tags.has("multimodal") ? ["image"] : []),
    ...(tags.has("input-audio") ? ["audio"] : []),
    ...(tags.has("input-video") ? ["video"] : []),
  ].filter((kind) => !unsupported.includes(kind));
  const priced = input === undefined || output === undefined ? undefined : cost(model, input, output);
  // Unpriced, the file's prices stay and so does its caching.
  const cached = priced === undefined ? undefined : priced.text.input.cache.read !== null;

  return {
    id,
    base: baseHints(id),
    // A new model needs a price, and isn't added once it's deprecated.
    ...(input === undefined || output === undefined || deprecated ? { updateOnly: true } : {}),
    status: deprecated ? "deprecated" : null,
    ...(kinds.length > 0 ? { modalities: { input: ["text", ...kinds] } } : {}),
    capabilities: {
      ...(tags.has("tools") ? { tools: { supported: true } } : {}),
      ...(reasoning === undefined ? {} : { reasoning: { supported: reasoning, ...(tags.has("can-disable-reasoning") ? { toggle: true } : {}) } }),
      ...(tags.has("structured-output") || tags.has("structured_output") ? { structured_output: true } : {}),
      ...serviceCapabilities(model, cached),
    },
    ...(model.max_tokens == null ? {} : { limit: { context: model.max_tokens } }),
    cost: { ...priced, ...multipliers(model) },
  } as Observation;
}

function tiers(model: DeepInfraModel) {
  const pricing = model.pricing;
  return ([["priority", pricing?.rate_per_service_tier_priority], ["flex", pricing?.rate_per_service_tier_flex]] as const)
    .filter((entry): entry is readonly ["priority" | "flex", number] => typeof entry[1] === "number" && entry[1] > 0);
}

function retention(model: DeepInfraModel) {
  return Object.entries(model.pricing?.rate_per_explicit_cache_write_token ?? {})
    .filter(([ttl, rate]) => /^\d+(ms|s|m|h|d)$/.test(ttl) && Number.isFinite(rate) && rate >= 0);
}

function serviceCapabilities(model: DeepInfraModel, cached: boolean | undefined) {
  const ttls = retention(model);
  const granularity = model.pricing?.explicit_cache_granularity_tokens;
  const serviceTiers = tiers(model);
  return {
    ...(cached === undefined ? {} : caching(cached, ttls, granularity)),
    service_tier: serviceTiers.length > 0 ? serviceTiers.map(([tier]) => tier).sort() : null,
  };
}

function caching(cached: boolean, ttls: Array<[string, number]>, granularity: number | null | undefined) {
  return {
    cache: cached
      ? { implicit: true, ...(ttls.length > 0 ? { explicit: { ttl: ttls.map(([ttl]) => ttl), ...(granularity == null ? {} : { min_tokens: granularity }) } } : {}) }
      : null,
    prompt_cache_key: cached ? true : null,
  };
}

function multipliers(model: DeepInfraModel) {
  const serviceTiers = tiers(model);
  return { multipliers: serviceTiers.length > 0 ? serviceTiers.map(([tier, factor]) => ({ when: { service_tier: { equals: tier } }, factor })) : null };
}

function cost(model: DeepInfraModel, flatInput: number, flatOutput: number) {
  const pricing = model.pricing;
  const writeRate = pricing?.rate_per_input_token_cache_write;
  const banded = parseBands(pricing?.full);
  const input = banded === undefined ? flatInput : round(banded.base.input);
  const output = banded === undefined ? flatOutput : round(banded.base.output);
  const read = banded === undefined
    ? (pricing?.rate_per_input_token_cached == null ? undefined : round(flatInput * pricing.rate_per_input_token_cached))
    : (banded.base.cache_read === undefined ? undefined : round(banded.base.cache_read));
  const ttls = retention(model);
  // Retention write prices are a multiple of the input price; with context
  // bands they'd differ per band, which the catalog doesn't spell out.
  const explicit = ttls.length > 0 && banded === undefined ? { write: Object.fromEntries(ttls.map(([ttl, rate]) => [ttl, round(flatInput * rate)])) } : null;
  const when = (size: number) => ({ context: { gt: size } });
  return {
    text: {
      input: {
        price: input,
        cache: {
          read: read ?? null,
          write: writeRate == null ? null : round(input * writeRate),
          ...(read === undefined ? {} : { explicit }),
        },
        overrides: banded === undefined ? null : banded.tiers.map((tier) => ({
          when: when(tier.size),
          price: round(tier.input),
          ...(tier.cache_read === undefined ? {} : { cache: { read: round(tier.cache_read) } }),
        })),
      },
      output: {
        price: output,
        overrides: banded === undefined ? null : banded.tiers.map((tier) => ({ when: when(tier.size), price: round(tier.output) })),
      },
    },
  };
}

function baseHints(id: string) {
  const [namespace, ...rest] = id.split("/");
  if (namespace === undefined || rest.length === 0) return [];
  const mapped = NAMESPACES[namespace];
  return mapped === undefined ? namespaceHints(id) : namespaceHints(`${mapped}/${rest.join("/").toLowerCase()}`);
}

function isDeprecated(model: DeepInfraModel, now: number) {
  const deprecated = model.deprecated;
  if (deprecated == null || deprecated === false) return false;
  // A unix timestamp; a future one is scheduled and the model is still served.
  if (typeof deprecated === "number") return deprecated * 1000 <= now;
  return Boolean(deprecated);
}

// Cents per token as USD per 1M tokens.
function perMillion(cents: number | null | undefined) {
  if (cents == null || !Number.isFinite(cents) || cents < 0) return undefined;
  return round(cents * 10_000);
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// The free-text banded price, e.g.
//   "$1.2 in $6 out $0.24 cached <= 32K, $2.4 in $12 out $0.48 cached <= 128K, $3 in $15 out $0.6 cached > 128K"
// as the first band's prices and one override per later band, starting where
// the previous band ends. Undefined for a flat price or any other shape.
function parseBands(full: string | null | undefined) {
  if (full == null || !/[\d.]\s*[KM]\b/i.test(full)) return undefined;
  const segments = full.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return undefined;
  const parsed: Array<{ input: number; output: number; cache_read: number | undefined; bound: number | undefined }> = [];
  for (const segment of segments) {
    const match = segment.match(/^\$\s*([\d.]+)\s+in\s+\$\s*([\d.]+)\s+out(?:\s+\$\s*([\d.]+)\s+cached)?(?:\s+(?:<=|>)\s*([\d.]+)\s*([KM]))?\s*$/i);
    if (match === null) return undefined;
    parsed.push({
      input: Number(match[1]),
      output: Number(match[2]),
      cache_read: match[3] === undefined ? undefined : Number(match[3]),
      bound: match[4] === undefined ? undefined : Math.round(Number(match[4]) * (match[5]!.toUpperCase() === "M" ? 1_000_000 : 1_000)),
    });
  }
  if (parsed.slice(0, -1).some((segment) => segment.bound === undefined)) return undefined;
  const tiers = parsed.slice(1).map((segment, index) => ({ size: parsed[index]!.bound!, input: segment.input, output: segment.output, cache_read: segment.cache_read }));
  for (let index = 1; index < tiers.length; index++) {
    if (tiers[index]!.size <= tiers[index - 1]!.size) return undefined;
  }
  return { base: parsed[0]!, tiers };
}
