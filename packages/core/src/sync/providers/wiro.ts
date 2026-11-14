import { z } from "zod";

import { CostConditionKeyV2Values } from "../../schema-v2.js";
import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";
import { modelMetadata } from "./openrouter.js";

// Wiro AI's LLM gateway lists every model it serves, with USD per-token prices,
// context price bands and limits (https://wiro.ai/docs/completions-api). The
// list needs no key; WIRO_API_KEY is sent when one is set.
const API_ENDPOINT = "https://llm.wiro.ai/v1/models";

// Absence from the catalog removes a model, so a response this small is treated
// as broken rather than as a mass retirement.
const MIN_MODELS = 20;
const MAX_PAGES = 20;

// USD per token as a decimal string ("0.00000015"); exponent notation parses too.
const TokenPrice = z.string().regex(/^\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i);

const Prices = z.object({
  prompt: TokenPrice,
  completion: TokenPrice,
  input_cache_read: TokenPrice.optional(),
  input_cache_write: TokenPrice.optional(),
}).passthrough();

// One band of `x_wiro.pricing_tiers`. The first band is the base price up to
// `maxInputTokens`; each later band applies above `minInputTokensExclusive`.
const PricingBand = Prices.extend({
  maxInputTokens: z.number().int().positive().optional(),
  minInputTokensExclusive: z.number().int().nonnegative().optional(),
});

export const WiroModel = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive().nullish(),
  max_tokens: z.number().int().positive().nullish(),
  // null for models billed by GPU time instead of per token.
  pricing: Prices.nullish(),
  capabilities: z.object({
    structured_output_modes: z.array(z.string()).optional(),
  }).passthrough().optional(),
  x_wiro: z.object({
    pricing_tiers: z.array(PricingBand).nullish(),
  }).passthrough().nullish(),
}).passthrough();

const WiroPage = z.object({
  data: z.array(WiroModel),
  total_count: z.number().int().nonnegative().optional(),
  has_more: z.boolean().optional(),
  links: z.object({ next: z.string().nullish() }).passthrough().nullish(),
}).passthrough();

// Every page of the catalog, with the time span of the requests: the catalog
// quotes each model at the rate in force when it answers.
const WiroCatalog = z.object({
  data: z.array(WiroModel),
  total_count: z.number().int().nonnegative().optional(),
  fetched: z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict(),
}).strict();

export type WiroModel = z.infer<typeof WiroModel>;
export type WiroSourceModel = WiroModel & { fetched: { from: string; to: string } };

export const wiro = {
  id: "wiro",
  name: "Wiro AI",
  modelsDir: "providers/wiro/models",
  // Each new model's reasoning controls and input formats are checked against
  // the gateway before its file is written, so new catalog models are listed
  // in the sync report instead of being created.
  skipCreates: true,
  trackMissingModels: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Wiro AI catalog models have no file yet and were not created: their reasoning controls and input formats are authored by hand.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchWiroModels();
  },
  parseModels(raw) {
    const catalog = WiroCatalog.parse(raw);
    if (catalog.data.length < MIN_MODELS) {
      throw new Error(`Wiro AI returned ${catalog.data.length} models; refusing to sync fewer than ${MIN_MODELS}`);
    }
    if (catalog.total_count !== undefined && catalog.total_count !== catalog.data.length) {
      throw new Error(`Wiro AI returned ${catalog.data.length} of ${catalog.total_count} models; refusing to sync a partial catalog`);
    }
    const ids = new Set<string>();
    for (const model of catalog.data) {
      if (ids.has(model.id)) throw new Error(`Wiro AI returned duplicate model ID: ${model.id}`);
      ids.add(model.id);
    }
    return catalog.data.map((model) => ({ ...model, fetched: catalog.fetched }));
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    const notices: string[] = [];
    const synced = buildWiroModel(model, authored, context.v2?.(model.id), notices);
    const cached = model.pricing != null && synced.cost?.cache_read !== undefined;
    return {
      id: model.id,
      model: synced,
      notices,
      // A cache price the catalog starts quoting comes with implicit caching, as
      // in the files written by hand. Existing cache details are kept.
      ...(cached ? { v2Set: { "capabilities.cache": (current: unknown) => current ?? { implicit: true } } } : {}),
    };
  },
} satisfies SyncProvider<WiroSourceModel>;

export async function fetchWiroModels(fetcher: typeof fetch = fetch, key = process.env.WIRO_API_KEY) {
  const origin = new URL(API_ENDPOINT).origin;
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const data: WiroModel[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  const from = new Date().toISOString();
  let url: string | undefined = API_ENDPOINT;

  while (url !== undefined) {
    if (seen.size === MAX_PAGES) throw new Error(`Wiro AI returned more than ${MAX_PAGES} pages of models`);
    if (seen.has(url)) throw new Error(`Wiro AI repeated a page of models: ${url}`);
    seen.add(url);

    const response = await fetcher(url, { headers });
    if (!response.ok) {
      const hint = !key && (response.status === 401 || response.status === 403)
        ? "; set WIRO_API_KEY if the model list asks for a key"
        : "";
      throw new Error(`Wiro AI models request failed: ${response.status} ${response.statusText}${hint}`);
    }
    const page = WiroPage.parse(await response.json());
    data.push(...page.data);
    total ??= page.total_count;

    if (page.has_more !== true) break;
    const next = page.links?.next;
    if (!next) throw new Error("Wiro AI returned has_more without a link to the next page");
    url = new URL(next, API_ENDPOINT).toString();
    // The request carries the API key, so it never leaves the catalog's host.
    if (new URL(url).origin !== origin) throw new Error(`Wiro AI linked a page on another host: ${url}`);
  }

  return {
    data,
    ...(total === undefined ? {} : { total_count: total }),
    fetched: { from, to: new Date().toISOString() },
  };
}

// Prices, context price bands, limits and structured output come from the
// catalog. Everything else in the file (reasoning controls, input formats,
// sampling flags, API tables, cache details, multipliers) is authored by hand.
export function buildWiroModel(
  model: WiroSourceModel,
  authored: ExistingModel,
  doc: Record<string, unknown> | undefined,
  notices: string[] = [],
): SyncedModel {
  const next: Record<string, unknown> = { ...authored };
  const lab = authored.base_model === undefined ? undefined : modelMetadata(authored.base_model);

  const cost = wiroCost(model, authored.cost, doc, notices);
  if (cost === undefined) delete next.cost;
  else next.cost = cost;

  const limit = wiroLimit(model, authored.limit, lab?.limit as Limit | undefined);
  if (limit === undefined) delete next.limit;
  else next.limit = limit;

  // Only JSON schema output counts; json_object alone is JSON mode.
  const modes = model.capabilities?.structured_output_modes;
  if (modes?.includes("json_schema")) next.structured_output = true;
  else if (modes !== undefined && authored.structured_output === true) next.structured_output = false;

  return next as SyncedModel;
}

type Limit = Partial<Record<"context" | "input" | "output", number>>;

// `context_length` and `max_tokens` are what the gateway accepts. Up to the
// lab's limits they are published as they are (a limit equal to the lab's is
// inherited). A larger value is only published once it is checked and written
// in the file by hand; the catalog can still lower that value.
export function wiroLimit(model: WiroModel, authored: unknown, lab: Limit | undefined) {
  const own = authored as Limit | undefined;
  const limit: Limit = { ...own };
  for (const [key, reported] of [["context", model.context_length], ["output", model.max_tokens]] as const) {
    if (reported === undefined || reported === null) continue;
    const inherited = lab?.[key];
    const current = own?.[key];
    const value = inherited === undefined || reported <= inherited
      ? reported
      : current === undefined ? inherited : Math.min(current, reported);
    if (value === inherited) delete limit[key];
    else limit[key] = value;
  }
  return Object.keys(limit).length > 0 ? limit : undefined;
}

type Cost = NonNullable<ExistingModel["cost"]>;

function wiroCost(
  model: WiroSourceModel,
  current: Cost | undefined,
  doc: Record<string, unknown> | undefined,
  notices: string[],
): Cost | undefined {
  // Models billed by GPU time have no catalog price; Grok's flat rates come
  // from its model pages. Either way the file's prices stay.
  const pricing = model.pricing;
  if (pricing == null || !(Number(pricing.prompt) > 0) || !(Number(pricing.completion) > 0)) return current;

  const factor = factorInForce(doc, model.fetched);
  if (factor === undefined) {
    notices.push(`Kept the prices of ${model.id}: a price multiplier in its file could not be checked against the time of the request.`);
    return current;
  }

  const bands = model.x_wiro?.pricing_tiers ?? [];
  const [first, ...rest] = bands;
  if (
    first !== undefined
    && (Number(first.prompt) !== Number(pricing.prompt)
      || Number(first.completion) !== Number(pricing.completion)
      || first.minInputTokensExclusive !== undefined
      || rest.some((band) => band.minInputTokensExclusive === undefined))
  ) {
    notices.push(`Kept the prices of ${model.id}: its pricing_tiers do not start at the catalog price.`);
    return current;
  }
  const tiers = rest.map((band) => stripUndefined({
    tier: { type: "context" as const, size: band.minInputTokensExclusive! },
    input: price(band.prompt, factor),
    output: price(band.completion, factor),
    cache_read: band.input_cache_read === undefined ? undefined : price(band.input_cache_read, factor),
    cache_write: band.input_cache_write === undefined ? undefined : price(band.input_cache_write, factor),
  }));

  return stripUndefined({
    // Prices the catalog does not quote stay as authored.
    reasoning: current?.reasoning,
    input_audio: current?.input_audio,
    output_audio: current?.output_audio,
    input: price(pricing.prompt, factor),
    output: price(pricing.completion, factor),
    cache_read: pricing.input_cache_read === undefined ? undefined : price(pricing.input_cache_read, factor),
    cache_write: pricing.input_cache_write === undefined ? undefined : price(pricing.input_cache_write, factor),
    tiers: tiers.length > 0 ? tiers : undefined,
  }) as Cost;
}

// USD per token as USD per million tokens, divided by the multiplier in force
// when the catalog answered, so the file keeps its base rate.
function price(perToken: string, factor: number) {
  return Number(((Number(perToken) * 1_000_000) / factor).toFixed(6));
}

type Truth = boolean | "request" | "unknown";

const TIME_KEYS = new Set(["date", "utc_days", "utc_hours", "holiday"]);
const REQUEST_KEYS = new Set<string>(CostConditionKeyV2Values.filter((key) => !TIME_KEYS.has(key)));
const UTC_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The product of the file's multipliers that applied to the catalog's quote,
// such as peak hours or a dated price change. A multiplier that also depends
// on the request (context, service tier, ...) did not apply to the plain quote.
// Undefined when a multiplier can't be evaluated, or when one started or ended
// while the catalog was being fetched.
export function factorInForce(
  doc: Record<string, unknown> | undefined,
  fetched: { from: string; to: string },
): number | undefined {
  const multipliers = (doc?.cost as { multipliers?: unknown } | undefined)?.multipliers;
  if (multipliers === undefined) return 1;
  if (!Array.isArray(multipliers)) return undefined;
  let atStart = 1;
  let atEnd = 1;
  for (const multiplier of multipliers) {
    if (!isRecord(multiplier) || !isRecord(multiplier.when)) return undefined;
    const factor = multiplier.factor;
    const start = holds(multiplier.when, new Date(fetched.from));
    const end = holds(multiplier.when, new Date(fetched.to));
    if (start === "unknown" || end === "unknown") return undefined;
    if (start !== true && end !== true) continue;
    if (typeof factor !== "number" || !(factor > 0)) return undefined;
    if (start === true) atStart *= factor;
    if (end === true) atEnd *= factor;
  }
  return atStart === atEnd ? atStart : undefined;
}

function holds(when: Record<string, unknown>, at: Date): Truth {
  return every(Object.entries(when).map(([key, condition]): Truth => {
    if (key === "all") return Array.isArray(condition) ? every(condition.map((item) => nested(item, at))) : "unknown";
    if (key === "any") return Array.isArray(condition) ? some(condition.map((item) => nested(item, at))) : "unknown";
    if (key === "not") return negate(nested(condition, at));
    if (key === "date") return compare(condition, at.toISOString().slice(0, 10), /^\d{4}-\d{2}-\d{2}$/);
    if (key === "utc_days") return compare(condition, UTC_DAYS[at.getUTCDay()]!, /^(sun|mon|tue|wed|thu|fri|sat)$/);
    if (key === "utc_hours") return compare(condition, at.toISOString().slice(11, 16), /^\d{2}:\d{2}$/);
    return REQUEST_KEYS.has(key) ? "request" : "unknown";
  }));
}

function nested(when: unknown, at: Date): Truth {
  return isRecord(when) ? holds(when, at) : "unknown";
}

// One operator against a zero-padded value, which orders like the time it names.
function compare(condition: unknown, value: string, format: RegExp): Truth {
  if (!isRecord(condition)) return "unknown";
  const entries = Object.entries(condition);
  if (entries.length !== 1) return "unknown";
  const [operator, operand] = entries[0]!;
  const operands = operator === "in" ? operand : [operand];
  if (!Array.isArray(operands) || !operands.every((item) => typeof item === "string" && format.test(item))) {
    return "unknown";
  }
  const [target] = operands as string[];
  switch (operator) {
    case "equals": return value === target;
    case "in": return (operands as string[]).includes(value);
    case "gt": return value > target!;
    case "gte": return value >= target!;
    case "lt": return value < target!;
    case "lte": return value <= target!;
    default: return "unknown";
  }
}

function every(values: Truth[]): Truth {
  if (values.includes("unknown")) return "unknown";
  if (values.includes(false)) return false;
  return values.includes("request") ? "request" : true;
}

function some(values: Truth[]): Truth {
  if (values.includes("unknown")) return "unknown";
  if (values.includes(true)) return true;
  return values.includes("request") ? "request" : false;
}

function negate(value: Truth): Truth {
  return typeof value === "boolean" ? !value : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
