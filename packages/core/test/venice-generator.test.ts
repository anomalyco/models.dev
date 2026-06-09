import { expect, test } from "bun:test";

import {
  detectChanges,
  formatToml,
  mergeModel,
  REASONING_OVERRIDES,
} from "../script/generate-venice.js";

type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const options = (...values: Effort[]) => [{ type: "effort" as const, values }];

function model(id: string, capabilities: Record<string, unknown>) {
  return {
    created: 1_700_000_000,
    id,
    model_spec: {
      availableContextTokens: 128_000,
      maxCompletionTokens: 32_000,
      capabilities: { supportsReasoning: true, ...capabilities },
      name: "Test Model",
    },
    object: "model",
    owned_by: "venice.ai",
    type: "text",
  };
}

test("curated options survive false and stale Venice catalog metadata", () => {
  const claude = options("low", "medium", "high", "max");
  const codex = options("low", "medium", "high", "xhigh");
  const discrepancies: string[] = [];

  expect(mergeModel(model("claude-opus-4-7", {
    supportsReasoningEffort: false,
  }), { reasoning_options: claude }, discrepancies.push.bind(discrepancies)).reasoning_options).toEqual(claude);
  expect(mergeModel(model("openai-gpt-56-codex", {
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["none", "low"],
  }), { reasoning_options: codex }, discrepancies.push.bind(discrepancies)).reasoning_options).toEqual(codex);
  expect(discrepancies).toHaveLength(2);
});

test("documented override beats stale curated and catalog options", () => {
  const discrepancies: string[] = [];
  const merged = mergeModel(model("openai-gpt-52", {
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["minimal", "low", "high"],
  }), { reasoning_options: options("low", "high") }, discrepancies.push.bind(discrepancies));

  expect(merged.reasoning_options).toEqual(options("none", "low", "medium", "high", "xhigh"));
  expect(discrepancies).toHaveLength(2);
});

test("catalog fills only an uncurated new model", () => {
  const merged = mergeModel(model("new-reasoner", {
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["low", "high"],
  }), null);

  expect(merged.reasoning_options).toEqual(options("low", "high"));
});

test("catalog does not fill an unresolved existing model", () => {
  const existing = { reasoning: true };
  const merged = mergeModel(model("existing-unresolved-reasoner", {
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["low", "high"],
  }), existing);

  expect(merged.reasoning_options).toBeUndefined();
  expect(detectChanges(existing, merged).find((change) => change.field === "reasoning_options")).toBeUndefined();
});

test("catalog false without curated evidence leaves options undefined", () => {
  const merged = mergeModel(model("unknown-fixed-reasoner", {
    supportsReasoningEffort: false,
  }), null);

  expect(merged.reasoning_options).toBeUndefined();
  expect(formatToml(merged)).not.toContain("reasoning_options");
});

test("explicit curated empty options remain stable", () => {
  const existing = { reasoning_options: [] };
  const merged = mergeModel(model("curated-fixed-reasoner", {
    supportsReasoningEffort: false,
  }), existing);

  expect(merged.reasoning_options).toEqual([]);
  expect(detectChanges({ ...existing, reasoning: true }, merged).find((change) => change.field === "reasoning_options")).toBeUndefined();
  expect(formatToml(merged)).toContain("reasoning = true\nreasoning_options = []");
});

test("formatter emits nonempty options using model TOML convention", () => {
  const merged = mergeModel(model("new-reasoner", {
    supportsReasoningEffort: true,
    reasoningEffortOptions: ["none", "high"],
  }), null);

  expect(formatToml(merged)).toContain(
    '[[reasoning_options]]\ntype = "effort"\nvalues = ["none", "high"]',
  );
});

test("official correction fixtures remain exact", () => {
  const expected = {
    "claude-opus-4-6": options("low", "medium", "high", "max"),
    "openai-gpt-52": options("none", "low", "medium", "high", "xhigh"),
    "openai-gpt-52-codex": options("low", "medium", "high", "xhigh"),
    "openai-gpt-54-pro": options("medium", "high", "xhigh"),
    "gemini-3-flash-preview": options("minimal", "low", "medium", "high"),
    "kimi-k2-5": options("low", "medium", "high"),
    "qwen3-5-35b-a3b": options("low", "medium", "high"),
    "zai-org-glm-5-1": [],
  };

  for (const [id, reasoningOptions] of Object.entries(expected)) {
    expect(REASONING_OVERRIDES[id]).toEqual(reasoningOptions);
  }
});
