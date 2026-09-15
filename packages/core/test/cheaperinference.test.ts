import { expect, test } from "bun:test";

import {
  buildCheaperInferenceModel,
  CheaperInferenceResponse,
  cheaperinference,
} from "../src/sync/providers/cheaperinference.js";

function sourceModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-sonnet-5",
    object: "model" as const,
    type: "text",
    endpoint: "/v1/chat/completions",
    context_length: 1_000_000,
    max_output_tokens: 64_000,
    is_free: false,
    pricing: {
      currency: "USD" as const,
      input_per_million: "1.400000",
      output_per_million: "7.000000",
      cache_read_input_per_million: "0.140000",
      cache_write_input_per_million: "1.700000",
      input_token_price_threshold: null,
      above_threshold: null,
    },
    ...overrides,
  };
}

const existing = {
  base_model: "anthropic/claude-sonnet-5",
  reasoning: true,
  reasoning_options: [{ type: "effort" as const, values: ["low", "high"] }],
  cost: { input: 1.4, output: 7 },
  limit: { context: 1_000_000, output: 64_000 },
};

test("syncs the gateway's discounted rates, including cache rates", () => {
  const model = buildCheaperInferenceModel(sourceModel() as never, existing as never);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-5",
    cost: { input: 1.4, output: 7, cache_read: 0.14, cache_write: 1.7 },
  });
});

test("turns a long-context band into a single context tier", () => {
  const model = buildCheaperInferenceModel(
    sourceModel({
      id: "gpt-5.6-luna",
      context_length: 1_050_000,
      max_output_tokens: 128_000,
      pricing: {
        currency: "USD",
        input_per_million: "0.080000",
        output_per_million: "0.480000",
        cache_read_input_per_million: "0.008000",
        cache_write_input_per_million: "0.100000",
        input_token_price_threshold: 271_999,
        above_threshold: {
          input_token_price_threshold: 271_999,
          input_per_million: "0.160000",
          output_per_million: "0.720000",
          cache_read_input_per_million: "0.016000",
          cache_write_input_per_million: "0.200000",
        },
      },
    }) as never,
    { ...existing, base_model: "openai/gpt-5.6-luna" } as never,
  );

  expect(model.cost?.tiers).toEqual([
    {
      tier: { type: "context", size: 272_000 },
      input: 0.16,
      output: 0.72,
      cache_read: 0.016,
      cache_write: 0.2,
    },
  ]);
});

test("takes the gateway's limits when it publishes them and inherits when it does not", () => {
  const capped = buildCheaperInferenceModel(
    sourceModel({ id: "deepseek-v4-flash-0731", context_length: 1_048_576, max_output_tokens: 65_536 }) as never,
    { ...existing, base_model: "deepseek/deepseek-v4-flash-0731", limit: { context: 1_000_000, output: 384_000 } } as never,
  );
  expect(capped.limit).toMatchObject({ context: 1_048_576, output: 65_536 });

  // With nothing published, the synced file authors no limit override at all
  // and the lab entry's limits keep applying.
  const unpublished = buildCheaperInferenceModel(
    sourceModel({ id: "gpt-oss-120b", context_length: null, max_output_tokens: null }) as never,
    { ...existing, base_model: "openai/gpt-oss-120b", limit: { context: 131_072, output: 32_768 } } as never,
  );
  expect(unpublished.limit).toBeUndefined();
});

test("refuses to sync a reasoning model that has no authored controls", () => {
  expect(() =>
    buildCheaperInferenceModel(sourceModel() as never, {
      ...existing,
      reasoning_options: undefined,
    } as never),
  ).toThrow(/reasoning_options/);
});

test("only syncs token-priced text routes", () => {
  const ids = [
    sourceModel(),
    sourceModel({ id: "nano-banana-2", type: "image", endpoint: "/v1/images/generations" }),
    sourceModel({ id: "seedance-2.0", type: "video", endpoint: "/v1/videos/generations" }),
    sourceModel({ id: "some-free-model", is_free: true }),
  ].map((model) => cheaperinference.sourceID(model as never));

  expect(ids).toEqual(["claude-sonnet-5", undefined, undefined, undefined]);
});

test("parses the catalog response shape", () => {
  const parsed = CheaperInferenceResponse.parse({
    object: "list",
    data: [sourceModel()],
    pricing_version: "sha256:abc",
    pricing_checked_at: "2026-09-10T21:01:09.012Z",
    pricing_updated_at: "2026-08-05T00:00:00.000Z",
  });

  expect(parsed.data[0]?.id).toBe("claude-sonnet-5");
});
