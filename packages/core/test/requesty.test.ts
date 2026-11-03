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
      ],
      cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
    });
  },
);

test.each([
  "claude-sonnet-5-5",
  "claude-sonnet-5-5@eu",
  "claude-sonnet-4-5",
  "openai/gpt-5.4",
  "google/gemini-2.5-pro",
  "requesty-unknown-model",
])("advertises only Requesty's effort control for %s", (id) => {
  const model = buildRequestyModel(RequestyModel.parse({
    id,
    created: Date.parse("2026-09-01") / 1_000,
    description: "Reasoning model",
    context_window: 200_000,
    max_output_tokens: 16_000,
    supports_reasoning: true,
  }));

  expect(model.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "medium", "high", "max"] },
  ]);
});

test("does not advertise controls for non-reasoning models", () => {
  const model = buildRequestyModel(RequestyModel.parse({
    id: "requesty-non-reasoning-model",
    created: Date.parse("2026-09-01") / 1_000,
    description: "Non-reasoning model",
    context_window: 200_000,
    max_output_tokens: 16_000,
  }));

  expect(model.reasoning_options).toBeUndefined();
});

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

test("keeps a hand-linked base_model and curated status", () => {
  const model = buildRequestyModel(RequestyModel.parse({
    id: "nvidia-nemotron-3-super-120b-a12b",
    created: Date.parse("2026-03-11") / 1_000,
    description: "Requesty description",
    context_window: 262_144,
    max_output_tokens: 262_144,
    supports_reasoning: true,
    supports_tool_calling: true,
    input_price: 0.0000001,
    output_price: 0.0000005,
  }), { base_model: "nvidia/nemotron-3-super-120b-a12b", status: "deprecated" });

  expect(resolveRequestyBaseModel("nvidia-nemotron-3-super-120b-a12b")).toBeUndefined();
  expect(JSON.parse(JSON.stringify(model))).toEqual({
    base_model: "nvidia/nemotron-3-super-120b-a12b",
    structured_output: false,
    status: "deprecated",
    reasoning_options: [
      { type: "effort", values: ["none", "low", "medium", "high", "max"] },
    ],
    cost: { input: 0.1, output: 0.5 },
  });
});

test("routes without a catalog output limit inherit the lab's", () => {
  const resolved = buildRequestyModel(RequestyModel.parse({
    id: "qwen3.5-27b",
    created: Date.parse("2026-02-24") / 1_000,
    description: "Requesty description",
    context_window: 262_144,
    max_output_tokens: 0,
    input_price: 0.0000003,
    output_price: 0.0000024,
  }));
  expect(resolveRequestyBaseModel("qwen3.5-27b")).toBe("alibaba/qwen3.5-27b");
  expect(resolved).not.toHaveProperty("limit");

  // The lab's output exceeds the served context: keep the context as the cap.
  const capped = buildRequestyModel(RequestyModel.parse({
    id: "mistral-medium-latest",
    created: Date.parse("2026-01-01") / 1_000,
    description: "Requesty description",
    context_window: 131_072,
    max_output_tokens: 0,
    input_price: 0.0000004,
    output_price: 0.000002,
  }));
  expect(capped).toMatchObject({ limit: { context: 131_072, output: 131_072 } });

  const model = buildRequestyModel(RequestyModel.parse({
    id: "seed-1.8",
    created: Date.parse("2026-05-27") / 1_000,
    description: "Requesty description",
    context_window: 256_000,
    max_output_tokens: 0,
    supports_vision: true,
    supports_reasoning: true,
    supports_tool_calling: true,
    input_price: 0.00000025,
    output_price: 0.000002,
  }), { base_model: "bytedance-seed/seed-1-8" });

  expect(resolveRequestyBaseModel("seed-1.8")).toBeUndefined();
  expect(model).not.toHaveProperty("limit");
});

test("hand-linked routes keep a curated display name", () => {
  const model = buildRequestyModel(RequestyModel.parse({
    id: "inkling-256k",
    created: Date.parse("2026-07-16") / 1_000,
    description: "Requesty description",
    context_window: 262_144,
    max_output_tokens: 32_768,
    supports_vision: true,
    input_price: 0.00000187,
    output_price: 0.00000468,
  }), { base_model: "thinkingmachines/inkling", name: "Inkling 256K" });

  expect(resolveRequestyBaseModel("inkling-256k")).toBeUndefined();
  expect(model).toMatchObject({ base_model: "thinkingmachines/inkling", name: "Inkling 256K" });
});
