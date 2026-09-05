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
// synced USD prices unless the converted value drifted more than this, so
// the hourly sync does not churn every model file on FX noise alone.
const FX_DRIFT_TOLERANCE = 0.03;
const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;

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
    Valute: z.object({
      USD: z.object({ Value: z.number().positive() }).passthrough(),
    }).passthrough(),
  })
  .passthrough();

const HubrisSource = z.object({
  catalog: HubrisCatalog,
  usdRate: z.number().positive(),
});

export type HubrisModel = z.infer<typeof HubrisCatalogModel> & { usdRate: number };

// ========================================
// Util functions
// ========================================

/** USD rate from the Bank of Russia XML feed (`<Value>` uses a decimal comma). */
function parseCbrXmlUsdRate(xml: string): number {
  const usd = /<Valute[^>]*>(?:(?!<\/Valute>)[\s\S])*?<CharCode>USD<\/CharCode>(?:(?!<\/Valute>)[\s\S])*?<Value>([\d,.]+)<\/Value>/.exec(xml);
  if (usd === null) throw new Error("Bank of Russia XML feed has no USD rate");
  const rate = Number(usd[1].replace(",", "."));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Bank of Russia XML feed has an invalid USD rate: ${usd[1]}`);
  return rate;
}

async function fetchUsdRate(): Promise<number> {
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
    return CbrDailyRatesJson.parse(await response.json()).Valute.USD.Value;
  }
}

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
  const input = usd(model.inputPriceRubPerMillion, model.usdRate);
  const output = usd(model.outputPriceRubPerMillion, model.usdRate);
  if (input === undefined || output === undefined) return undefined;
  const extras = model.pricingExtrasRub ?? {};
  return {
    input,
    output,
    cache_read: usd(extras.input_cache_read, model.usdRate),
    cache_write: usd(extras.input_cache_write, model.usdRate),
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
 * tolerance. Any real price change on the gateway (or a new cache price
 * appearing/disappearing) still updates the file.
 */
function stableCost(
  desired: SyncedFullModel["cost"],
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] {
  const current = existing?.cost;
  if (desired === undefined || current === undefined) return desired;
  if (current.input === undefined || current.output === undefined) return desired;
  const keys = ["input", "output", "cache_read", "cache_write"] as const;
  const stable = keys.every((key) => withinTolerance(current[key], desired[key]));
  if (!stable) return desired;
  return {
    input: current.input,
    output: current.output,
    cache_read: current.cache_read,
    cache_write: current.cache_write,
  };
}

function reasoningOptions(reasoning: boolean): SyncedFullModel["reasoning_options"] {
  if (!reasoning) return;
  return [{ type: "effort", values: [...REASONING_EFFORTS] }, { type: "budget_tokens" }];
}

export function buildHubrisModel(
  model: HubrisModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  // Hubris only relays models built by other labs, so every entry must factor
  // onto the canonical lab metadata. Models without a `models/` entry are
  // reported as skipped instead of being authored inline.
  const canonical = resolveModelMetadataBaseModel(model.id);
  if (canonical === undefined) return undefined;

  const params = model.supportedParameters ?? [];
  const reasoning = params.includes("reasoning");
  const context = model.contextWindow != null && model.contextWindow > 0 ? model.contextWindow : undefined;
  // The catalog does not publish a max-output figure. Inherit the lab's
  // `limit.output`; when the lab entry has none, fall back to the context
  // window (as the Requesty sync does) so the provider model still resolves.
  const baseLimit = modelMetadata(canonical).limit;
  const baseOutput =
    typeof baseLimit === "object" && baseLimit !== null && typeof (baseLimit as { output?: unknown }).output === "number"
      ? ((baseLimit as { output: number }).output)
      : undefined;
  const limit =
    context === undefined
      ? undefined
      : baseOutput === undefined
        ? { context, output: context }
        : { context };

  return factorBaseModel(
    canonical,
    {
      reasoning,
      reasoning_options: reasoningOptions(reasoning),
      tool_call: params.includes("tools"),
      structured_output: params.includes("structured_outputs"),
      cost: stableCost(buildCost(model), existing),
      limit,
    },
    limit,
    existing?.base_model_omit,
  );
}

// ========================================
// Hubris provider
// ========================================

export const hubris = {
  id: "hubris",
  name: "Hubris",
  modelsDir: "providers/hubris/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  // Models without lab metadata are intentionally left out of the catalog;
  // they are listed in the sync notices, not opened as issues.
  trackMissingModels: false,
  sourceID(model) {
    return isChatModel(model) ? model.id : undefined;
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
    return { catalog, usdRate };
  },
  parseModels(raw) {
    const source = HubrisSource.parse(raw);
    return source.catalog.items.map((model) => ({ ...model, usdRate: source.usdRate }));
  },
  translateModel(model, context) {
    if (!isChatModel(model)) return undefined;
    const built = buildHubrisModel(model, context.existing(model.id));
    if (built === undefined) return undefined;
    return { id: model.id, model: built };
  },
} satisfies SyncProvider<HubrisModel>;
