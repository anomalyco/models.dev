import { expect, test } from "bun:test";

import { zenzmux } from "../src/sync/providers/zenmux.js";

function pageModel(overrides: Record<string, unknown> = {}) {
  return {
    slug: "example/example-model",
    name: "Example: Example Model",
    description: "Example model from the ZenMux models page.",
    input_modalities: "text",
    output_modalities: "text",
    context_length: 32_768,
    max_completion_tokens: 8_192,
    pricing_prompt: "1",
    pricing_completion: "2",
    publish_time: "2026-09-15",
    suitable_api: "chat.completions",
    supported_parameters: "temperature,tools",
    supports_reasoning: 0,
    variable_pricings: JSON.stringify([
      {
        feeItemCode: "prompt",
        feeRecords: [{ feeRate: 1, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
      },
      {
        feeItemCode: "completion",
        feeRecords: [{ feeRate: 2, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
      },
    ]),
    ...overrides,
  };
}

test("parses the model-page response and preserves page slugs", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({ slug: "qwen/qwen-image-3.0" })],
  });

  expect(model?.slug).toBe("qwen/qwen-image-3.0");
});

test("does not invent token costs for second-based video pricing", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "alibaba/wan3.0-video",
      input_modalities: "text,image,video",
      output_modalities: "video",
      context_length: 20_000,
      max_completion_tokens: 0,
      pricing_prompt: "0",
      pricing_completion: "0",
      suitable_api: "videos",
      supported_parameters: "",
      variable_pricings: JSON.stringify([
        {
          feeItemCode: "video",
          feeRecords: [{ feeRate: 0.1, components: [{ code: "chargeUnit", value: "seconds" }] }],
        },
      ]),
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.id).toBe("alibaba/wan3.0-video");
  expect(translated?.model).not.toHaveProperty("cost");
});

test("maps token-priced image output when completion is absent", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "openai/gpt-image-2.5-flare",
      output_modalities: "image",
      suitable_api: "images",
      supported_parameters: "",
      pricing_prompt: "5",
      pricing_completion: "0",
      variable_pricings: JSON.stringify([
        {
          feeItemCode: "prompt",
          feeRecords: [{ feeRate: 5, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
        },
        {
          feeItemCode: "image_output",
          feeRecords: [{ feeRate: 30, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
        },
      ]),
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model.cost).toMatchObject({ input: 5, output: 30 });
});

test("keeps existing factored models override-only", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "openai/gpt-5.4",
      supports_reasoning: 1,
      supported_parameters: "tools,tool_choice",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => ({
      name: "GPT-5.4",
      reasoning: true,
      limit: { context: 1_000_000, output: 128_000 },
    }),
    authored: () => ({
      base_model: "openai/gpt-5.4",
      cost: { input: 1 },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    }),
  });

  expect(translated?.model).toMatchObject({ base_model: "openai/gpt-5.4" });
  expect(translated?.model).not.toHaveProperty("description");
  expect(translated?.model).not.toHaveProperty("family");
  expect(translated?.model).not.toHaveProperty("release_date");
});

test("does not invent empty reasoning controls", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "example/reasoning-model",
      supports_reasoning: 1,
    })],
  });

  expect(() => zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  })).toThrow("refusing to write reasoning_options = []");
});

test("uses DeepSeek V4 native reasoning controls", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "deepseek/deepseek-v4-flash",
      supports_reasoning: 1,
      supported_parameters: "tools,tool_choice",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "high", "max"] },
  ]);
  expect(translated?.header).toContain("thinking.type = enabled|disabled");
});

test("maps specialized cache-write prices", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      variable_pricings: JSON.stringify([
        {
          feeItemCode: "prompt",
          feeRecords: [{ feeRate: 1, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
        },
        {
          feeItemCode: "completion",
          feeRecords: [{ feeRate: 2, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
        },
        {
          feeItemCode: "input_cache_write_5_min",
          feeRecords: [{ feeRate: 3, components: [{ code: "chargeUnit", value: "millionTokens" }] }],
        },
      ]),
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model.cost).toMatchObject({ cache_write: 3 });
});

test("prefers lab reasoning controls and preserves provider-only overrides", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "z-ai/glm-5.2",
      supports_reasoning: 1,
      supported_parameters: "",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => ({
      base_model: "zhipuai/glm-5.2",
      temperature: false,
      tool_call: false,
      interleaved: { field: "reasoning_content" },
      experimental: { modes: { fast: { provider: { body: { speed: "fast" } } } } },
    } as any),
  });

  expect(translated?.model.reasoning_options).toEqual([
    { type: "effort", values: ["high", "max"] },
  ]);
  expect(translated?.model).not.toHaveProperty("temperature");
  expect(translated?.model).not.toHaveProperty("tool_call");
  expect(translated?.model).toHaveProperty("interleaved");
  expect(translated?.model).toHaveProperty("experimental");
});

test("uses Anthropic lab controls instead of OpenRouter controls", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "anthropic/claude-opus-5",
      supports_reasoning: 1,
      supported_parameters: "",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => ({ base_model: "anthropic/claude-opus-5" }),
  });

  expect(translated?.model.reasoning_options).toEqual([
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ]);
});

test("uses Gemini 2.5 thinking budget controls", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "google/gemini-2.5-flash",
      supports_reasoning: 1,
      supported_parameters: "",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => ({ base_model: "google/gemini-2.5-flash" }),
  });

  expect(translated?.model.reasoning_options).toEqual([
    { type: "toggle" },
    { type: "budget_tokens", min: 0, max: 24_576 },
  ]);
  expect(translated?.header).toContain("thinking_config.thinking_budget");
});

test("resolves Qwen Max Thinking to its dedicated lab identity", () => {
  const [model] = zenzmux.parseModels({
    success: true,
    data: [pageModel({
      slug: "qwen/qwen3-max",
      supports_reasoning: 1,
      supported_parameters: "tools,tool_choice",
    })],
  });

  const translated = zenzmux.translateModel(model!, {
    existing: () => undefined,
    authored: () => undefined,
  });

  expect(translated?.model).toMatchObject({
    base_model: "alibaba/qwen3-max-thinking",
  });
});
