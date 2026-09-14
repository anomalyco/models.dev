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
