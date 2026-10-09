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

test("mirrors the same-surface peer's controls, including an affirmative []", () => {
  // OpenRouter authors a thinking toggle for these models and an explicit
  // reasoning_options = [] (no caller control) for the second group; both are
  // copied as-is rather than falling through to lab controls.
  for (const [id, provider] of [
    ["nvidia-nemotron-3-nano-30b-a3b", "NVIDIA"],
    ["minimax-m3", "MiniMax"],
  ] as const) {
    const built = buildSurplusModel(surplusModel({ id, provider }), undefined);
    expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
  }
  for (const [id, provider] of [
    ["minimax-m2.7", "MiniMax"],
    ["kimi-k2-thinking", "Moonshot"],
  ] as const) {
    const built = buildSurplusModel(surplusModel({ id, provider }), undefined);
    expect(built.reasoning_options).toEqual([]);
  }
});

test("live-probed routes keep no caller control despite peer toggles", () => {
  // Live probes (2026-09-23) showed these routes' sellers ignoring
  // reasoning.enabled=false (or never reasoning at all), so the tested []
  // wins over the OpenRouter toggle and the catalog's advertised params.
  for (const [id, provider] of [
    ["kimi-k2.6", "Moonshot"],
    ["glm-4.7", "Zhipu AI"],
    ["glm-5.1", "Zhipu AI"],
    ["glm-5.1-non-thinking", "Zhipu AI"],
  ] as const) {
    const built = buildSurplusModel(
      surplusModel({
        id,
        provider,
        supported_parameters: ["temperature", "reasoning", "include_reasoning"],
        supported_features: ["streaming", "reasoning", "tools"],
      }),
      undefined,
    );
    expect(built.reasoning_options).toEqual([]);
  }
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
  // The parent canonical zhipuai/glm-4.7-flash's OpenRouter peer authors a
  // thinking toggle, so the heretic finetune inherits exactly that.
  const built = buildSurplusModel(
    surplusModel({
      id: "glm-4.7-flash-heretic",
      provider: "Zhipu AI",
      supported_parameters: ["temperature", "reasoning", "include_reasoning"],
      supported_features: ["streaming", "reasoning"],
    }),
    undefined,
  );
  expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
});

test("a placeholder parameter list does not strip lab capabilities", () => {
  // The catalog gives routes it knows little about exactly
  // max_tokens/temperature/top_p/stop; that is not evidence the seller
  // lacks tools or structured outputs.
  const built = buildSurplusModel(
    surplusModel({ id: "e2ee-gpt-oss-120b-p", provider: "OpenAI", supported_features: ["streaming", "reasoning"] }),
    undefined,
  );
  expect(built.tool_call).toBeUndefined();
  expect(built.structured_output).toBeUndefined();
});

test("a relay never adds temperature support the lab model lacks", () => {
  const built = buildSurplusModel(
    surplusModel({
      id: "claude-sonnet-5",
      provider: "Anthropic",
      supported_parameters: ["max_tokens", "temperature", "tools", "structured_outputs", "reasoning"],
      supported_features: ["streaming", "tools", "reasoning"],
    }),
    undefined,
  );
  expect(built.temperature).toBeUndefined();
});

test("a stale mirrored copy is replaced by the peer's current controls", () => {
  const built = buildSurplusModel(
    surplusModel({ id: "claude-opus-4.5", provider: "Anthropic" }),
    {
      base_model: "anthropic/claude-opus-4-5",
      reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1_024, max: 63_999 }],
    },
  );
  expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
});

test("routes whose off-switch was honored in probes mirror the peer", () => {
  // The :web routes (seller: morpheus) returned zero reasoning with
  // reasoning.enabled=false, so they keep the OpenRouter toggle.
  const built = buildSurplusModel(surplusModel({ id: "glm-5.1-non-thinking:web", provider: "Zhipu AI" }), undefined);
  expect(built.reasoning_options).toEqual([{ type: "toggle" }]);
});
