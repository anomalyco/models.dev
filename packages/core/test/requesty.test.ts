import { expect, test } from "bun:test";

import { buildRequestyModel, RequestyModel, resolveRequestyBaseModel } from "../src/sync/providers/requesty.js";

test.each([
  ["claude-fable-5.1", "anthropic/claude-fable-5-1"],
  ["claude-fable-5.1@eu", "anthropic/claude-fable-5-1"],
  ["claude-sonnet-4.6", "anthropic/claude-sonnet-4-6"],
  ["claude-sonnet-4", "anthropic/claude-sonnet-4-0"],
  ["claude-opus-4-7", "anthropic/claude-opus-4-7"],
  ["gemini-3.8-flash@eu", "google/gemini-3.8-flash"],
  ["qwen3.8-2.4T-A95B@eu", "alibaba/qwen3.8-2.4t-a95b"],
])("resolves Requesty %s to %s", (id, expected) => {
  expect(resolveRequestyBaseModel(id)).toBe(expected);
});

test("does not invent a base model for unknown Claude releases", () => {
  expect(resolveRequestyBaseModel("claude-fable-999.1@eu")).toBeUndefined();
});

test.each(["claude-fable-5.1", "claude-fable-5.1@eu"])(
  "keeps %s override-only",
  (id) => {
    const model = buildRequestyModel(RequestyModel.parse({
      id,
      created: Date.parse("2026-09-01") / 1_000,
      description: "Requesty description",
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      supports_vision: true,
      supports_reasoning: true,
      supports_tool_calling: true,
      supports_output_json_schema: true,
      input_price: 0.00001,
      output_price: 0.00005,
      cached_price: 0.00000025,
      caching_price: 0.0000125,
    }));

    expect(JSON.parse(JSON.stringify(model))).toEqual({
      base_model: "anthropic/claude-fable-5-1",
      ...(id.endsWith("@eu") ? { name: "Claude Fable 5.1 (EU)" } : {}),
      structured_output: true,
      reasoning_options: [
        { type: "effort", values: ["none", "low", "medium", "high", "max"] },
        { type: "budget_tokens" },
      ],
      cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
    });
  },
);

test("uses the first Requesty pricing band as the base cost", () => {
  const model = buildRequestyModel(RequestyModel.parse({
    id: "requesty-priced-model",
    created: Date.parse("2026-09-01") / 1_000,
    description: "Requesty description",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    input_price: 0.000001,
    output_price: 0.000002,
    cached_price: 0.000003,
    caching_price: 0.000004,
    pricing: [
      {
        prompt_tokens_threshold: 0,
        input_price: 0.00001,
        output_price: 0.00005,
        cached_price: 0.00000025,
        caching_price: 0.0000125,
      },
      {
        prompt_tokens_threshold: 200_000,
        input_price: 0.00002,
        output_price: 0.000075,
        cached_price: 0.0000005,
        caching_price: 0.000025,
      },
    ],
  }));

  expect(model.cost).toEqual({
    input: 10,
    output: 50,
    cache_read: 0.25,
    cache_write: 12.5,
    tiers: [{
      tier: { type: "context", size: 200_000 },
      input: 20,
      output: 75,
      cache_read: 0.5,
      cache_write: 25,
    }],
  });
});

test("uses Requesty pricing bands when top-level prices are null", () => {
  const model = buildRequestyModel(RequestyModel.parse({
    id: "requesty-priced-model",
    created: Date.parse("2026-09-01") / 1_000,
    description: "Requesty description",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    input_price: null,
    output_price: null,
    pricing: [
      {
        prompt_tokens_threshold: 0,
        input_price: 0.00001,
        output_price: 0.00005,
      },
      {
        prompt_tokens_threshold: 200_000,
        input_price: null,
        output_price: null,
      },
    ],
  }));

  expect(model.cost).toEqual({
    input: 10,
    output: 50,
    tiers: [{
      tier: { type: "context", size: 200_000 },
      input: 10,
      output: 50,
    }],
  });
});
