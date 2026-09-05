import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// ========================================
// Constants
// ========================================

// Public catalog behind https://hubris.pw/models; no authentication required.
const CATALOG_ENDPOINT = "https://hubris.pw/api/internal/models/catalog?limit=1000";
// Hubris bills in Russian rubles. The catalog schema is USD, so prices are
// converted at the Bank of Russia official daily rate: the bank's own XML
// feed first, its community JSON mirror as a fallback.
const FX_ENDPOINT = "https://www.cbr.ru/scripts/XML_daily.asp";
const FX_FALLBACK_ENDPOINT = "https://www.cbr-xml-daily.ru/daily_json.js";
const PRICE_DECIMALS = 10_000;
// The official rate moves a little every business day. Keep the previously
// synced USD prices (and their FX header) unless the converted value drifted
// more than this, so the hourly sync does not churn every model file on FX
// noise alone.
const FX_DRIFT_TOLERANCE = 0.03;
const FX_HEADER_PREFIX = "# FX:";
// Hubris speaks the OpenAI-compatible request shape with the OpenRouter-style
// `reasoning` object, so OpenRouter is the same-surface peer for reasoning
// controls; the lab's first-party entry is the fallback.
const PEER_PROVIDER = "openrouter";
const WIRE_DOC = "https://hubris.pw/docs";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const PROVIDERS_DIR = path.join(MODELS_DIR, "..", "providers");
const HUBRIS_MODELS_DIR = path.join(PROVIDERS_DIR, "hubris", "models");

// ========================================
// Schemas
// ========================================

const HubrisCatalogModel = z
  .object({
    id: z.string().min(1),
    displayName: z.string(),
    contextWindow: z.number().nullish(),
    inputModalities: z.array(z.string()).default([]),
    outputModalities: z.array(z.string()).default([]),
    supportedParameters: z.array(z.string()).nullish(),
    inputPriceRubPerMillion: z.number().nullish(),
    outputPriceRubPerMillion: z.number().nullish(),
    pricingExtrasRub: z.record(z.string(), z.number()).nullish(),
    isFree: z.boolean().default(false),
    pricingUnit: z.string().default("token"),
  })
  .passthrough();

const HubrisCatalog = z
  .object({
    items: z.array(HubrisCatalogModel),
  })
  .passthrough();

const CbrDailyRatesJson = z
  .object({
    Date: z.string(),
    Valute: z.object({
      USD: z.object({ Value: z.number().positive() }).passthrough(),
    }).passthrough(),
  })
  .passthrough();

const UsdRate = z.object({
  rate: z.number().positive(),
  // YYYY-MM-DD the Bank of Russia published the rate for.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const HubrisSource = z.object({
  catalog: HubrisCatalog,
  usd: UsdRate,
});

type UsdRate = z.infer<typeof UsdRate>;
export type HubrisModel = z.infer<typeof HubrisCatalogModel> & { usd: UsdRate };
type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

// ========================================
// FX rate
// ========================================

/** USD rate + date from the Bank of Russia XML feed (`<Value>` uses a decimal comma). */
export function parseCbrXmlUsdRate(xml: string): UsdRate {
  const date = /<ValCurs[^>]*\sDate="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (date === null) throw new Error("Bank of Russia XML feed has no Date attribute");
  const usd = /<Valute[^>]*>(?:(?!<\/Valute>)[\s\S])*?<CharCode>USD<\/CharCode>(?:(?!<\/Valute>)[\s\S])*?<Value>([\d,.]+)<\/Value>/.exec(xml);
  if (usd === null) throw new Error("Bank of Russia XML feed has no USD rate");
  const rate = Number(usd[1].replace(",", "."));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Bank of Russia XML feed has an invalid USD rate: ${usd[1]}`);
  return { rate, date: `${date[3]}-${date[2]}-${date[1]}` };
}

async function fetchUsdRate(): Promise<UsdRate> {
  try {
    const response = await fetch(FX_ENDPOINT);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return parseCbrXmlUsdRate(await response.text());
  } catch (error) {
    console.warn(`Bank of Russia XML feed failed (${String(error)}); trying the JSON mirror`);
    const response = await fetch(FX_FALLBACK_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Bank of Russia rates request failed: ${response.status} ${response.statusText}`);
    }
    const json = CbrDailyRatesJson.parse(await response.json());
    // The mirror publishes an ISO 8601 timestamp ("2026-09-05T11:30:00+03:00");
    // normalise it to the same YYYY-MM-DD contract as the XML path.
    const parsed = new Date(json.Date);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Bank of Russia JSON mirror has an invalid Date: ${json.Date}`);
    return UsdRate.parse({ rate: json.Valute.USD.Value, date: parsed.toISOString().slice(0, 10) });
  }
}

// ========================================
// Util functions
// ========================================

function isChatModel(model: HubrisModel) {
  return (
    model.pricingUnit === "token" &&
    model.outputModalities.includes("text") &&
    !model.id.includes(":") &&
    !model.id.startsWith("~")
  );
}

function usd(rub: number | null | undefined, rate: number): number | undefined {
  if (rub == null) return undefined;
  return Math.round((rub / rate) * PRICE_DECIMALS) / PRICE_DECIMALS;
}

function buildCost(model: HubrisModel): SyncedFullModel["cost"] {
  const input = usd(model.inputPriceRubPerMillion, model.usd.rate);
  const output = usd(model.outputPriceRubPerMillion, model.usd.rate);
  if (input === undefined || output === undefined) return undefined;
  const extras = model.pricingExtrasRub ?? {};
  return {
    input,
    output,
    cache_read: usd(extras.input_cache_read, model.usd.rate),
    cache_write: usd(extras.input_cache_write, model.usd.rate),
  };
}

function withinTolerance(current: number | undefined, desired: number | undefined) {
  if (current === undefined || desired === undefined) return current === desired;
  if (current === desired) return true;
  if (current === 0 || desired === 0) return false;
  return Math.abs(current - desired) / current <= FX_DRIFT_TOLERANCE;
}

/**
 * Reuse the previously synced cost when the only change is FX drift below the
 * tolerance. Any real price change on the gateway (or a cache price
 * appearing/disappearing) still updates the file.
 */
function stableCost(
  desired: SyncedFullModel["cost"],
  existing: ExistingModel | undefined,
): { cost: SyncedFullModel["cost"]; reused: boolean } {
  const current = existing?.cost;
  if (desired === undefined || current === undefined) return { cost: desired, reused: false };
  if (current.input === undefined || current.output === undefined) return { cost: desired, reused: false };
  const keys = ["input", "output", "cache_read", "cache_write"] as const;
  const stable = keys.every((key) => withinTolerance(current[key], desired[key]));
  if (!stable) return { cost: desired, reused: false };
  return {
    cost: {
      input: current.input,
      output: current.output,
      cache_read: current.cache_read,
      cache_write: current.cache_write,
    },
    reused: true,
  };
}

function parseToml(filePath: string): Record<string, unknown> | undefined {
  try {
    return Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tomlFilesIn(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? tomlFilesIn(path.join(dir, entry.name))
      : entry.name.endsWith(".toml")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

function authoredReasoningOptions(toml: Record<string, unknown> | undefined): ReasoningOptions | undefined {
  const options = toml?.reasoning_options;
  return Array.isArray(options) ? (options as ReasoningOptions) : undefined;
}

let peerOptionsByBaseModel: Map<string, ReasoningOptions> | undefined;

function peerReasoningOptions(id: string, canonical: string): ReasoningOptions | undefined {
  // Hubris ids are OpenRouter ids, so the same path is the first candidate.
  const direct = authoredReasoningOptions(parseToml(path.join(PROVIDERS_DIR, PEER_PROVIDER, "models", `${id}.toml`)));
  if (direct !== undefined) return direct;

  if (peerOptionsByBaseModel === undefined) {
    peerOptionsByBaseModel = new Map();
    for (const file of tomlFilesIn(path.join(PROVIDERS_DIR, PEER_PROVIDER, "models"))) {
      const toml = parseToml(file);
      const base = toml?.base_model;
      const options = authoredReasoningOptions(toml);
      if (typeof base !== "string" || options === undefined || peerOptionsByBaseModel.has(base)) continue;
      peerOptionsByBaseModel.set(base, options);
    }
  }
  return peerOptionsByBaseModel.get(canonical);
}

function labReasoningOptions(canonical: string): ReasoningOptions | undefined {
  const [lab, ...rest] = canonical.split("/");
  return authoredReasoningOptions(parseToml(path.join(PROVIDERS_DIR, lab ?? "", "models", `${rest.join("/")}.toml`)));
}

/**
 * Host-accurate reasoning controls: the OpenRouter entry for the same route
 * (same wire surface), then the lab's first-party entry, then whatever was
 * authored locally. Never a generic template.
 */
function resolveReasoningOptions(
  id: string,
  canonical: string,
  existing: ExistingModel | undefined,
): ReasoningOptions | undefined {
  return (
    peerReasoningOptions(id, canonical) ??
    labReasoningOptions(canonical) ??
    (Array.isArray(existing?.reasoning_options) ? (existing.reasoning_options as ReasoningOptions) : undefined)
  );
}

function fxHeaderLine(usdRate: UsdRate) {
  return `${FX_HEADER_PREFIX} Hubris bills in RUB. USD/MTok below = public RUB price / Bank of Russia official rate ${usdRate.rate} RUB/USD (${usdRate.date}); kept until the rate drifts >3 %.`;
}

function existingFxHeaderLine(id: string): string | undefined {
  try {
    const text = readFileSync(path.join(HUBRIS_MODELS_DIR, `${id}.toml`), "utf8");
    return text.split(/\r?\n/).find((line) => line.startsWith(FX_HEADER_PREFIX));
  } catch {
    return undefined;
  }
}

function wireHeaderLines(options: ReasoningOptions | undefined): string[] {
  if (options === undefined || options.length === 0) return [];
  const types = new Set(options.map((option) => option.type));
  const lines: string[] = [];
  if (types.has("toggle")) lines.push("# Toggle: reasoning.enabled = true|false");
  if (types.has("effort")) lines.push("# Effort: reasoning.effort");
  if (types.has("budget_tokens")) lines.push("# Budget: reasoning.max_tokens");
  if (lines.length > 0) lines.push(`# ${WIRE_DOC}`);
  return lines;
}

type SkipReason = "no lab metadata" | "no resolvable reasoning controls";

function normalizeSlug(value: string) {
  return value.toLowerCase().replace(/[._]/g, "-");
}

/**
 * Hubris display names carry a "Vendor: " prefix ("OpenAI: GPT-5.6 Luna Pro").
 * Only routes whose slug differs from the lab model's (Pro/alias routes that
 * share a `base_model`) keep their own name; the rest inherit the lab name.
 */
function routeName(model: HubrisModel, canonical: string): string | undefined {
  const routeSlug = model.id.split("/").slice(1).join("/");
  const labSlug = canonical.split("/").slice(1).join("/");
  if (normalizeSlug(routeSlug) === normalizeSlug(labSlug)) return undefined;
  return model.displayName.replace(/^[^:]+:\s*/, "");
}

export function buildHubrisModel(
  model: HubrisModel,
  existing: ExistingModel | undefined,
): { model: SyncedModel; header: string } | { skip: SkipReason } {
  // Hubris only relays models built by other labs, so every entry must factor
  // onto the canonical lab metadata. Models without a `models/` entry are
  // reported as skipped instead of being authored inline.
  const canonical = resolveModelMetadataBaseModel(model.id);
  if (canonical === undefined) return { skip: "no lab metadata" };

  const params = model.supportedParameters ?? [];
  const reasoning = params.includes("reasoning");
  const reasoningOptions = reasoning ? resolveReasoningOptions(model.id, canonical, existing) : undefined;
  // A reasoner with no host-accurate controls anywhere is left for manual
  // authoring rather than stamped with an invented control set.
  if (reasoning && reasoningOptions === undefined) return { skip: "no resolvable reasoning controls" };

  const context = model.contextWindow != null && model.contextWindow > 0 ? model.contextWindow : undefined;
  // The catalog does not publish a max-output figure. Inherit the lab's
  // `limit.output`; when the lab entry has none, fall back to the context
  // window (as the Requesty sync does) so the provider model still resolves.
  const baseLimit = modelMetadata(canonical).limit;
  const baseOutput =
    typeof baseLimit === "object" && baseLimit !== null && typeof (baseLimit as { output?: unknown }).output === "number"
      ? (baseLimit as { output: number }).output
      : undefined;
  const limit =
    context === undefined
      ? undefined
      : baseOutput === undefined
        ? { context, output: context }
        : { context };

  const { cost, reused } = stableCost(buildCost(model), existing);
  const fxLine = (reused ? existingFxHeaderLine(model.id) : undefined) ?? fxHeaderLine(model.usd);
  const header = [fxLine, ...wireHeaderLines(reasoningOptions)].join("\n") + "\n";

  return {
    header,
    model: factorBaseModel(
      canonical,
      {
        name: routeName(model, canonical),
        reasoning,
        reasoning_options: reasoningOptions,
        tool_call: params.includes("tools"),
        structured_output: params.includes("structured_outputs"),
        cost,
        limit,
      },
      limit,
      existing?.base_model_omit,
    ),
  };
}

// ========================================
// Hubris provider
// ========================================

const skipReasons = new Map<string, SkipReason>();

export const hubris = {
  id: "hubris",
  name: "Hubris",
  modelsDir: "providers/hubris/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  // Models without lab metadata (or without resolvable reasoning controls)
  // are intentionally left out; they are listed in the sync notices, not
  // opened as issues.
  trackMissingModels: false,
  sourceID(model) {
    return isChatModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    const byReason = new Map<SkipReason, string[]>();
    for (const id of ids) {
      const reason = skipReasons.get(id) ?? "no lab metadata";
      byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
    }
    return [...byReason.entries()].map(
      ([reason, skipped]) => `Skipped ${skipped.length} Hubris model(s) with ${reason}: ${skipped.sort().join(", ")}`,
    );
  },
  async fetchModels() {
    const [catalog, usdRate] = await Promise.all([
      fetch(CATALOG_ENDPOINT).then((response) => {
        if (!response.ok) {
          throw new Error(`Hubris catalog request failed: ${response.status} ${response.statusText}`);
        }
        return response.json();
      }),
      fetchUsdRate(),
    ]);
    return { catalog, usd: usdRate };
  },
  parseModels(raw) {
    const source = HubrisSource.parse(raw);
    return source.catalog.items.map((model) => ({ ...model, usd: source.usd }));
  },
  translateModel(model, context) {
    if (!isChatModel(model)) return undefined;
    const built = buildHubrisModel(model, context.existing(model.id));
    if ("skip" in built) {
      skipReasons.set(model.id, built.skip);
      return undefined;
    }
    return { id: model.id, model: built.model, header: built.header };
  },
} satisfies SyncProvider<HubrisModel>;
