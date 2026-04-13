#!/usr/bin/env bun

/**
 * Generate Amazon Bedrock model TOML files by combining data from the
 * Bedrock ListFoundationModels API (multi-region) and the AWS Pricing API.
 *
 * ⚠️ IMPORTANT CAVEATS:
 * 1. Bedrock's ListFoundationModels API does not expose whether 'pdf' or
 *    'audio' modalities are supported, so this generator preserves those if
 *    already manually listed in the TOML, but won't be able to add them.
 * 2. Bedrock model prices may vary by AWS Region and selected service tier.
 *    Since the models.dev schema doesn't currently provide a way to list
 *    multiple prices per model, we list the cheapest available on-demand,
 *    online (non-batch) price across the tested regions - which is usually
 *    equivalent to using flex tier inference in the US.
 * 3. This script currently only captures text-generation models - doesn't
 *    populate media generation models e.g. Stable Diffusion, Nova Reel, etc.
 *
 * Flags:
 * --dry-run: Preview changes without writing files
 * --new-only: Only create new models, skip updating existing ones
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  type FoundationModelSummary,
} from "@aws-sdk/client-bedrock";
import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";
import { ModelFamilyValues } from "../src/family";

/**
 * Combine the model lists from these regions
 *
 * Different models may be available in different regions, but at the time of
 * writing this set should cover all supported models.
 */
const BEDROCK_REGIONS = ["us-east-1", "us-west-2"];

/**
 * Map Bedrock API modality strings (uppercase) to schema values (lowercase).
 */
const MODALITIES_API_MAP: Map<string, string> = new Map([
  ["TEXT", "text"],
  ["IMAGE", "image"],
]);

const MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "providers",
  "amazon-bedrock",
  "models",
);

export interface BedrockModel {
  modelId: string;
  modelName: string;
  inputModalities: string[];
  outputModalities: string[];
  releaseDate?: Date;
}

/**
 * Product attributes as returned by AWS Pricing API
 */
interface PricingProductAttributes {
  /**
   * Feature
   * @example "On-demand Inference"
   */
  feature?: string;
  /**
   * Type of inference
   * @example "Output tokens priority"
   */
  inferenceType?: string;
  /**
   * Specific location the pricing applies to
   * @example "US East (N. Virginia)"
   */
  location?: string;
  /**
   * Type of location the pricing applies to
   * @example "AWS Region"
   */
  locationType?: string;
  /**
   * Name of the Foundation Model
   * @example "Qwen3 Coder 30B A3B"
   */
  model?: string;
  /**
   * API Operation corresponding to the pricing (may be empty for Mantle)
   * @example ""
   */
  operation?: string;
  /**
   * Foundation Model provider
   * @example "Qwen"
   */
  provider?: string;
  /**
   * AWS Region
   * @example "us-east-1"
   */
  regionCode?: string;
  /**
   * Service tier (missing in some cases)
   * @example "batch"
   */
  service_tier?: string;
  /**
   * AWS Service
   * @example "AmazonBedrock"
   */
  servicecode: string;
  /**
   * Name of the AWS Service
   * @example "Amazon Bedrock"
   */
  servicename?: string;
  /**
   * Listed type of usage for AWS Billing
   * @example "USE1-Qwen3Coder-30B-A3B-output-tokens-priority"
   */
  usagetype: string;
}

export interface PricingRecord {
  inputPrice: number | null;
  outputPrice: number | null;
}

export interface ExistingModel {
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface MergedModel {
  name: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  structured_output?: boolean;
  temperature: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
  open_weights: boolean;
  interleaved?: boolean | { field: string };
  status?: string;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
}

export interface Changes {
  field: string;
  oldValue: string;
  newValue: string;
}

export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatNumber(n: number): string {
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

/**
 * Avoid machine precision-related rounding issues in output pricing
 */
export function formatPriceNumber(n:number): string {
  return (Math.round(n * 1e8) / 1e8).toString();
}

// ---------------------------------------------------------------------------
// Pricing utilities
// ---------------------------------------------------------------------------

/**
 * Extract the model slug from a Pricing API `usagetype` string.
 * Strips the region prefix (e.g. `USE1-`) and token-type suffix
 * (e.g. `-input-tokens`, `-mantle-output-tokens-standard`).
 *
 * Returns `null` when usagetype doesn't match the expected token pattern.
 */
export function extractModelSlug(usagetype: string): string | null {
  // Must contain a token-type suffix to be relevant
  const tokenSuffix = /-(?:mantle-)?(input|output)-tokens(?:-\w+)?$/;
  if (!tokenSuffix.test(usagetype)) return null;

  let slug = usagetype;

  // Strip region prefix (e.g. USE1-, EUW1-, APN1-)
  slug = slug.replace(/^[A-Z]{2,4}\d+-/, "");

  // Strip token-type suffix
  slug = slug.replace(tokenSuffix, "");

  return slug || null;
}

/**
 * Normalize a price value to per-1M-tokens.
 * - "1K tokens" → price * 1000
 * - "1M tokens" → price as-is
 * - Returns null for zero, negative, or unrecognized units.
 */
export function normalizePrice(price: number, unit: string): number | null {
  if (price <= 0 || !Number.isFinite(price)) return null;

  switch (unit) {
    case "1K tokens":
      return price * 1000;
    case "1M tokens":
      return price;
    default:
      return null;
  }
}

/**
 * Check whether a pricing API product is eligible for our listing
 *
 * Since the other fields are sometimes absent, we use the usagetype field as
 * the main basis for testing. Rejects e.g. custom model imports, batch
 * inference, etc. At this level we currently allow records of different
 * on-demand inference tiers (flex, priority, standard, etc).
 *
 * Example usagetype patterns:
 *   `USE1-ModelSlug-input-tokens`              (bare — no tier suffix)
 *   `USE1-slug-mantle-output-tokens-standard`  (explicit -standard tier)
 *   `USE1-slug-mantle-output-tokens-flex`      (explicit -flex tier)
 *
 * @returns true if the listing is eligible for models.dev, false otherwise
 */
export function isExpectedProductType(
  attrs?: PricingProductAttributes,
): boolean {
  if (!attrs) return false;
  if (!attrs.usagetype) return false;

  // Exclude batch inference, model import records, etc.
  if (attrs.feature && attrs.feature.toLowerCase() !== "on-demand inference")
    return false;

  // Usage type must end with a token suffix we recognise
  const standardBare = /-(?:input|output)-tokens$/;
  const explicitTier =
    /-(?:mantle-)?(input|output)-tokens-(flex|priority|standard)$/;

  if (
    standardBare.test(attrs.usagetype) ||
    explicitTier.test(attrs.usagetype)
  ) {
    // Reject if it also contains known non-standard markers anywhere
    const rejectPatterns =
      /-(batch|custom-model|cross-region|latency-optimized)/;
    return !rejectPatterns.test(attrs.usagetype);
  }

  return false;
}

/**
 * Match pricing for a model ID. Tries exact match, then strips region
 * prefix (us., eu., global.) and retries.
 */
export function matchPricing(
  modelId: string,
  pricing: Map<string, PricingRecord>,
): PricingRecord | undefined {
  // Try exact match first
  const exact = pricing.get(modelId);
  if (exact) return exact;

  // If model ID has a region prefix, strip it and retry
  const regionPrefixPattern = /^(us|eu|global)\./;
  if (regionPrefixPattern.test(modelId)) {
    const stripped = modelId.replace(regionPrefixPattern, "");
    return pricing.get(stripped);
  }

  // Look for more generic entries in pricing map e.g.
  // "Llama3-8B" in place of model ID "meta.llama3-8b-instruct-v1:0"
  const keysLongToShort = [...pricing.keys()].sort(
    (a, b) => b.length - a.length,
  );
  for (const key of keysLongToShort) {
    if (modelId.toLowerCase().includes(key.toLowerCase())) {
      return pricing.get(key);
    }
  }

  return undefined;
}

/**
 * Fetch pricing data from the AWS Pricing API for Amazon Bedrock.
 *
 * Creates a PricingClient in us-east-1 (the only region the Pricing API
 * is available in), calls GetProductsCommand with ServiceCode=AmazonBedrock
 * filtered by regionCode, paginates through all results, parses real-time
 * on-demand records, extracts model slugs, normalizes prices to per-1M-tokens,
 * and returns a Map<slug, PricingRecord>.
 */
export async function fetchPricing(
  regions: string[],
): Promise<Map<string, PricingRecord>> {
  const pricingMap = new Map<string, PricingRecord>();

  try {
    const client = new PricingClient({ region: "us-east-1" });

    let nextToken: string | undefined;

    do {
      const command = new GetProductsCommand({
        ServiceCode: "AmazonBedrock",
        Filters: [
          {
            Type: "ANY_OF",
            Field: "regionCode",
            Value: regions.join(","),
          },
        ],
        MaxResults: 100,
        ...(nextToken && { NextToken: nextToken }),
      });

      const response = await client.send(command);
      const priceList = response.PriceList ?? [];

      for (const item of priceList) {
        try {
          // The SDK may return items as boxed String objects (typeof === "object")
          // so always coerce to primitive string before parsing.
          const product = JSON.parse(String(item));

          // Ignore records for unexpected product types e.g. batch inference:
          if (!isExpectedProductType(product?.product?.attributes)) continue;
          const usagetype = product?.product?.attributes?.usagetype ?? "";

          const slug = extractModelSlug(usagetype);
          if (!slug) continue;

          // Determine if this is an input or output record
          const isInput = /-(?:mantle-)?input-tokens(?:-\w+)?$/.test(usagetype);

          // Extract price from On-Demand terms
          const terms = product?.terms?.OnDemand;
          if (!terms) continue;

          // Navigate the nested pricing structure:
          // terms.OnDemand -> { <skuTermCode>: { priceDimensions: { <rateCode>: { pricePerUnit, unit } } } }
          const termValues = Object.values(terms) as Array<{
            priceDimensions?: Record<
              string,
              {
                beginRange?: string;
                pricePerUnit?: { USD?: string };
                unit?: string;
              }
            >;
          }>;

          for (const term of termValues) {
            const dimensions = term?.priceDimensions;
            if (!dimensions) continue;

            for (const dim of Object.values(dimensions)) {
              // Ignore volume discount price listings:
              if (dim?.beginRange) {
                const beginRange = parseFloat(dim?.beginRange ?? "");
                if (beginRange > 0) continue;
              }

              // Normalize price to per 1M tokens:
              const rawPrice = parseFloat(dim?.pricePerUnit?.USD ?? "");
              const unit = dim?.unit ?? "";
              const normalizedPrice = normalizePrice(rawPrice, unit);
              if (normalizedPrice === null) continue;

              // Get or create the record for this slug
              const existing = pricingMap.get(slug) ?? {
                inputPrice: null,
                outputPrice: null,
              };

              // Keep the cheapest available price (may vary between regions)
              if (isInput) {
                if (
                  existing.inputPrice === null ||
                  normalizedPrice < existing.inputPrice
                )
                  existing.inputPrice = normalizedPrice;
              } else {
                if (
                  existing.outputPrice === null ||
                  normalizedPrice < existing.outputPrice
                )
                  existing.outputPrice = normalizedPrice;
              }

              pricingMap.set(slug, existing);
            }
          }
        } catch {
          // Skip malformed price items
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);
  } catch (err) {
    console.warn(
      `  Warning: Failed to fetch pricing data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return pricingMap;
}

// ---------------------------------------------------------------------------
// Model list fetching, filtering, and deduplication
// ---------------------------------------------------------------------------

/**
 * Filter Bedrock models to only those with "TEXT" in outputModalities.
 */
export function filterTextModels(models: BedrockModel[]): BedrockModel[] {
  return models.filter((m) => m.outputModalities.includes("TEXT"));
}

/**
 * Deduplicate models by model ID (first-seen wins).
 */
export function deduplicateModels(
  models: BedrockModel[],
): Map<string, BedrockModel> {
  const seen = new Map<string, BedrockModel>();
  for (const model of models) {
    if (!seen.has(model.modelId)) {
      seen.set(model.modelId, model);
    }
  }
  return seen;
}

/**
 * Merge a list of supported modalities with new information from Bedrock API
 *
 * Maps Bedrock API modalities to models.dev format. Preserves listed
 * modalities that aren't documented in Bedrock API (e.g. audio, pdf - which
 * could be supported or not by models but aren't specified). Preserves
 * existing listed order where possible and inserts in alphabetical order.
 */
export function mergeModalities(
  existing: string[] | undefined,
  fromApi: string[],
): string[] {
  // Map API result to models.dev modalities:
  const proposed = fromApi
    .map((m_raw) => MODALITIES_API_MAP.get(m_raw))
    .filter((m): m is string => !!m);

  // Drop any from existing that API says aren't supported, but keep any that
  // the API isn't able to confirm or deny:
  const MODALITIES_SUPPORTED = [...MODALITIES_API_MAP.values()];
  const result = [...(existing || [])].filter((m) => {
    if (proposed.indexOf(m) >= 0) return true;
    if (MODALITIES_SUPPORTED.indexOf(m) < 0) return true;
    return false;
  });

  // Insert any from API that aren't yet present in existing, at the first
  // location that would be alphabetically ordered (given the list might be
  // unsorted and we don't want to change that unnecessarily)
  for (const m of proposed) {
    if (!result.includes(m)) {
      const ixInsert = result.findIndex((mCurr) => mCurr > m);
      if (ixInsert >= 0) {
        result.splice(ixInsert, 0, m);
      } else {
        result.push(m);
      }
    }
  }

  return result;
}

/**
 * Merge API model data with an existing TOML model (if any) and pricing.
 */
export function mergeModel(
  apiModel: BedrockModel,
  existing: ExistingModel | null,
  pricing: PricingRecord | undefined,
): MergedModel {
  // Preserve manually-set fields from existing, or use defaults for new models
  const name = existing?.name ?? apiModel.modelName;
  const family =
    existing?.family ?? inferFamily(apiModel.modelId, apiModel.modelName);
  const attachment =
    existing?.attachment ?? apiModel.inputModalities.includes("IMAGE");
  const reasoning = existing?.reasoning ?? false;
  const toolCall = existing?.tool_call ?? false;
  const temperature = existing?.temperature ?? true;
  const openWeights = existing?.open_weights ?? false;
  const releaseDate = apiModel.releaseDate
    ? apiModel.releaseDate.toISOString().slice(0, 10)
    : (existing?.release_date ?? getTodayDate());
  const knowledge = existing?.knowledge;
  const structuredOutput = existing?.structured_output;
  const interleaved = existing?.interleaved;
  const status = existing?.status;

  const inputModalities = mergeModalities(
    existing?.modalities?.input,
    apiModel.inputModalities,
  );
  const outputModalities = mergeModalities(
    existing?.modalities?.output,
    apiModel.outputModalities,
  );

  const merged: MergedModel = {
    name,
    ...(family !== undefined && { family }),
    attachment,
    reasoning,
    tool_call: toolCall,
    temperature,
    release_date: releaseDate,
    last_updated: getTodayDate(),
    open_weights: openWeights,
    ...(structuredOutput !== undefined && {
      structured_output: structuredOutput,
    }),
    ...(knowledge !== undefined && { knowledge }),
    ...(interleaved !== undefined && { interleaved }),
    ...(status !== undefined && { status }),
    limit: {
      context: existing?.limit?.context ?? 0,
      output: existing?.limit?.output ?? 0,
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };

  // Apply pricing if matched
  if (pricing) {
    const cost: MergedModel["cost"] = {
      input: pricing.inputPrice ?? 0,
      output: pricing.outputPrice ?? 0,
    };
    // Preserve cache pricing from existing
    if (existing?.cost?.cache_read !== undefined) {
      cost.cache_read = existing.cost.cache_read;
    }
    if (existing?.cost?.cache_write !== undefined) {
      cost.cache_write = existing.cost.cache_write;
    }
    merged.cost = cost;
  } else if (existing?.cost) {
    // Preserve existing cost entirely if no new pricing matched
    const cost: MergedModel["cost"] = {
      input: existing.cost.input ?? 0,
      output: existing.cost.output ?? 0,
    };
    if (existing.cost.cache_read !== undefined) {
      cost.cache_read = existing.cost.cache_read;
    }
    if (existing.cost.cache_write !== undefined) {
      cost.cache_write = existing.cost.cache_write;
    }
    merged.cost = cost;
  }

  return merged;
}

function matchesFamilySubsequence(target: string, family: string): boolean {
  const targetLower = target.toLowerCase();
  const familyLower = family.toLowerCase();
  let familyIdx = 0;

  for (
    let i = 0;
    i < targetLower.length && familyIdx < familyLower.length;
    i++
  ) {
    if (targetLower[i] === familyLower[familyIdx]) {
      familyIdx++;
    }
  }

  return familyIdx === familyLower.length;
}

/**
 * Infer the model family from model ID and name using ModelFamilyValues.
 */
export function inferFamily(
  modelId: string,
  modelName: string,
): string | undefined {
  const sortedFamilies = [...ModelFamilyValues]
    .filter((f) => f.length >= 3) // Avoid spurious matches on 'o' family
    .sort((a, b) => b.length - a.length);

  // First pass: try exact substring matches
  const isSubstring = (target: string, family: string): boolean =>
    target.toLowerCase().includes(family.toLowerCase());
  for (const family of sortedFamilies) {
    if (isSubstring(modelId, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (isSubstring(modelName, family)) {
      return family;
    }
  }

  // Second pass: fall back to subsequence matching
  for (const family of sortedFamilies) {
    if (matchesFamilySubsequence(modelId, family)) {
      return family;
    }
  }

  for (const family of sortedFamilies) {
    if (matchesFamilySubsequence(modelName, family)) {
      return family;
    }
  }

  return undefined;
}

/**
 * Fetch all text-output models from Bedrock across multiple regions.
 * Creates a BedrockClient per region, calls ListFoundationModels,
 * filters to text-output models, and deduplicates by model ID
 * (first-seen wins). Logs warnings for failed regions and continues.
 */
export async function fetchAllModels(
  regions: string[],
): Promise<Map<string, BedrockModel>> {
  const allModels: BedrockModel[] = [];

  for (const region of regions) {
    try {
      const client = new BedrockClient({ region });
      const command = new ListFoundationModelsCommand({});
      const response = await client.send(command);

      const summaries = response.modelSummaries ?? [];
      const models: BedrockModel[] = summaries.map(
        (s: FoundationModelSummary) => ({
          modelId: s.modelId ?? "",
          modelName: s.modelName ?? "",
          inputModalities: s.inputModalities ?? [],
          outputModalities: s.outputModalities ?? [],
          releaseDate: s.modelLifecycle?.startOfLifeTime,
        }),
      );

      const textModels = filterTextModels(models);
      console.log(
        `  ${region}: ${summaries.length} models, ${textModels.length} text-output`,
      );
      allModels.push(...textModels);
    } catch (err) {
      console.warn(
        `  Warning: Failed to fetch models from ${region}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return deduplicateModels(allModels);
}

// ---------------------------------------------------------------------------
// TOML formatting and change detection
// ---------------------------------------------------------------------------

/**
 * Format a MergedModel as a TOML string following established field ordering.
 *
 * Field order matches existing Bedrock TOML files:
 *   name, family, release_date, last_updated,
 *   attachment, reasoning, temperature, tool_call, structured_output,
 *   interleaved (boolean only), knowledge, open_weights, status,
 *   [interleaved] (object form), [cost], [limit], [modalities]
 */
export function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  lines.push(`name = "${model.name.replace(/"/g, '\\"')}"`);
  if (model.family) {
    lines.push(`family = "${model.family}"`);
  }
  lines.push(`release_date = "${model.release_date}"`);
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`temperature = ${model.temperature}`);
  if (model.knowledge) {
    lines.push(`knowledge = "${model.knowledge}"`);
  }
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  // interleaved = true goes inline with the booleans
  if (model.interleaved === true) {
    lines.push(`interleaved = true`);
  }
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.status) {
    lines.push(`status = "${model.status}"`);
  }

  // interleaved as object gets its own section
  if (typeof model.interleaved === "object" && model.interleaved !== null) {
    lines.push("");
    lines.push(`[interleaved]`);
    lines.push(`field = "${model.interleaved.field}"`);
  }

  if (model.cost) {
    lines.push("");
    lines.push(`[cost]`);
    lines.push(`input = ${formatPriceNumber(model.cost.input)}`);
    lines.push(`output = ${formatPriceNumber(model.cost.output)}`);
    if (model.cost.cache_read !== undefined) {
      lines.push(`cache_read = ${model.cost.cache_read}`);
    }
    if (model.cost.cache_write !== undefined) {
      lines.push(`cache_write = ${model.cost.cache_write}`);
    }
  }

  lines.push("");
  lines.push(`[limit]`);
  lines.push(`context = ${formatNumber(model.limit.context)}`);
  lines.push(`output = ${formatNumber(model.limit.output)}`);

  lines.push("");
  lines.push(`[modalities]`);
  lines.push(
    `input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`,
  );
  lines.push(
    `output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Detect field-level changes between an existing model and a merged model.
 * Returns an empty array when existing is null (new model — no changes to report).
 * Uses epsilon for price comparisons to avoid noise from floating-point rounding.
 */
export function detectChanges(
  existing: ExistingModel | null,
  merged: MergedModel,
): Changes[] {
  if (!existing) return [];

  const changes: Changes[] = [];
  const EPSILON = 0.001;

  // Fields where a zero value is a placeholder — skip comparison when either
  // side is zero so we don't report noise for unset limits.
  const zeroSkipFields = new Set([
    "limit.context",
    "limit.input",
    "limit.output",
  ]);

  const fmt = (val: unknown): string => {
    if (typeof val === "number") return formatNumber(val);
    if (Array.isArray(val)) return `[${val.join(", ")}]`;
    if (val === undefined) return "(none)";
    return String(val);
  };

  const isPriceDiff = (oldPrice: unknown, newPrice: unknown): boolean => {
    // 0 → undefined is not material
    if (oldPrice === 0 && newPrice === undefined) return false;
    if (typeof oldPrice === "number" && typeof newPrice === "number") {
      return Math.abs(oldPrice - newPrice) > EPSILON;
    }
    return oldPrice !== newPrice;
  };

  const compare = (field: string, oldVal: unknown, newVal: unknown) => {
    if (zeroSkipFields.has(field)) {
      if (
        (typeof oldVal === "number" && oldVal === 0) ||
        (typeof newVal === "number" && newVal === 0)
      )
        return;
    }

    const isDiff = field.startsWith("cost.")
      ? isPriceDiff(oldVal, newVal)
      : JSON.stringify(oldVal) !== JSON.stringify(newVal);

    if (isDiff) {
      changes.push({ field, oldValue: fmt(oldVal), newValue: fmt(newVal) });
    }
  };

  compare("name", existing.name, merged.name);
  compare("family", existing.family, merged.family);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare(
    "structured_output",
    existing.structured_output,
    merged.structured_output,
  );
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("release_date", existing.release_date, merged.release_date);
  compare("cost.input", existing.cost?.input, merged.cost?.input);
  compare("cost.output", existing.cost?.output, merged.cost?.output);
  compare(
    "cost.cache_read",
    existing.cost?.cache_read,
    merged.cost?.cache_read,
  );
  compare(
    "cost.cache_write",
    existing.cost?.cache_write,
    merged.cost?.cache_write,
  );
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare(
    "modalities.input",
    existing.modalities?.input,
    merged.modalities.input,
  );
  compare(
    "modalities.output",
    existing.modalities?.output,
    merged.modalities.output,
  );

  return changes;
}

/**
 * Load and parse an existing TOML model file.
 * Returns null if the file doesn't exist or fails to parse (logs warning on parse failure).
 */
export async function loadExistingModel(
  filePath: string,
): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }
    const toml = await import(filePath, { with: { type: "toml" } }).then(
      (mod) => mod.default,
    );
    return toml as ExistingModel;
  } catch (e) {
    console.warn(`Warning: Failed to parse existing file ${filePath}:`, e);
    return null;
  }
}

/**
 * Detect orphaned TOML files — files that exist on disk but whose model ID
 * is not present in the API response. Returns the list of orphaned relative
 * file paths sorted alphabetically. Never deletes any files.
 */
export function detectOrphans(
  existingFiles: Set<string>,
  apiModelIds: Set<string>,
): string[] {
  const orphans: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphans.push(file);
    }
  }
  return orphans.sort();
}

/**
 * Generate/update data files for Amazon Bedrock models, querying AWS APIs
 */
export async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching Amazon Bedrock models...`,
  );

  // Fetch models and pricing in parallel
  const [models, pricing] = await Promise.all([
    fetchAllModels(BEDROCK_REGIONS),
    fetchPricing(BEDROCK_REGIONS),
  ]);

  console.log(
    `Found ${models.size} models from API, fetched ${pricing.size} pricing records\n`,
  );

  // Scan existing files
  const existingFiles = new Set<string>();
  try {
    for await (const file of new Bun.Glob("**/*.toml").scan({
      cwd: MODELS_DIR,
      absolute: false,
    })) {
      existingFiles.add(file);
    }
  } catch {
    // Directory may not exist yet
  }

  const apiModelIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const [modelId, apiModel] of models) {
    const relativePath = `${modelId}.toml`;
    const filePath = path.join(MODELS_DIR, relativePath);
    const dirPath = path.dirname(filePath);

    apiModelIds.add(relativePath);

    const existing = await loadExistingModel(filePath);
    const matchedPricing = matchPricing(modelId, pricing);
    const merged = mergeModel(apiModel, existing, matchedPricing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
        console.log(`  name = "${merged.name}"`);
        if (merged.family) {
          console.log(`  family = "${merged.family}" (inferred)`);
        }
        console.log("");
      } else {
        await mkdir(dirPath, { recursive: true });
        await Bun.write(filePath, tomlContent);
        console.log(`Created: ${relativePath}`);
      }
    } else {
      if (newOnly) {
        unchanged++;
        continue;
      }

      const changes = detectChanges(existing, merged);

      if (changes.length > 0) {
        updated++;
        if (dryRun) {
          console.log(`[DRY RUN] Would update: ${relativePath}`);
        } else {
          await mkdir(dirPath, { recursive: true });
          await Bun.write(filePath, tomlContent);
          console.log(`Updated: ${relativePath}`);
        }
        for (const change of changes) {
          console.log(
            `  ${change.field}: ${change.oldValue} → ${change.newValue}`,
          );
        }
        console.log("");
      } else {
        unchanged++;
      }
    }
  }

  // Orphan detection
  const orphaned = detectOrphans(existingFiles, apiModelIds);
  for (const file of orphaned) {
    console.log(`Warning: Orphaned file (not in API): ${file}`);
  }

  // Summary
  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  }
}

// Only run when executed directly, not when imported for testing
if (import.meta.main) {
  await main();
}
