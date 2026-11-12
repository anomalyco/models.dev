// Alibaba Cloud Model Studio (international): the console's catalog API,
// GET https://dashscope-intl.aliyuncs.com/api/v1/models (DASHSCOPE_API_KEY). It
// isn't documented, but it's what the model list and pricing pages are built
// from: limits, modalities, retirement dates and USD prices per context tier.
// Authoritative for text models (Qwen, DeepSeek, GLM, Kimi): context and output
// limits, image, audio and video input and output, a deprecated status once a
// retirement date is set, and token prices: input, output, a separate thinking
// output price, the implicit cache hit and the 5-minute explicit cache, with
// context tiers as bands. A tier with peak and off-peak prices takes the peak
// price; its file holds the off-peak multiplier, so the sync only reads prices
// whose off-peak rate is half the peak one. Prices it can't map (separate
// thinking input prices, audio and image tokens, per-second or per-image units)
// leave the file's own. Batch prices are left out.
// Reasoning controls, APIs and tool choices stay hand-authored, so a new chat
// model with function calling is a gap; snapshots, namespaced copies and media
// models are never reported. The list leaves out models that still work, so a
// file it drops is kept and reported unless it's already deprecated.
// alibaba-cn isn't synced: dashscope.aliyuncs.com needs a China key.

import { z } from "zod";

import { bearer, fetchJSON, requireEnv } from "../http.js";
import { getPath } from "../fields.js";
import type { Doc, Observation, SyncModule } from "../types.js";

const ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const PAGE_SIZE = 200;

const Price = z.object({
  type: z.string(),
  price: z.string().regex(/^\d+(?:\.\d+)?$/),
  price_unit: z.string(),
  time_band: z.string().nullable(),
}).passthrough();

const AlibabaModel = z.object({
  model: z.string().min(1),
  capabilities: z.array(z.string()).nullable(),
  features: z.array(z.string()).nullable(),
  prices: z.array(z.object({ range_name: z.string(), prices: z.array(Price) }).passthrough()).nullable(),
  inference_metadata: z.object({
    request_modality: z.array(z.string()).nullable().optional(),
    response_modality: z.array(z.string()).nullable().optional(),
  }).passthrough().nullable(),
  model_info: z.object({
    context_window: z.number().int().positive().nullable(),
    max_output_tokens: z.number().int().positive().nullable(),
    reasoning_max_output_tokens: z.number().int().positive().nullable().optional(),
  }).passthrough().nullable(),
  inference_offline_info: z.object({ offline_time: z.string().nullable() }).passthrough().nullable(),
}).passthrough();
type AlibabaModel = z.infer<typeof AlibabaModel>;

const AlibabaPage = z.object({
  success: z.literal(true),
  output: z.object({ total: z.number().int().nonnegative(), models: z.array(AlibabaModel) }).passthrough(),
}).passthrough();

const AlibabaRaw = z.object({ models: z.array(AlibabaModel).nonempty() });

export const alibaba: SyncModule<unknown> = {
  id: "alibaba",
  name: "Alibaba",
  policy: {
    owns: [
      "limit.context",
      "limit.output",
      { path: "modalities.input", merge: "kinds", only: ["image", "audio", "video"] },
      { path: "modalities.output", merge: "kinds", only: ["image", "audio", "video"] },
      { path: "status", merge: "deprecated" },
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.explicit",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      "cost.text.output.reasoning",
      { path: "cost.text.output.overrides", merge: "bands" },
    ],
    creates: "gap",
    removals: "keep",
  },
  // A deprecated file the list drops is expected, not news.
  manages: (_id, file) => file.status !== "deprecated",
  async fetch() {
    const key = requireEnv("Alibaba", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY");
    const models: AlibabaModel[] = [];
    for (let page = 1; ; page++) {
      const url = `${ENDPOINT}?page_size=${PAGE_SIZE}&page_no=${page}`;
      const { output } = AlibabaPage.parse(await fetchJSON(url, { source: "Alibaba models", headers: bearer(key) }));
      models.push(...output.models);
      if (output.models.length === 0 || models.length >= output.total) {
        if (models.length !== output.total) throw new Error(`Alibaba listed ${models.length} of ${output.total} models`);
        return { models };
      }
    }
  },
  observe: (raw) => AlibabaRaw.parse(raw).models.map(observe),
  refine(observation, file) {
    const cost = observation.cost as Doc | undefined;
    const own = file?.cost as Doc | undefined;
    if (cost === undefined || own === undefined) return observation;
    const refined = keepPrecise(cost, own) as Doc;
    // No thinking price means reasoning bills at the output price, which a file may spell out.
    const output = getPath(refined, "text.output") as Doc | undefined;
    if (output?.reasoning === null && getPath(own, "text.output.reasoning") === output.price) delete output.reasoning;
    return { ...observation, cost: refined };
  },
};

// The API rounds to three decimals (0.0625 → 0.063); a file price that rounds to the listed one is kept.
function keepPrecise(observed: unknown, file: unknown): unknown {
  if (typeof observed === "number") {
    const places = String(observed).split(".")[1]?.length ?? 0;
    return typeof file === "number" && Math.abs(file - observed) <= 0.5 * 10 ** -places + 1e-12 ? file : observed;
  }
  if (Array.isArray(observed)) {
    const bands = Array.isArray(file) ? file : [];
    return observed.map((band) => keepPrecise(band, bands.find((item) => JSON.stringify(item?.when) === JSON.stringify((band as Doc)?.when))));
  }
  if (observed === null || typeof observed !== "object") return observed;
  const table = file !== null && typeof file === "object" && !Array.isArray(file) ? file as Doc : {};
  return Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, keepPrecise(value, table[key])]));
}

const TEXT_CAPABILITIES = new Set(["TG", "VU", "Reasoning", "Multimodal-Omni"]);

function observe(model: AlibabaModel): Observation {
  const capabilities = model.capabilities ?? [];
  const status = model.inference_offline_info?.offline_time ? "deprecated" as const : null;
  const context = model.model_info?.context_window ?? undefined;
  const text = capabilities.some((capability) => TEXT_CAPABILITIES.has(capability))
    && !capabilities.some((capability) => capability.startsWith("Realtime"))
    && context !== undefined;
  if (!text) return { id: model.model, updateOnly: true, status };
  const info = model.model_info!;
  const outputs = [info.max_output_tokens, info.reasoning_max_output_tokens].filter((value): value is number => typeof value === "number");
  const kinds = (values: string[] | null | undefined) => values?.map((value) => value.toLowerCase());
  const input = kinds(model.inference_metadata?.request_modality);
  const output = kinds(model.inference_metadata?.response_modality);
  return {
    id: model.model,
    ...(reportable(model) ? {} : { updateOnly: true }),
    status,
    limit: { context, ...(outputs.length > 0 ? { output: Math.max(...outputs) } : {}) },
    ...(input === undefined && output === undefined ? {} : { modalities: { ...(input ? { input } : {}), ...(output ? { output } : {}) } }),
    cost: textCost(model),
  };
}

// A new chat model a person should add: not a dated snapshot, a -latest alias or a namespaced copy (ZHIPU/GLM-5.3).
function reportable(model: AlibabaModel) {
  return (model.capabilities ?? []).includes("TG")
    && (model.features ?? []).includes("function-calling")
    && !model.model.includes("/")
    && !/-(?:\d{4}-\d{2}-\d{2}|latest)$/.test(model.model);
}

const PRICE_TYPES = new Set([
  "input_token",
  "output_token",
  "input_token_cache",
  "input_token_cache_creation_5m",
  "input_token_cache_read",
  "thinking_input_token",
  "thinking_output_token",
  "thinking_input_token_cache",
  "thinking_input_token_cache_creation_5m",
  "thinking_input_token_cache_read",
]);

type Tier = Map<string, number>;

/** The tier's prices by type, or undefined when they can't be mapped. */
function tierPrices(prices: z.infer<typeof Price>[]): Tier | undefined {
  const used = prices.filter((price) => !price.type.endsWith("_batch"));
  if (used.some((price) => !PRICE_TYPES.has(price.type) || price.price_unit !== "Per 1M tokens")) return undefined;
  const bands = new Set(used.map((price) => price.time_band ?? "standard"));
  const pick = (band: string) => {
    const tier: Tier = new Map();
    for (const price of used.filter((item) => (item.time_band ?? "standard") === band)) {
      if (tier.has(price.type)) return undefined;
      tier.set(price.type, Number(price.price));
    }
    return tier;
  };
  if (bands.size === 1 && bands.has("standard")) return pick("standard");
  if (bands.size !== 2 || !bands.has("peak") || !bands.has("offpeak")) return undefined;
  const peak = pick("peak");
  const offpeak = pick("offpeak");
  if (peak === undefined || offpeak === undefined || peak.size !== offpeak.size) return undefined;
  for (const [type, price] of peak) {
    const off = offpeak.get(type);
    if (off === undefined || Math.abs(off - price / 2) > 1e-9) return undefined;
  }
  return peak;
}

// "Default", "Input<=256k", "32k<Input<=256k", "256k<Input<=1m" → [from, to] in tokens.
function tierRange(name: string, only: boolean): [number, number] | undefined {
  const size = (value: string, unit: string) => Number(value) * (unit === "m" ? 1_000_000 : 1_000);
  if (name === "Default") return only ? [0, Infinity] : undefined;
  const first = /^Input<=(\d+)([km])$/.exec(name);
  if (first) return [0, size(first[1]!, first[2]!)];
  const band = /^(\d+)([km])<Input<=(\d+)([km])$/.exec(name);
  return band ? [size(band[1]!, band[2]!), size(band[3]!, band[4]!)] : undefined;
}

function textCost(model: AlibabaModel): Observation["cost"] {
  const ranges = model.prices ?? [];
  if (ranges.length === 0) return undefined;
  const tiers: { from: number; prices: Tier }[] = [];
  for (const range of ranges) {
    const bounds = tierRange(range.range_name, ranges.length === 1);
    const prices = tierPrices(range.prices);
    if (bounds === undefined || prices === undefined) return undefined;
    tiers.push({ from: bounds[0], prices });
  }
  tiers.sort((a, b) => a.from - b.from);
  if (tiers[0]!.from !== 0 || new Set(tiers.map((tier) => tier.from)).size !== tiers.length) return undefined;
  const mapped = tiers.map((tier) => tierCost(tier.prices));
  if (mapped.some((tier) => tier === undefined)) return undefined;
  const [base, ...bands] = mapped as NonNullable<ReturnType<typeof tierCost>>[];
  if (base === undefined) return undefined;
  const when = (index: number) => ({ context: { gt: tiers[index + 1]!.from } });
  const bandCache = (cache: NonNullable<ReturnType<typeof tierCost>>["cache"]) => {
    const kept = Object.fromEntries(Object.entries(cache).filter(([, value]) => value !== null));
    return Object.keys(kept).length > 0 ? { cache: kept } : {};
  };
  return {
    text: {
      input: {
        price: base.input,
        cache: base.cache,
        overrides: bands.length > 0 ? bands.map((band, index) => ({ when: when(index), price: band.input, ...bandCache(band.cache) })) : null,
      },
      output: {
        price: base.output,
        reasoning: base.reasoning,
        overrides: bands.length > 0
          ? bands.map((band, index) => ({ when: when(index), price: band.output, ...(band.reasoning === null ? {} : { reasoning: band.reasoning }) }))
          : null,
      },
    },
  };
}

// One tier in v2 terms. Thinking input prices must match the plain ones: v2 has one input price.
function tierCost(tier: Tier) {
  const input = tier.get("input_token");
  const output = tier.get("output_token");
  if (input === undefined || output === undefined) return undefined;
  const same = (a: string, b: string) => !tier.has(a) || tier.get(a) === tier.get(b);
  if (!same("thinking_input_token", "input_token")
    || !same("thinking_input_token_cache", "input_token_cache")
    || !same("thinking_input_token_cache_creation_5m", "input_token_cache_creation_5m")
    || !same("thinking_input_token_cache_read", "input_token_cache_read")) return undefined;
  const write = tier.get("input_token_cache_creation_5m");
  const read = tier.get("input_token_cache_read");
  if ((write === undefined) !== (read === undefined)) return undefined;
  const thinking = tier.get("thinking_output_token");
  return {
    input,
    output,
    reasoning: thinking === undefined || thinking === output ? null : thinking,
    cache: {
      read: tier.get("input_token_cache") ?? null,
      explicit: write === undefined ? null : { read: read!, write },
    },
  };
}
