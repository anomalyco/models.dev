import { expect, test } from "bun:test";

import { formatToml, preserveReasoningOptions } from "../src/sync/index.js";
import { buildOpenRouterModel, type OpenRouterModel } from "../src/sync/providers/openrouter.js";

test("formats interleaved as a root field before reasoning option tables", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("formats empty reasoning options outside the interleaved table", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: { field: "reasoning_content" },
    reasoning_options: [],
  });
});

test("formats reasoning efforts from lowest to highest", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{
      type: "effort",
      values: ["max", "xhigh", "high", "medium", "low", "minimal", "none", "default"],
    }],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(content).toContain(
    'values = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]',
  );
});

test("defaults new reasoning models to empty reasoning options", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined)).toEqual({
    reasoning: true,
    reasoning_options: [],
  });
});

test("syncs OpenRouter reasoning efforts from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), undefined);

  expect(model).toMatchObject({
    base_model: "anthropic/claude-sonnet-5",
    reasoning_options: [
      { type: "effort", values: ["max", "xhigh", "high", "medium", "low"] },
    ],
  });
});

test("preserves authored OpenRouter reasoning options over model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [{ type: "toggle" }],
  });
});

test("upgrades empty OpenRouter reasoning options from model metadata", () => {
  const model = buildOpenRouterModel(openRouterModel({
    reasoning: {
      mandatory: false,
      supported_efforts: ["high", "medium", "low"],
    },
  }), {
    name: "Claude Sonnet 5",
    release_date: "2026-06-30",
    last_updated: "2026-06-30",
    attachment: true,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    open_weights: false,
    cost: { input: 2, output: 10 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    reasoning_options: [
      { type: "effort", values: ["high", "medium", "low"] },
    ],
  });
});

function openRouterModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    created: 1_782_777_600,
    hugging_face_id: null,
    knowledge_cutoff: "2026-01-31",
    context_length: 1_000_000,
    architecture: {
      input_modalities: ["text", "image", "file"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
    },
    top_provider: {
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
    },
    supported_parameters: ["include_reasoning", "reasoning", "structured_outputs", "tools"],
    ...overrides,
  };
}
