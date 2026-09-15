import { expect, test } from "bun:test";

import {
  buildDeepInfraModel,
  type DeepInfraModel,
} from "../src/sync/providers/deepinfra.js";

function deepinfraModel(overrides: Partial<DeepInfraModel> = {}): DeepInfraModel {
  return {
    model_name: "ByteDance/Seed-2.0-pro",
    type: "text-generation",
    tags: ["tools", "multimodal"],
    pricing: {
      type: "tokens",
      cents_per_input_token: 5e-5,
      cents_per_output_token: 3e-4,
      rate_per_input_token_cached: 0.2,
      full: "$0.50 in $3 out $0.10 cached <= 128K, $1 in $6 out $0.20 cached",
    },
    max_tokens: 256_000,
    ...overrides,
  };
}

test("derives tiered cache_read from the cached-rate multiplier", () => {
  const built = buildDeepInfraModel(deepinfraModel(), undefined);

  expect(built.cost).toMatchObject({
    input: 0.5,
    output: 3,
    cache_read: 0.1,
    tiers: [
      { tier: { type: "context", size: 128_000 }, input: 1, output: 6, cache_read: 0.2 },
    ],
  });
});

test("prefers the cached-rate multiplier over a disagreeing price string", () => {
  // Live payload for ByteDance/Seed-2.0-mini: the string restates the tier's
  // cached price as `$0.2`, which is its *input* price — cached input would
  // cost the same as fresh input. The multiplier gives $0.04, and agrees with
  // the string on every other segment DeepInfra publishes.
  const built = buildDeepInfraModel(
    deepinfraModel({
      model_name: "ByteDance/Seed-2.0-mini",
      pricing: {
        cents_per_input_token: 1e-5,
        cents_per_output_token: 4e-5,
        rate_per_input_token_cached: 0.2,
        full: "$0.10 in $0.40 out $0.02 cached <= 128K, $0.2 in $0.80 out $0.2 cached",
      },
    }),
    undefined,
  );

  expect(built.cost).toMatchObject({
    input: 0.1,
    cache_read: 0.02,
    tiers: [
      { tier: { type: "context", size: 128_000 }, input: 0.2, cache_read: 0.04 },
    ],
  });
  // The cached price must stay below the fresh-input price it discounts.
  const tier = built.cost?.tiers?.[0];
  expect(tier?.cache_read).toBeLessThan(tier!.input!);
});

test("keeps the stated cached price when no multiplier is published", () => {
  const built = buildDeepInfraModel(
    deepinfraModel({
      pricing: {
        cents_per_input_token: 5e-5,
        cents_per_output_token: 3e-4,
        rate_per_input_token_cached: null,
        full: "$0.50 in $3 out $0.10 cached <= 128K, $1 in $6 out $0.20 cached",
      },
    }),
    undefined,
  );

  expect(built.cost).toMatchObject({
    cache_read: 0.1,
    tiers: [{ tier: { type: "context", size: 128_000 }, cache_read: 0.2 }],
  });
});

test("scales cache_write per tier instead of only pricing the base tier", () => {
  const built = buildDeepInfraModel(
    deepinfraModel({
      pricing: {
        cents_per_input_token: 5e-5,
        cents_per_output_token: 3e-4,
        rate_per_input_token_cached: 0.2,
        rate_per_input_token_cache_write: 1.25,
        full: "$0.50 in $3 out $0.10 cached <= 128K, $1 in $6 out $0.20 cached",
      },
    }),
    undefined,
  );

  expect(built.cost).toMatchObject({
    cache_write: 0.625,
    tiers: [{ tier: { type: "context", size: 128_000 }, cache_write: 1.25 }],
  });
});

test("carries every band of a three-tier price string", () => {
  const built = buildDeepInfraModel(
    deepinfraModel({
      model_name: "Qwen/Qwen3.7-Max",
      pricing: {
        cents_per_input_token: 2.5e-4,
        cents_per_output_token: 7.5e-4,
        rate_per_input_token_cached: 0.2,
        full:
          "$2.50 in $7.50 out $0.50 cached <= 32K, $5.0 in $15 out $1.0 cached <= 128K, "
          + "$6.25 in $18.50 out $1.25 cached > 128K",
      },
    }),
    undefined,
  );

  expect(built.cost).toMatchObject({
    input: 2.5,
    output: 7.5,
    cache_read: 0.5,
    tiers: [
      { tier: { type: "context", size: 32_000 }, input: 5, output: 15, cache_read: 1 },
      { tier: { type: "context", size: 128_000 }, input: 6.25, output: 18.5, cache_read: 1.25 },
    ],
  });
});
