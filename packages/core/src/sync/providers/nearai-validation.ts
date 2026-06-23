import type { NearAIModel } from "./nearai.js";

export class NearAISourceMetadataError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super([
      "NEAR AI Cloud source metadata failed validation:",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"));
    this.name = "NearAISourceMetadataError";
    this.issues = issues;
  }
}

export function assertValidNearAISource(models: readonly NearAIModel[]) {
  const missingOutputLimit = models
    .filter((model) => sourceOutputLimit(model) === undefined)
    .map((model) => model.id);
  const cacheRead = models
    .filter((model) => isInvalidCachePrice(model.pricing.input_cache_read))
    .map((model) => model.id);
  const cacheWrite = models
    .filter((model) => isInvalidCachePrice(model.pricing.input_cache_write))
    .map((model) => model.id);
  const issues = [
    missingOutputLimit.length > 0
      ? `missing output token limits: ${missingOutputLimit.join(", ")}`
      : undefined,
    cacheRead.length > 0
      ? `non-positive input_cache_read values: ${cacheRead.join(", ")}`
      : undefined,
    cacheWrite.length > 0
      ? `non-positive input_cache_write values: ${cacheWrite.join(", ")}`
      : undefined,
  ].filter((issue) => issue !== undefined);

  if (issues.length > 0) throw new NearAISourceMetadataError(issues);
}

export function requiredOutputLimit(model: NearAIModel) {
  const outputLimit = sourceOutputLimit(model);
  if (outputLimit === undefined) {
    throw new NearAISourceMetadataError([
      `missing output token limit: ${model.id}`,
    ]);
  }
  return outputLimit;
}

export function cachePrice(value: string | number | undefined) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new NearAISourceMetadataError([`non-positive cache price: ${String(value)}`]);
  }
  return Math.round(number * 1_000_000_000_000) / 1_000_000;
}

function sourceOutputLimit(model: NearAIModel) {
  const outputLimit = model.max_output_length ?? model.top_provider?.max_completion_tokens;
  return outputLimit === undefined || outputLimit <= 0 ? undefined : outputLimit;
}

function isInvalidCachePrice(value: string | number | undefined) {
  if (value === undefined || value === "") return false;
  const number = Number(value);
  return !Number.isFinite(number) || number <= 0;
}
