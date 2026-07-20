import { expect, test } from "bun:test";

import { formatToml } from "../src/sync/index.js";
import { buildSferenceModel, type SferenceModel } from "../src/sync/providers/sference.js";

const baseModel = (overrides: Partial<SferenceModel> = {}): SferenceModel => ({
  id: "Qwen/Qwen3.6-35B-A3B",
  object: "model",
  created: 1_712_345_678,
  owned_by: "sference",
  display_name: "Qwen3.6 35B",
  provider: "Qwen",
  modality: "text_generation",
  context_tokens: 262_144,
  capabilities: {
    thinking: { supported: true, types: { enabled: { supported: true } } },
    tools: { supported: true },
    image_input: { supported: false },
    pdf_input: { supported: false },
  },
  pricing: {
    input_per_million_usd: 0,
    output_per_million_usd: 0,
    cached_input_per_million_usd: null,
  },
  ...overrides,
});

test("buildSferenceModel factors a catalog model onto its base_model", () => {
  const model = buildSferenceModel(baseModel(), undefined, "alibaba/qwen3.6-35b-a3b");
  expect("base_model" in model && model.base_model).toBe("alibaba/qwen3.6-35b-a3b");
  expect("name" in model ? model.name : undefined).toBe("Qwen3.6 35B");
  // Pricing comes straight from the nested pricing object (already per-1M USD).
  expect("cost" in model ? model.cost : undefined).toEqual({ input: 0, output: 0 });
  // Reasoning models emit the enable_thinking toggle.
  expect("reasoning_options" in model ? model.reasoning_options : undefined).toEqual([{ type: "toggle" }]);
});

test("buildSferenceModel reads the nested pricing object with cache_read", () => {
  const model = buildSferenceModel(
    {
      ...baseModel(),
      id: "zai-org/GLM-5.2",
      display_name: "GLM 5.2",
      pricing: {
        input_per_million_usd: 1.2,
        output_per_million_usd: 4.2,
        cached_input_per_million_usd: 0.26,
      },
    },
    undefined,
    "zhipuai/glm-5.2",
  ) as Record<string, unknown>;
  const cost = model.cost as Record<string, unknown>;
  expect(cost.input).toBe(1.2);
  expect(cost.output).toBe(4.2);
  expect(cost.cache_read).toBe(0.26);
});

test("buildSferenceModel writes a full inline model when no base_model matches", () => {
  const model = buildSferenceModel(
    {
      ...baseModel(),
      id: "custom-org/Custom-Model",
      display_name: "Custom Model",
      provider: null,
    },
    undefined,
    undefined,
  ) as Record<string, unknown>;
  expect(model.base_model).toBeUndefined();
  expect(model.name).toBe("Custom Model");
  expect((model.cost as Record<string, unknown>).input).toBe(0);
  expect(model.reasoning).toBe(true);
  expect(model.reasoning_options).toEqual([{ type: "toggle" }]);
});

test("buildSferenceModel skips reasoning_options for non-reasoning models", () => {
  const model = buildSferenceModel(
    {
      ...baseModel(),
      capabilities: {
        thinking: { supported: false },
        tools: { supported: true },
        image_input: { supported: false },
        pdf_input: { supported: false },
      },
    },
    undefined,
    "alibaba/qwen3.6-35b-a3b",
  ) as Record<string, unknown>;
  expect(model.reasoning_options).toBeUndefined();
  expect(model.reasoning).toBe(false);
});

test("buildSferenceModel falls back to existing cost when pricing is absent", () => {
  const model = buildSferenceModel(
    { ...baseModel(), pricing: null },
    { cost: { input: 0.14, output: 1 } },
    "alibaba/qwen3.6-35b-a3b",
  ) as Record<string, unknown>;
  const cost = model.cost as Record<string, unknown>;
  expect(cost.input).toBe(0.14);
  expect(cost.output).toBe(1);
});

test("buildSferenceModel preserves hand-authored reasoning_options (effort)", () => {
  // The API only exposes an enable_thinking toggle, not per-model effort levels
  // (DeepSeek V4 Flash accepts reasoning_effort max/high via the worker). Since
  // the API is not authoritative for the reasoning control surface, the sync
  // preserves hand-authored reasoning_options instead of overwriting them.
  const existing = {
    reasoning_options: [
      { type: "toggle" as const },
      { type: "effort" as const, values: ["high", "max"] },
    ],
  };
  const model = buildSferenceModel(
    { ...baseModel(), id: "deepseek-ai/DeepSeek-V4-Flash" },
    existing,
    "deepseek/deepseek-v4-flash",
  ) as Record<string, unknown>;
  expect(model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["high", "max"] },
  ]);
});

test("buildSferenceModel preserves existing hand-authored metadata", () => {
  const existing = {
    name: "Qwen3.6 35B",
    knowledge: "2024-04",
    limit: { context: 262_144, input: 200_000, output: 32_768 },
    modalities: { input: ["text", "image", "video", "audio"] as ("text" | "image" | "video" | "audio")[], output: ["text"] as ["text"] },
    interleaved: { field: "reasoning_content" as const },
    base_model_omit: ["limit.input"],
  };
  const model = buildSferenceModel(baseModel(), existing, "alibaba/qwen3.6-35b-a3b");
  expect("base_model_omit" in model && model.base_model_omit).toEqual(["limit.input"]);
  expect("interleaved" in model && model.interleaved).toEqual({ field: "reasoning_content" });
});

test("buildSferenceModel does not treat created as a release date", () => {
  // `created` is int(time.time()) at request time, not the model release date,
  // so it must not populate release_date. For a factored model the date is
  // inherited from base metadata (undefined here); for an inline model it
  // defaults to today.
  const factored = buildSferenceModel(
    { ...baseModel(), created: 1_712_345_678 },
    undefined,
    "alibaba/qwen3.6-35b-a3b",
    "2026-07-17",
  ) as Record<string, unknown>;
  expect(factored.release_date).toBeUndefined();

  const inline = buildSferenceModel(
    { ...baseModel(), id: "custom-org/Custom", created: 1_712_345_678 },
    undefined,
    undefined,
    "2026-07-17",
  ) as Record<string, unknown>;
  expect(inline.release_date).toBe("2026-07-17");
});

test("formatToml serializes a factored sference model deterministically", () => {
  const model = buildSferenceModel(baseModel(), undefined, "alibaba/qwen3.6-35b-a3b");
  // formatToml accepts the authored model shape; cast the SyncedModel union.
  const toml = formatToml(model as Parameters<typeof formatToml>[0]);
  expect(toml).toContain('base_model = "alibaba/qwen3.6-35b-a3b"');
  expect(toml).toContain("input = 0");
  expect(toml).toContain("[[reasoning_options]]");
  expect(toml).toContain('type = "toggle"');
});