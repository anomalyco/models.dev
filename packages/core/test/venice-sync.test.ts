import { expect, test } from "bun:test";

import {
  buildVeniceModel,
  resolveVeniceBaseModel,
  VeniceResponse,
  type VeniceModel,
} from "../src/sync/providers/venice.js";

const catalogModel: VeniceModel = {
  id: "openai-gpt-54",
  created: 1_772_668_800,
  model_spec: {
    name: "GPT-5.4",
    availableContextTokens: 400_000,
    maxCompletionTokens: 128_000,
    modelSource: "OpenAI",
    capabilities: {
      supportsVision: true,
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffortOptions: ["none", "low", "medium", "high"],
      supportsFunctionCalling: true,
      supportsResponseSchema: true,
    },
    pricing: {
      input: { usd: 3.13 },
      output: { usd: 18.75 },
      cache_input: { usd: 0.313 },
      extended: {
        context_token_threshold: 200_000,
        input: { usd: 6.26 },
        output: { usd: 28.125 },
      },
    },
  },
};

test("Venice resolves flattened IDs to canonical metadata", () => {
  expect(resolveVeniceBaseModel("openai-gpt-54", "GPT-5.4")).toBe("openai/gpt-5.4");
});

test("Venice maps API fields and keeps inherited models compact", () => {
  const synced = buildVeniceModel(catalogModel, {
    base_model: "openai/gpt-5.4",
    name: "GPT-5.4",
    family: "gpt",
    release_date: "2026-03-05",
    last_updated: "2026-03-09",
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: true,
    open_weights: false,
    interleaved: { field: "reasoning_content" },
    cost: { input: 3, output: 18, input_audio: 4 },
    limit: { context: 400_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  }, "openai/gpt-5.4", "2026-06-10");

  expect(synced).toMatchObject({
    base_model: "openai/gpt-5.4",
    base_model_omit: ["limit.input"],
    last_updated: "2026-06-10",
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
    interleaved: { field: "reasoning_content" },
    cost: {
      input: 3.13,
      output: 18.75,
      cache_read: 0.313,
      input_audio: 4,
      tiers: [{ tier: { type: "context", size: 200_000 }, input: 6.26, output: 28.125 }],
    },
  });
  expect(synced).not.toHaveProperty("family");
  expect(synced).not.toHaveProperty("release_date");
  expect(synced).not.toHaveProperty("open_weights");
  expect(synced).not.toHaveProperty("modalities");
});

test("Venice preserves last_updated when authoritative data is unchanged", () => {
  const providerModel = {
    ...catalogModel,
    id: "venice-only-test-model",
    model_spec: { ...catalogModel.model_spec, name: "Venice Only Test Model" },
  };
  const full = buildVeniceModel(providerModel, undefined, undefined, "2026-06-10");
  if ("base_model" in full) throw new Error("Expected a full provider model fixture");
  const synced = buildVeniceModel(providerModel, full, undefined, "2026-06-11");

  expect(synced).toMatchObject({ last_updated: "2026-06-10" });
});

test("Venice rejects malformed responses", () => {
  expect(() => VeniceResponse.parse({ data: [{ id: "broken" }] })).toThrow();
});
