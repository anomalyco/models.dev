import { expect, test } from "bun:test";

import { buildEmpiriolabsModel, empiriolabs, resolveEmpiriolabsBaseModel } from "../src/sync/providers/empiriolabs.js";

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

test("keeps model facts off base_model files", () => {
  const model = buildEmpiriolabsModel({
    id: "kimi-k2-6",
    context_length: 256_000,
    model_released_at: "2026-06-12",
    capabilities: { reasoning: true },
  }, {
    base_model: "moonshotai/kimi-k2.6",
    last_updated: "2026-06-12",
    family: "kimi",
    knowledge: "2020-01",
    open_weights: false,
  });

  expect(model).toMatchObject({ base_model: "moonshotai/kimi-k2.6" });
  for (const key of ["release_date", "last_updated", "family", "knowledge", "open_weights"]) {
    expect(model).not.toHaveProperty(key);
  }
});

test("syncs structured output, deprecation and effort order from the catalog", () => {
  const model = buildEmpiriolabsModel({
    id: "minimax-m3",
    context_length: 1_000_000,
    structured_output: "none",
    deprecated: true,
    capabilities: { reasoning: true },
    supported_parameters: [{ name: "reasoning_effort", options: ["high", "none", "low"] }],
  }, { base_model: "minimax/MiniMax-M3", structured_output: true });
  const jsonMode = buildEmpiriolabsModel({
    id: "glm-5-2",
    context_length: 1_000_000,
    structured_output: "json_object",
  }, { base_model: "zhipuai/glm-5.2" });

  expect(model).toMatchObject({
    structured_output: false,
    status: "deprecated",
    reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
  });
  expect(jsonMode).toMatchObject({ structured_output: true });
});

test("syncs the catalog's cache feature into v2 files only", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const cached = empiriolabs.translateModel({
    id: "glm-5-1",
    context_length: 202_752,
    features: ["prompt_cache"],
  }, context);
  const uncached = empiriolabs.translateModel({ id: "glm-5-1", context_length: 202_752 }, context);

  const cache = (cached as { v2Set: Record<string, (current: unknown) => unknown> }).v2Set["capabilities.cache"]!;
  expect(cache(undefined)).toEqual({ implicit: true });
  expect(cache(false)).toEqual({ implicit: true });
  expect(cache({ explicit: { ttl: ["5m"] } })).toEqual({ explicit: { ttl: ["5m"] } });
  expect(uncached && "v2Set" in uncached ? uncached.v2Set : undefined).toBeUndefined();
});
