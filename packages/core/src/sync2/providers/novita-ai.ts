// Novita AI: https://api.novita.ai/openai/v1/models (NOVITA_AI_API_KEY, or a
// local NOVITA_AI_MODELS_DEV_KEY). The list is account-scoped and leaves out
// working and non-chat routes, so a file it no longer lists is kept and reported.
// Authoritative for chat routes: token, cache, audio, image and video input
// prices, the long-context band, context and output limits, and the APIs a
// route serves (Chat Completions, Anthropic Messages, Responses). Capabilities
// and reasoning controls stay hand-authored, so new models are added by hand.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const ENDPOINT = "https://api.novita.ai/openai/v1/models";
// Unadvertised/development aliases observed in the 2026-10-09 catalog audit.
// Sao10K is separately deferred until exact IDs have a portable file representation.
const IGNORED_IDS = new Set([
  "bunny",
  "dev/glm46",
  "deepseek/deepseek-r1/community",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-0731-p",
  "deepseek/deepseek-v4-pro-0813-p",
  "deepseek/deepseek-v4.1-flash-dst",
  "deepseek/deepseek-v4.1-flash-p",
  "moonshotai/kimi-k3-p",
  // Undocumented routing aliases (2026-10-28): $0 placeholder prices and no published target models.
  "nvrouter/auto",
  "nvrouter/fusion",
  "zai-org/glm-4.7-h",
  "zai-org/glm-5.3-p",
]);

const Price = z.object({
  price_per_m_decimal: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  price_per_m: z.number().finite().nonnegative().optional(),
}).passthrough();

// Per-modality token prices on multimodal routes; integers scaled by 10,000 like the legacy fields.
const ModalPrice = z.object({
  modals: z.array(z.string()),
  input_token_base_price: z.number().finite().nonnegative().optional(),
  input_token_discount_price: z.number().finite().nonnegative().optional(),
  output_token_base_price: z.number().finite().nonnegative().optional(),
  output_token_discount_price: z.number().finite().nonnegative().optional(),
}).passthrough();

const Pricing = z.object({
  prompt: Price.optional(),
  completion: Price.optional(),
  input_cache_read: Price.optional(),
  input_cache_write: Price.optional(),
  multimodal_input: z.array(ModalPrice).optional(),
  multimodal_output: z.array(ModalPrice).optional(),
}).passthrough();
type Pricing = z.infer<typeof Pricing>;

const NovitaModel = z.object({
  id: z.string().min(1),
  model_type: z.string().optional(),
  context_size: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  input_token_price_per_m: z.number().finite().nonnegative().optional(),
  output_token_price_per_m: z.number().finite().nonnegative().optional(),
  pricing: Pricing.optional(),
  is_tiered_billing: z.boolean().optional(),
  // "chat/completions", "anthropic", "responses", plus legacy "completions" and "batch-api", which have no API table.
  endpoints: z.array(z.string()).nullish(),
  tiered_billing_configs: z.array(z.object({ min_tokens: z.number().int().nonnegative(), pricing: Pricing }).passthrough()).optional(),
}).passthrough();
type NovitaModel = z.infer<typeof NovitaModel>;

const NovitaResponse = z.object({ data: z.array(NovitaModel).nonempty() });

// Chat Completions is the provider default (https://api.novita.ai/openai); Anthropic Messages and
// Responses have their own base URLs. A route outside a listed API answers 400 "does not support endpoint".
// https://novita.ai/docs/guides/llm-anthropic-compatibility
const APIS = {
  "chat/completions": ["chat-completions", {}],
  anthropic: ["messages", {
    base_url: "https://api.novita.ai/anthropic/v1",
    sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" },
  }],
  responses: ["responses", {
    base_url: "https://api.novita.ai/openai/v1",
    sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
  }],
} as const;

export const novitaAi: SyncModule<unknown> = {
  id: "novita-ai",
  name: "Novita AI",
  policy: {
    owns: [
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      { path: "cost.text.input.cache.read", merge: "nonzero" },
      { path: "cost.text.input.cache.write", merge: "nonzero" },
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
      "cost.audio.input.price",
      "cost.image.input.price",
      "cost.video.input.price",
      { path: "api", merge: "tables" },
    ],
    creates: "gap",
    removals: "keep",
  },
  fetch: () => fetchJSON(ENDPOINT, { source: "Novita models", headers: bearer(requireEnv("Novita", "NOVITA_AI_MODELS_DEV_KEY", "NOVITA_AI_API_KEY")) }),
  observe(raw) {
    return NovitaResponse.parse(raw).data.map((model) => (eligible(model) ? observe(model) : { id: model.id, updateOnly: true }));
  },
};

// Decimal fields are already USD/MTok; legacy integers are scaled by 10,000.
function price(value: z.infer<typeof Price> | undefined, legacy?: number): number | undefined {
  const scaled = value?.price_per_m ?? legacy;
  const amount = value?.price_per_m_decimal !== undefined ? Number(value.price_per_m_decimal) : scaled === undefined ? undefined : scaled / 10_000;
  if (amount !== undefined && !Number.isFinite(amount)) throw new Error("Invalid Novita price");
  return amount;
}

function eligible(model: NovitaModel) {
  return !IGNORED_IDS.has(model.id)
    && !/^(?:dev|pa)\//.test(model.id)
    && !model.id.toLowerCase().startsWith("sao10k/")
    && (model.model_type === undefined || model.model_type === "chat")
    && model.context_size > 0 && (model.max_output_tokens ?? 0) > 0
    && price(model.pricing?.prompt, model.input_token_price_per_m) !== undefined
    && price(model.pricing?.completion, model.output_token_price_per_m) !== undefined;
}

// One modality's per-token price (USD/MTok) from the multimodal price lists, if the route lists one.
function modalPrice(list: z.infer<typeof ModalPrice>[] | undefined, modal: string, side: "input" | "output") {
  const entry = list?.find((item) => item.modals.length === 1 && item.modals[0] === modal);
  const scaled = entry?.[`${side}_token_discount_price`] ?? entry?.[`${side}_token_base_price`];
  return scaled === undefined ? undefined : scaled / 10_000;
}

function observe(model: NovitaModel): Observation {
  const tiers = model.is_tiered_billing ? [...model.tiered_billing_configs ?? []].sort((a, b) => a.min_tokens - b.min_tokens) : [];
  if (model.is_tiered_billing && (tiers.length === 0 || tiers[0]!.min_tokens > 1 || new Set(tiers.map((tier) => tier.min_tokens)).size !== tiers.length)) {
    throw new Error(`Novita ${model.id} has missing or duplicate pricing tiers`);
  }
  // A tiered route's base prices are its first tier.
  const base = tiers[0]?.pricing ?? model.pricing;
  const input = price(base?.prompt) ?? price(model.pricing?.prompt, model.input_token_price_per_m)!;
  const output = price(base?.completion) ?? price(model.pricing?.completion, model.output_token_price_per_m)!;
  const bands = tiers.slice(1).map((tier) => {
    const when = { context: { gt: tier.min_tokens } };
    const cacheRead = price(tier.pricing.input_cache_read);
    const cacheWrite = price(tier.pricing.input_cache_write);
    const cache = { ...(cacheRead ? { read: cacheRead } : {}), ...(cacheWrite ? { write: cacheWrite } : {}) };
    return {
      input: { when, price: price(tier.pricing.prompt) ?? input, ...(Object.keys(cache).length > 0 ? { cache } : {}) },
      output: { when, price: price(tier.pricing.completion) ?? output },
    };
  });
  // is_tiered_billing false is a flat price; unset says nothing about bands.
  const overrides = (side: "input" | "output") =>
    model.is_tiered_billing === undefined ? {} : { overrides: bands.length > 0 ? bands.map((band) => band[side]) : null };
  const media = (modal: string) => {
    const amount = modalPrice(model.pricing?.multimodal_input, modal, "input");
    return amount === undefined ? {} : { [modal]: { input: { price: amount } } };
  };
  const endpoints = model.endpoints ?? [];
  return {
    id: model.id,
    limit: { context: model.context_size, output: model.max_output_tokens },
    cost: {
      text: {
        input: { price: input, cache: { read: price(base?.input_cache_read), write: price(base?.input_cache_write) }, ...overrides("input") },
        output: { price: output, ...overrides("output") },
      },
      ...media("audio"),
      ...media("image"),
      ...media("video"),
    },
    ...(endpoints.length > 0
      ? { api: Object.fromEntries(Object.entries(APIS).map(([endpoint, [protocol, table]]) => [protocol, endpoints.includes(endpoint) ? structuredClone(table) : null])) }
      : {}),
  };
}
