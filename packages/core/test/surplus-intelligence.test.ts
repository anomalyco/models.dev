import { expect, test } from "bun:test";

import {
  buildSurplusModel,
  firstPartyReasoningOptions,
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
  // missed both.
  expect(firstPartyReasoningOptions("nvidia/nemotron-nano-9b-v2")).toEqual([{ type: "toggle" }]);
  expect(firstPartyReasoningOptions("nvidia/nemotron-3-nano-30b-a3b")).toEqual([{ type: "toggle" }]);
});

test("a peer's affirmative [] wins when the host advertises no reasoning control", () => {
  // OpenRouter authors reasoning_options = [] for these models and Surplus's
  // own catalog lists no reasoning params for the routes, so "no caller
  // control" is the agreed answer even though the lab entries carry toggles.
  for (const [id, provider] of [
    ["nvidia-nemotron-3-nano-30b-a3b", "NVIDIA"],
    ["nvidia-nemotron-nano-9b-v2", "NVIDIA"],
    ["minimax-m3", "MiniMax"],
  ] as const) {
    const built = buildSurplusModel(surplusModel({ id, provider }), undefined);
    expect(built.reasoning_options).toEqual([]);
  }
});

test("a peer's affirmative [] wins even when the host advertises reasoning params", () => {
  // Live probes (2026-08-23) showed routes that advertise reasoning params
  // still ignore both OpenRouter-style and lab-native controls (kimi-k2.6
  // returned no reasoning at all; glm-4.7 ignored both off-switches), so the
  // OpenRouter peer's [] is authoritative despite the advertised params.
  const built = buildSurplusModel(
    surplusModel({
      id: "kimi-k2.6",
      provider: "Moonshot",
      supported_parameters: ["temperature", "reasoning", "include_reasoning"],
      supported_features: ["streaming", "reasoning", "tools"],
    }),
    undefined,
  );
  expect(built.reasoning_options).toEqual([]);
});

test("live-probed inline route overrides win over catalog signals", () => {
  // e2ee-qwen3-6-35b-a3b-uncensored-p returned reasoning content on every
  // probe (both off-switches ignored) although the catalog marks it
  // non-reasoning; the allowlist entry pins reasoning = true with [].
  const built = buildSurplusModel(
    surplusModel({ id: "e2ee-qwen3-6-35b-a3b-uncensored-p", provider: "Alibaba" }),
    undefined,
  );
  expect(built.reasoning).toBe(true);
  expect(built.reasoning_options).toEqual([]);
});

test("an authored empty reasoning_options does not shadow peer controls", () => {
  const built = buildSurplusModel(
    surplusModel({ id: "qwen3.5-plus", provider: "Alibaba Cloud" }),
    { base_model: "alibaba/qwen3.5-plus", reasoning_options: [] },
  );
  expect(built.reasoning_options?.length).toBeGreaterThan(0);
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
  // The parent canonical zhipuai/glm-4.7-flash's OpenRouter peer authors []
  // (no caller control), so the heretic finetune inherits exactly that.
  const built = buildSurplusModel(
    surplusModel({
      id: "glm-4.7-flash-heretic",
      provider: "Zhipu AI",
      supported_parameters: ["temperature", "reasoning", "include_reasoning"],
      supported_features: ["streaming", "reasoning"],
    }),
    undefined,
  );
  expect(built.reasoning_options).toEqual([]);
});
