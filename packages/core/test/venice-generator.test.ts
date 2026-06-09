import { expect, test } from "bun:test";

import { detectChanges, formatToml, mergeModel } from "../script/generate-venice.js";

function model(capabilities: Record<string, unknown>) {
  return {
    created: 1_700_000_000,
    id: "test-model",
    model_spec: {
      availableContextTokens: 128_000,
      maxCompletionTokens: 32_000,
      capabilities,
      name: "Test Model",
    },
    object: "model",
    owned_by: "venice.ai",
    type: "text",
  };
}

test("Venice generator maps and formats reasoning effort options", () => {
  const merged = mergeModel(model({
    supportsReasoning: true,
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["none", "low", "high"],
    defaultReasoningEffort: "low",
  }), null);

  expect(merged.reasoning_options).toEqual([
    { type: "effort", values: ["none", "low", "high"] },
  ]);
  expect(formatToml(merged)).toContain(
    '[[reasoning_options]]\ntype = "effort"\nvalues = ["none", "low", "high"]',
  );
  expect(detectChanges({
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  }, merged)).toContainEqual({
    field: "reasoning_options",
    oldValue: '[{"type":"effort","values":["low","high"]}]',
    newValue: '[{"type":"effort","values":["none","low","high"]}]',
  });
});

test("Venice generator distinguishes fixed and non-reasoning models", () => {
  const fixed = mergeModel(model({
    supportsReasoning: true,
    supportsReasoningEffort: false,
  }), null);
  const nonReasoning = mergeModel(model({
    supportsReasoning: false,
    supportsReasoningEffort: false,
  }), null);

  expect(fixed.reasoning_options).toEqual([]);
  expect(formatToml(fixed)).toContain("reasoning = true\nreasoning_options = []");
  expect(nonReasoning.reasoning_options).toBeUndefined();
  expect(formatToml(nonReasoning)).not.toContain("reasoning_options");
});
