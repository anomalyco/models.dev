import { expect, test } from "bun:test";

import { buildAiandModel, type AiandModel } from "../src/sync/providers/aiand.js";

function aiandModel(overrides: Partial<AiandModel> = {}): AiandModel {
  return {
    id: "zai-org/glm-5.2",
    object: "model",
    name: "zai-org/glm-5.2",
    owned_by: "ai&",
    provider: "zai-org",
    context_window: 1_048_576,
    capabilities: ["reasoning", "tool_calling"],
    description: "Zhipu GLM 5.2",
    currency: "usd",
    input_per_1m: "1.000000",
    output_per_1m: "4.000000",
    created: 1_780_963_200,
    ...overrides,
  };
}

test("syncs ai& pricing and context from the OpenAI-shaped models endpoint", () => {
  const model = buildAiandModel(aiandModel(), undefined);

  expect(model).toMatchObject({
    base_model: "zhipuai/glm-5.2",
    cost: { input: 1, output: 4 },
    limit: { context: 1_048_576 },
  });
  expect("name" in model).toBe(false);
  expect("reasoning_options" in model).toBe(false);
});

test("preserves authored ai& limits and reasoning options but refreshes modalities from API", () => {
  const model = buildAiandModel(aiandModel({ context_window: 999_000 }), {
    base_model: "zhipuai/glm-5.2",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    cost: { input: 0.5, output: 2 },
    limit: { context: 1_048_576, output: 131_072 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    attachment: true,
  });

  expect(model).toMatchObject({
    base_model: "zhipuai/glm-5.2",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    limit: { context: 999_000 },
  });
});

test("maps ai& capabilities to modalities and attachment", () => {
  const model = buildAiandModel(aiandModel({
    id: "google/gemma-4-31b-it",
    provider: "google",
    capabilities: ["reasoning", "tool_calling", "vision", "document"],
  }), undefined);

  expect(model).toMatchObject({
    base_model: "google/gemma-4-31b-it",
    cost: { input: 1, output: 4 },
    limit: { context: 1_048_576 },
  });
  expect("name" in model).toBe(false);
  expect("attachment" in model).toBe(false);
});

test("overwrites authored modalities with API capabilities", () => {
  const model = buildAiandModel(aiandModel({
    id: "moonshotai/kimi-k2.7-code",
    provider: "moonshotai",
    capabilities: ["reasoning", "tool_calling"],
  }), {
    name: "Kimi K2.7 Code",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: true,
    reasoning: true,
    tool_call: true,
    open_weights: false,
    cost: { input: 0.75, output: 3.5 },
    limit: { context: 262_144, output: 262_144 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });

  expect(model).toMatchObject({
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  });
});

test("overwrites authored pricing with API pricing", () => {
  const existing = {
    name: "Qwen3.6 27B",
    description: "Existing model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort" as const, values: ["low", "medium", "high"] }],
    tool_call: true,
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 262_144, output: 65_536 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const model = buildAiandModel(aiandModel({
    id: "qwen/qwen3.6-27b",
    provider: "qwen",
    input_per_1m: "0.320000",
    output_per_1m: "3.200000",
  }), existing);

  expect(model).toMatchObject({ cost: { input: 0.32, output: 3.2 } });
});

test("ignores ai& prices when currency is not USD", () => {
  const existing = {
    name: "GLM 5.2",
    description: "Existing model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] } as const],
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 4 },
    limit: { context: 1_048_576, output: 131_072 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const model = buildAiandModel(aiandModel({ currency: "jpy" }), existing);

  expect(model).toMatchObject({ cost: { input: 1, output: 4 } });
});

test("builds best-effort ai& model when no canonical metadata exists", () => {
  const model = buildAiandModel(aiandModel({
    id: "custom-org/custom-model",
    provider: "custom-org",
    capabilities: ["tool_calling"],
  }), undefined);

  expect(model).toMatchObject({
    name: "Custom Model",
    reasoning: false,
    reasoning_options: undefined,
    tool_call: true,
    attachment: false,
    limit: { context: 1_048_576 },
  });
});
