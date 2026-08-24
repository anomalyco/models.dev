import { expect, test } from "bun:test";

import {
  buildSurplusModel,
  resolveSurplusBaseModel,
  SurplusModel,
} from "../src/sync/providers/surplus-intelligence.js";

function surplusModel(overrides: Record<string, unknown>): SurplusModel {
  return SurplusModel.parse({
    id: "test-model",
    name: "Test Model",
    created: 1735689600,
    context_length: 128_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
    supported_parameters: ["max_tokens", "temperature", "top_p", "stop"],
    supported_features: ["streaming"],
    ...overrides,
  });
}

test("resolves lab-prefixed, dotted, and wrapped IDs without per-model entries", () => {
  expect(resolveSurplusBaseModel(surplusModel({ id: "openai-gpt-oss-120b", provider: "OpenAI" }))).toBe(
    "openai/gpt-oss-120b",
  );
  expect(resolveSurplusBaseModel(surplusModel({ id: "nvidia-nemotron-nano-9b-v2", provider: "NVIDIA" }))).toBe(
    "nvidia/nemotron-nano-9b-v2",
  );
  expect(resolveSurplusBaseModel(surplusModel({ id: "qwen3-5-9b", provider: "Alibaba" }))).toBe(
    "alibaba/qwen3.5-9b",
  );
  expect(resolveSurplusBaseModel(surplusModel({ id: "e2ee-glm-4.7-p", provider: "Zhipu AI" }))).toBe(
    "zhipuai/glm-4.7",
  );
  expect(resolveSurplusBaseModel(surplusModel({ id: "kimi-k2.6:web", provider: "Moonshot" }))).toBe(
    "moonshotai/kimi-k2.6",
  );
});

test("keeps true filename aliases in the override map", () => {
  expect(resolveSurplusBaseModel(surplusModel({ id: "grok-build-0-1", provider: "xAI" }))).toBe(
    "xai/grok-build-0.1",
  );
  expect(resolveSurplusBaseModel(surplusModel({ id: "mistral-small-4", provider: "Mistral AI" }))).toBe(
    "mistral/mistral-small-2603",
  );
});

test("does not invent canonical metadata for marketplace-only routes", () => {
  expect(resolveSurplusBaseModel(surplusModel({ id: "gemma-4-uncensored", provider: "Google" }))).toBeUndefined();
  expect(resolveSurplusBaseModel(surplusModel({ id: "venice-uncensored-1.2", provider: "Venice AI" }))).toBeUndefined();
});

test("finds first-party reasoning controls in NVIDIA's nested provider layout", () => {
  // Regression: providers/nvidia/models nests per-org subdirectories and
  // sometimes repeats the lab name in the filename; a flat path lookup
  // missed both and every NVIDIA reasoner degraded to [].
  for (const id of ["nvidia-nemotron-nano-9b-v2", "nvidia-nemotron-3-nano-30b-a3b"]) {
    const built = buildSurplusModel(surplusModel({ id, provider: "NVIDIA" }), undefined);
    expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
  }
});

test("an authored empty reasoning_options does not shadow peer controls", () => {
  const built = buildSurplusModel(surplusModel({ id: "nvidia-nemotron-nano-9b-v2", provider: "NVIDIA" }), {
    base_model: "nvidia/nemotron-nano-9b-v2",
    reasoning_options: [],
  });
  expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
});

test("lab identity decides reasoning for canonical models", () => {
  // Surplus blanket-lists reasoning params on the non-reasoning instruct
  // checkpoint; the factored file must inherit lab reasoning = false.
  const built = buildSurplusModel(
    surplusModel({
      id: "qwen3-235b-a22b-2507",
      provider: "Alibaba",
      supported_parameters: ["temperature", "reasoning", "include_reasoning", "reasoning_effort"],
      supported_features: ["streaming", "tools"],
    }),
    undefined,
  );
  expect("base_model" in built && built.base_model).toBe("alibaba/qwen3-235b-a22b-instruct-2507");
  expect(built.reasoning).toBeUndefined();
  expect(built.reasoning_options).toBeUndefined();
});

test("marketplace finetunes inherit the parent route's reasoning controls", () => {
  const built = buildSurplusModel(
    surplusModel({
      id: "glm-4.7-flash-heretic",
      provider: "Zhipu AI",
      supported_features: ["streaming", "reasoning"],
    }),
    undefined,
  );
  expect(built.reasoning_options?.some((option) => option.type === "toggle")).toBe(true);
});
