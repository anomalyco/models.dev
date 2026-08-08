import { expect, test } from "bun:test";

import { formatToml, type ExistingModel } from "../src/sync/index.js";
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

test("buildSferenceModel overrides modalities when the catalog is narrower than base", () => {
  // The base checkpoint metadata declares image/video/audio input, but the
  // catalog reports image_input/pdf_input unsupported — the catalog flags are
  // authoritative for what sference serves, so the factored model must write
  // text-only overrides instead of inheriting the richer base arrays.
  const model = buildSferenceModel(baseModel(), undefined, "alibaba/qwen3.6-35b-a3b") as Record<
    string,
    unknown
  >;
  expect(model.modalities).toEqual({ input: ["text"] });
  expect(model.attachment).toBe(false);
});

test("buildSferenceModel inherits modalities when the catalog matches base", () => {
  const model = buildSferenceModel(
    {
      ...baseModel(),
      id: "Qwen/Qwen3-VL-30B-A3B-Instruct",
      display_name: "Qwen3-VL 30B",
      capabilities: {
        thinking: { supported: false },
        tools: { supported: true },
        image_input: { supported: true },
        pdf_input: { supported: false },
      },
    },
    undefined,
    "alibaba/qwen3-vl-30b-a3b-instruct",
  ) as Record<string, unknown>;
  // Base already declares text+image input and attachment, so no override.
  expect(model.modalities).toBeUndefined();
  expect(model.attachment).toBeUndefined();
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

test("buildSferenceModel writes context but lets output inherit from base", () => {
  // The platform publishes no per-model output cap (workers clamp max_tokens
  // to context - prompt), and computing context - input here is not practical.
  // Output is therefore left unset so factored models inherit the base
  // checkpoint's output limit instead of publishing a misleading number.
  const model = buildSferenceModel(
    { ...baseModel(), context_tokens: 1_048_576, id: "zai-org/GLM-5.2" },
    undefined,
    "zhipuai/glm-5.2",
  ) as Record<string, unknown>;
  expect(model.limit).toEqual({ context: 1_048_576 });
});

test("buildSferenceModel leaves limit unset when the catalog omits context", () => {
  // With no context from the API and none on the existing TOML there is no
  // measured window, so limit inherits entirely from the base checkpoint
  // instead of being written with zeros.
  const model = buildSferenceModel(
    { ...baseModel(), context_tokens: null },
    undefined,
    "alibaba/qwen3.6-35b-a3b",
  ) as Record<string, unknown>;
  expect(model.limit).toBeUndefined();
});

test("buildSferenceModel ignores a stale hand-authored output and inherits from base", () => {
  // A stale output cap on the existing TOML must not survive: the sync never
  // writes output (the platform has no per-model cap), so it inherits from
  // base metadata regardless of what the existing TOML says.
  const model = buildSferenceModel(
    baseModel(),
    { limit: { context: 262_144, output: 32_768 } },
    "alibaba/qwen3.6-35b-a3b",
  ) as Record<string, unknown>;
  // Context matches base (262_144) so it is stripped; output is never written.
  expect(model.limit).toBeUndefined();
});

test("buildSferenceModel preserves hand-authored reasoning_options (effort)", () => {
  // The API accepts reasoning_effort but the catalog does not surface which
  // effort levels each model acts on, and a silently-dropped level is not a
  // supported control. Effort is therefore hand-authored per model and the
  // sync preserves it instead of overwriting with the default toggle.
  const existing = {
    reasoning_options: [
      { type: "toggle" as const },
      { type: "effort" as const, values: ["high", "xhigh"] as ("high" | "xhigh")[] },
    ],
  } as Partial<ExistingModel>;
  const model = buildSferenceModel(
    { ...baseModel(), id: "deepseek-ai/DeepSeek-V4-Flash" },
    existing,
    "deepseek/deepseek-v4-flash",
  ) as Record<string, unknown>;
  expect(model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["high", "xhigh"] },
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