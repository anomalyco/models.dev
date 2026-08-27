import { expect, test } from "bun:test";

import { buildEmpiriolabsModel, resolveEmpiriolabsBaseModel } from "../src/sync/providers/empiriolabs.js";

test.each([
  {
    name: "toggle-only",
    parameters: [{ name: "enable_thinking" }],
    expected: [{ type: "toggle" }],
  },
  {
    name: "toggle and effort without none",
    parameters: [
      { name: "enable_thinking" },
      { name: "reasoning_effort", options: ["low", "high"] },
    ],
    expected: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
  },
  {
    name: "effort with none instead of a redundant toggle",
    parameters: [
      { name: "enable_thinking" },
      { name: "reasoning_effort", options: ["none", "low", "high"] },
    ],
    expected: [{ type: "effort", values: ["none", "low", "high"] }],
  },
  {
    name: "effort with none preserves the reasoning budget",
    parameters: [
      { name: "enable_thinking" },
      { name: "reasoning_effort", options: ["none", "low", "high"] },
      { name: "thinking_budget", min: 1_024, max: 32_768 },
    ],
    expected: [
      { type: "effort", values: ["none", "low", "high"] },
      { type: "budget_tokens", min: 1_024, max: 32_768 },
    ],
  },
])("syncs EmpirioLabs reasoning controls: $name", ({ parameters, expected }) => {
  const model = buildEmpiriolabsModel({
    id: "qwen3-5-9b",
    context_length: 262_144,
    capabilities: { reasoning: true },
    supported_parameters: parameters,
  }, undefined);

  expect(model?.reasoning_options).toEqual(expected);
});

test("resolves existing lab metadata without a hardcoded map", () => {
  expect(resolveEmpiriolabsBaseModel("muse-glimmer-30b")).toBe("meta/muse-glimmer-30b");
  expect(resolveEmpiriolabsBaseModel("muse-spark-1-2")).toBe("meta/muse-spark-1.2");
  expect(resolveEmpiriolabsBaseModel("muse-spark-1-1")).toBe("meta/muse-spark-1.1");
  expect(resolveEmpiriolabsBaseModel("seed-2-1-turbo")).toBe("bytedance-seed/seed-2.1-turbo");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-code")).toBe("bytedance-seed/seed-2.0-code");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-lite")).toBe("bytedance-seed/seed-2.0-lite");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-mini")).toBe("bytedance-seed/seed-2.0-mini");
  expect(resolveEmpiriolabsBaseModel("seed-2-0-pro")).toBe("bytedance-seed/seed-2.0-pro");
  expect(resolveEmpiriolabsBaseModel("qwen3-8-max")).toBe("alibaba/qwen3.8-max");
});

test("maps versioned slugs onto the undated canonical when needed", () => {
  expect(resolveEmpiriolabsBaseModel("fugu-ultra-v1-1")).toBe("sakana/fugu-ultra");
  expect(resolveEmpiriolabsBaseModel("fugu-ultra-v1-0")).toBe("sakana/fugu-ultra");
});

test("keeps true filename aliases", () => {
  expect(resolveEmpiriolabsBaseModel("mistral-medium-3")).toBe("mistral/mistral-medium-2505");
  expect(resolveEmpiriolabsBaseModel("mistral-small-4")).toBe("mistral/mistral-small-2603");
});

test("resolves a non-alias Mistral id through the mistralai prefix", () => {
  expect(resolveEmpiriolabsBaseModel("mistral-small-2603")).toBe("mistral/mistral-small-2603");
});

test("does not invent lab metadata when none exists", () => {
  expect(resolveEmpiriolabsBaseModel("deepreasoning")).toBeUndefined();
  expect(resolveEmpiriolabsBaseModel("nova-pro-1-0")).toBeUndefined();
});
