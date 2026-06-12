import { expect, test } from "bun:test";

import {
  buildRodiumVendorModel,
  isCodingApiModel,
  resolveRodiumBaseModel,
  rodiumai,
  RodiumResponse,
  type RodiumApiModel,
} from "../src/sync/providers/rodiumai.js";

const vendorModel: RodiumApiModel = {
  id: "anthropic/claude-sonnet-4-6",
  created: 1_773_888_000,
  rodiumai_display_name: "Claude Sonnet 4.6",
  rodiumai_capabilities: {
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    input_modalities: ["text", "image", "document"],
    output_modalities: ["text"],
    supports_tools: true,
    supports_vision: true,
    supports_json_mode: true,
    supports_reasoning: true,
  },
  rodiumai_pricing: {
    pricing_unit: "per_million_tokens",
    per_image: null,
  },
};

test("RodiumAi resolves canonical base_model metadata", () => {
  expect(resolveRodiumBaseModel("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  expect(resolveRodiumBaseModel("moonshot-ai/kimi-k2.5")).toBe("moonshotai/kimi-k2.5");
  expect(resolveRodiumBaseModel("meta/llama-4-maverick-17b-128e"))
    .toBe("meta/llama-4-maverick-17b-instruct");
});

test("RodiumAi filters non-coding models", () => {
  expect(isCodingApiModel(vendorModel)).toBe(true);
  expect(isCodingApiModel({
    ...vendorModel,
    id: "openai/text-embedding-3-large",
    rodiumai_capabilities: {
      output_modalities: ["text"],
      supports_tools: false,
    },
  })).toBe(false);
  expect(isCodingApiModel({
    ...vendorModel,
    id: "google/veo-3.1-generate-preview",
    rodiumai_capabilities: {
      output_modalities: ["video"],
      supports_tools: true,
    },
  })).toBe(false);
});

test("RodiumAi vendor models inherit anthropic reasoning_options from direct provider", () => {
  const synced = buildRodiumVendorModel(vendorModel, {
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    limit: { context: 1_000_000, output: 64_000 },
  }, "2026-06-12");

  expect(synced).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-6",
    reasoning_options: [
      { type: "effort", values: ["low", "medium", "high", "max"] },
      { type: "budget_tokens", min: 1024 },
    ],
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  });
  expect(synced).not.toHaveProperty("family");
  expect(synced).not.toHaveProperty("reasoning");
});

test("RodiumAi skips models without tools support", () => {
  const parsed = rodiumai.parseModels({
    data: [
      vendorModel,
      {
        ...vendorModel,
        id: "google/gemini-embedding-001",
        rodiumai_capabilities: {
          output_modalities: ["text"],
          supports_tools: false,
        },
      },
    ],
  });

  expect(parsed.some((model) => "id" in model && model.id === "google/gemini-embedding-001")).toBe(false);
});

test("RodiumAi rejects malformed responses", () => {
  expect(() => RodiumResponse.parse({ data: [{ id: "broken" }] })).toThrow();
});
