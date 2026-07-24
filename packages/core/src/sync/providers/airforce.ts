import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.airforce/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const PriceComponent = z.object({
  mode: z.string(),
  unit: z.string(),
  price_micro_usd: z.number().nonnegative(),
}).passthrough();

const PriceTable = z.object({
  components: z.array(PriceComponent).optional(),
}).passthrough();

export const AirforceModel = z.object({
  id: z.string().min(1),
  supports_chat: z.boolean().optional(),
  catalog_id: z.string().min(1).optional(),
  context_length: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  pricepermilliontokens: z.number().nonnegative().optional(),
  output_pricepermilliontokens: z.number().nonnegative().optional(),
  cache_read_pricepermilliontokens: z.number().nonnegative().optional(),
  cache_write_5m_pricepermilliontokens: z.number().nonnegative().optional(),
  customer_price_table: PriceTable.optional(),
}).passthrough();

export const AirforceResponse = z.object({
  data: z.array(AirforceModel),
}).passthrough();

export type AirforceModel = z.infer<typeof AirforceModel>;

interface MetadataEntry {
  id: string;
  normalizedFull: string;
  normalizedFilename: string;
}

let metadataEntries: MetadataEntry[] | undefined;
const modelMetadataByID = new Map<string, Record<string, unknown>>();

export const airforce = {
  id: "airforce",
  name: "Api.Airforce",
  modelsDir: "providers/airforce/models",
  async fetchModels() {
    const headers = process.env.AIRFORCE_API_KEY
      ? { Authorization: `Bearer ${process.env.AIRFORCE_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Api.Airforce models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AirforceResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.supports_chat === true ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `Skipped ${ids.length} Api.Airforce chat models without matching model metadata: ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    if (model.supports_chat !== true) return undefined;
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveAirforceBaseModel(model);
    // The catalog is authoritative for pricing but only reports context and
    // output limits for part of its models, and never reports release dates,
    // modalities, or capability flags for the rest. A model without a `models/`
    // metadata entry cannot be described from this endpoint alone, so it is only
    // synced when a hand-authored TOML already exists.
    if (baseModel === undefined && existing === undefined) return undefined;
    return { id: model.id, model: buildAirforceModel(model, existing, baseModel) };
  },
} satisfies SyncProvider<AirforceModel>;

export function buildAirforceModel(
  model: AirforceModel,
  existing: ExistingModel | undefined,
  baseModel: string | undefined = existing?.base_model ?? resolveAirforceBaseModel(model),
): SyncedModel {
  const cost = airforceCost(model) ?? existing?.cost;

  if (baseModel === undefined) {
    return { ...existing, cost } as SyncedFullModel;
  }

  const inherited = metadataLimit(baseModel);
  const limit = {
    context: model.context_length ?? inherited.context,
    input: existing?.limit?.input,
    output: model.max_output_tokens ?? inherited.output,
  };
  const servesOwnLimits = model.context_length !== undefined || model.max_output_tokens !== undefined;

  return factorBaseModel(
    baseModel,
    { cost, limit: servesOwnLimits ? limit : undefined },
    limit,
    existing?.base_model_omit,
  );
}

/**
 * Catalog prices are quoted in micro USD per million tokens. The flat
 * `*_pricepermilliontokens` fields carry the same numbers in cents, but the
 * price table is the only self-describing source of the billing unit.
 */
export function airforceCost(model: AirforceModel) {
  const components = model.customer_price_table?.components ?? [];
  const perMillionTokens = (mode: string, cents: number | undefined) => {
    const component = components.find((item) => item.mode === mode);
    if (component !== undefined && component.unit === "per_1m_tokens") {
      return component.price_micro_usd / 1_000_000;
    }
    return cents === undefined ? undefined : cents / 100;
  };

  const input = perMillionTokens("input", model.pricepermilliontokens);
  const output = perMillionTokens("output", model.output_pricepermilliontokens);
  if (input === undefined || output === undefined) return undefined;

  return {
    input,
    output,
    cache_read: perMillionTokens("cache_read", model.cache_read_pricepermilliontokens),
    cache_write: perMillionTokens("cache_write_5m", model.cache_write_5m_pricepermilliontokens),
  };
}

/**
 * `catalog_id` names the upstream model behind an Api.Airforce ID and lines up
 * with `models/` paths once punctuation is normalized. It uses its own provider
 * namespaces, so the bare model ID is matched as a fallback.
 */
export function resolveAirforceBaseModel(model: AirforceModel) {
  const entries = getMetadataEntries();
  for (const candidate of new Set([model.catalog_id, model.id].filter((value) => value !== undefined))) {
    const normalized = normalize(candidate);
    const ranked = [
      entries.filter((entry) => entry.normalizedFull === normalized),
      entries.filter((entry) => entry.normalizedFilename === normalized),
    ];
    const match = ranked.find((matches) => matches.length === 1)?.[0]?.id;
    if (match !== undefined) return match;
  }
  return undefined;
}

function metadataLimit(modelID: string) {
  let metadata = modelMetadataByID.get(modelID);
  if (metadata === undefined) {
    metadata = Bun.TOML.parse(
      readFileSync(path.join(MODELS_DIR, `${modelID}.toml`), "utf8"),
    ) as Record<string, unknown>;
    modelMetadataByID.set(modelID, metadata);
  }
  const limit = metadata.limit;
  if (limit === null || typeof limit !== "object" || Array.isArray(limit)) {
    throw new Error(`Model metadata is missing a limit: ${modelID}`);
  }
  const { context, output } = limit as { context?: unknown; output?: unknown };
  if (typeof context !== "number" || typeof output !== "number") {
    throw new Error(`Model metadata limit must define context and output: ${modelID}`);
  }
  return { context, output };
}

function getMetadataEntries() {
  if (metadataEntries !== undefined) return metadataEntries;
  metadataEntries = [];
  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const file of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const filename = file.name.slice(0, -5);
      metadataEntries.push({
        id: `${provider.name}/${filename}`,
        normalizedFull: normalize(`${provider.name}/${filename}`),
        normalizedFilename: normalize(filename),
      });
    }
  }
  return metadataEntries;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
