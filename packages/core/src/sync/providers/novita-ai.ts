import { z } from "zod";

import type { ExistingModel, SyncedFullModel, SyncedModel, SyncProvider } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel } from "./openrouter.js";

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

export const NovitaModel = z.object({
  id: z.string().min(1),
  model_type: z.string().optional(),
  context_size: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  input_token_price_per_m: z.number().finite().nonnegative().optional(),
  output_token_price_per_m: z.number().finite().nonnegative().optional(),
  pricing: Pricing.optional(),
  is_tiered_billing: z.boolean().optional(),
  // APIs that serve the route: "chat/completions", "anthropic", "responses", plus legacy
  // "completions" and "batch-api", which have no API table.
  endpoints: z.array(z.string()).nullish(),
  tiered_billing_configs: z.array(z.object({
    min_tokens: z.number().int().nonnegative(),
    pricing: Pricing,
  }).passthrough()).optional(),
}).passthrough();

export type NovitaModel = z.infer<typeof NovitaModel>;

export function parseNovitaModels(raw: unknown): NovitaModel[] {
  const rows = z.object({ data: z.array(NovitaModel).nonempty() }).parse(raw).data;
  if (new Set(rows.map((model) => model.id)).size !== rows.length) {
    throw new Error("Novita returned duplicate model IDs");
  }
  return rows;
}

export async function fetchNovitaModels(
  key = process.env.NOVITA_AI_MODELS_DEV_KEY || process.env.NOVITA_AI_API_KEY,
  fetcher: typeof fetch = fetch,
) {
  if (!key) throw new Error("Novita sync requires NOVITA_AI_API_KEY (or local NOVITA_AI_MODELS_DEV_KEY)");
  const response = await fetcher(ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Novita models request failed: ${response.status}`);
  return response.json();
}

// Decimal fields are already USD/MTok; legacy integers are scaled by 10,000.
function price(value: z.infer<typeof Price> | undefined, legacy?: number): number | undefined {
  const scaled = value?.price_per_m ?? legacy;
  const amount = value?.price_per_m_decimal !== undefined
    ? Number(value.price_per_m_decimal)
    : scaled === undefined ? undefined : scaled / 10_000;
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

function cost(pricing: z.infer<typeof Pricing> | undefined, current: ExistingModel["cost"], input?: number, output?: number) {
  const result = {
    ...current,
    input: price(pricing?.prompt, input) ?? current?.input,
    output: price(pricing?.completion, output) ?? current?.output,
  };
  if (result.input === undefined || result.output === undefined) throw new Error("Novita pricing is incomplete");
  for (const [field, source] of [["cache_read", "input_cache_read"], ["cache_write", "input_cache_write"]] as const) {
    const amount = price(pricing?.[source]);
    // Zero optional fields may be placeholders, not new free-cache capabilities.
    if (amount !== undefined && (amount > 0 || current?.[field] !== undefined)) result[field] = amount;
  }
  const audio = modalPrice(pricing?.multimodal_input, "audio", "input");
  if (audio !== undefined) result.input_audio = audio;
  return result as NonNullable<ExistingModel["cost"]>;
}

// One modality's per-token price (USD/MTok) from the multimodal price lists, if the route lists one.
function modalPrice(list: z.infer<typeof ModalPrice>[] | undefined, modal: string, side: "input" | "output") {
  const entry = list?.find((item) => item.modals.length === 1 && item.modals[0] === modal);
  const scaled = entry?.[`${side}_token_discount_price`] ?? entry?.[`${side}_token_base_price`];
  return scaled === undefined ? undefined : scaled / 10_000;
}

// Image and video input prices, which v1 has no field for.
export function novitaMediaCost(model: NovitaModel) {
  const set: Record<string, unknown> = {};
  for (const modal of ["image", "video"]) {
    const amount = modalPrice(model.pricing?.multimodal_input, modal, "input");
    if (amount !== undefined) set[`cost.${modal}.input`] = (current: unknown) => ({ ...(isRecord(current) ? current : {}), price: amount });
  }
  return set;
}

// Chat Completions on https://api.novita.ai/openai (the provider default), Anthropic Messages on
// https://api.novita.ai/anthropic/v1 and Responses on https://api.novita.ai/openai/v1, per the
// route's `endpoints`. A route outside a listed API answers 400 "does not support endpoint".
// https://novita.ai/docs/guides/llm-anthropic-compatibility
const EXTRA_APIS = {
  anthropic: ["messages", {
    base_url: "https://api.novita.ai/anthropic/v1",
    sdk: { aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic-compatible" },
  }],
  responses: ["responses", {
    base_url: "https://api.novita.ai/openai/v1",
    sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai-compatible/responses" },
  }],
} as const;

// The file's API tables for the route's endpoints. The first table stays as it is (v1 reads it), or
// is the provider's Chat Completions API when the file has none; authored chat settings are kept.
export function novitaApis(endpoints: readonly string[]) {
  return (current: unknown) => {
    const tables = isRecord(current) ? current : {};
    const first = Object.keys(tables)[0] ?? "chat-completions";
    const next: Record<string, unknown> = { [first]: tables[first] ?? {} };
    if (endpoints.includes("chat/completions")) next["chat-completions"] = tables["chat-completions"] ?? {};
    for (const [endpoint, [protocol, table]] of Object.entries(EXTRA_APIS)) {
      if (endpoints.includes(endpoint)) next[protocol] = structuredClone(table);
    }
    // A chat-only route keeps inheriting the provider's API.
    if (current === undefined && Object.keys(next).length === 1 && Object.keys(next[first] as object).length === 0) {
      return undefined;
    }
    return next;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildNovitaModel(model: NovitaModel, existing: ExistingModel, authored = existing): SyncedModel {
  if (existing.reasoning === true && existing.reasoning_options === undefined) {
    throw new MissingReasoningOptionsError(model.id, "Novita inventory exposes no reasoning controls; author reasoning_options before syncing this route");
  }
  const nextCost = cost(model.pricing, existing.cost, model.input_token_price_per_m, model.output_token_price_per_m);
  if (model.is_tiered_billing === false) delete nextCost.tiers;
  if (model.is_tiered_billing === true) {
    const tiers = [...model.tiered_billing_configs ?? []].sort((a, b) => a.min_tokens - b.min_tokens);
    if (tiers.length === 0 || tiers[0]!.min_tokens > 1 || new Set(tiers.map((tier) => tier.min_tokens)).size !== tiers.length) {
      throw new Error(`Novita ${model.id} has missing or duplicate pricing tiers`);
    }
    const base = cost(tiers[0]!.pricing, nextCost);
    Object.assign(nextCost, base);
    nextCost.tiers = tiers.slice(1).map((tier) => {
      const previous = existing.cost?.tiers?.find((entry) => entry.tier.size === tier.min_tokens);
      const { tier: _tier, ...previousRates } = previous ?? {};
      const { tiers: _tiers, ...rates } = cost(tier.pricing, previous === undefined ? undefined : previousRates as typeof nextCost);
      return { tier: { type: "context" as const, size: tier.min_tokens }, ...rates };
    });
    if (nextCost.tiers.length === 0) delete nextCost.tiers;
  }
  const limit = { ...existing.limit, context: model.context_size, output: model.max_output_tokens! };
  const { base_model: baseModel, base_model_omit: omit, ...current } = authored;
  const values = { ...current, cost: nextCost, limit } as SyncedFullModel;
  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, omit);
}

export const novitaAi = {
  id: "novita-ai",
  name: "Novita AI",
  modelsDir: "providers/novita-ai/models",
  skipCreates: true,
  trackMissingModels: true,
  // Account-scoped inventory omits working/non-chat routes. Never delete on absence.
  deleteMissing: false,
  fetchModels: fetchNovitaModels,
  parseModels: parseNovitaModels,
  sourceID(model) {
    return eligible(model) ? model.id : undefined;
  },
  translateModel(model, context) {
    if (!eligible(model)) return undefined;
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    if (existing === undefined || authored === undefined) return undefined;
    if (existing.type !== undefined && existing.type !== "chat") {
      return { id: model.id, model: authored as SyncedModel };
    }
    // Only prices/limits are API-authoritative here. Preserve curated capabilities,
    // reasoning controls, interleaving, dates, descriptions, and request metadata.
    const v2Set = {
      ...novitaMediaCost(model),
      ...(model.endpoints?.length ? { api: novitaApis(model.endpoints) } : {}),
    };
    return {
      id: model.id,
      model: buildNovitaModel(model, existing, authored),
      ...(Object.keys(v2Set).length > 0 ? { v2Set } : {}),
    };
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `New Novita chat models require manual catalog review (missing-model issue fixer): ${ids.join(", ")}`,
    ];
  },
} satisfies SyncProvider<NovitaModel>;
