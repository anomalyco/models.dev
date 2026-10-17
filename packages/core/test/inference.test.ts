import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import { buildInferenceModel, labModelID, type InferenceModel } from "../src/sync/providers/inference.js";

function inferenceModel(overrides: Partial<InferenceModel> = {}): InferenceModel {
  return {
    id: "glm-5.3",
    object: "model",
    context_length: 1_048_576,
    max_completion_tokens: 943_718,
    reasoning_efforts: ["low", "high", "max"],
    pricing: { prompt: "0.000000900000", completion: "0.000003000000", input_cache_read: "0.000000150000" },
    ...overrides,
  };
}

const base = (id: string) => ({ base_model: id }) as ExistingModel;

test("maps unprefixed and namespaced IDs to lab entries", () => {
  expect(labModelID("claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
  expect(labModelID("qwen3.7-plus")).toBe("alibaba/qwen3.7-plus");
  expect(labModelID("z-ai/glm-5.3-fast")).toBe("zhipuai/glm-5.3-fast");
  expect(labModelID("moonshotai/kimi-k3")).toBe("moonshotai/kimi-k3");
});

test("converts per-token prices and maps reasoning_efforts to one effort option", () => {
  expect(buildInferenceModel(inferenceModel(), base("zhipuai/glm-5.3"))).toMatchObject({
    cost: { input: 0.9, output: 3, cache_read: 0.15 },
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  });
});

test("caps the output limit at the context window", () => {
  const built = buildInferenceModel(
    inferenceModel({ context_length: 65_536 }),
    base("zhipuai/glm-5.3"),
  );

  expect(built).toMatchObject({ limit: { context: 65_536, output: 65_536 } });
});

test("refuses a reasoning model the endpoint lists no efforts for", () => {
  expect(() =>
    buildInferenceModel(inferenceModel({ id: "deepseek-v3.2", reasoning_efforts: undefined }), base("deepseek/deepseek-v3.2"))
  ).toThrow(MissingReasoningOptionsError);
});
