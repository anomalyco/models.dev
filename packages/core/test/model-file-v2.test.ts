import { expect, test } from "bun:test";

import { formatModelV2, formatTomlValue, patchModelV2, providerModelToV2 } from "../src/model-file-v2.js";
import { modelV2ToV1 } from "../src/translate.js";

test("patchModelV2 keeps v2 reasoning data when sync inherits reasoning from the lab", () => {
  const doc = {
    schema: 2,
    base_model: "xai/grok-4.7",
    capabilities: {
      reasoning: { supported: true, default: { type: "effort", value: "high" }, effort: ["low", "high"] },
      cache: { supported: true, implicit: true, explicit: false },
    },
    cost: {
      text: { input: { price: 9 }, output: { price: 6 } },
      multipliers: [{ when: { region: { equals: "us" } }, factor: 1.1 }],
    },
  };
  const reasoning_options = [{ type: "effort", values: ["low", "high"] }];
  const before = { base_model: "xai/grok-4.7", reasoning: true, reasoning_options, cost: { input: 9, output: 6 } };
  const after = { base_model: "xai/grok-4.7", reasoning_options, cost: { input: 2, output: 6 } };

  const next = patchModelV2(doc, before, after);

  expect(next.capabilities).toEqual(doc.capabilities);
  expect(next.cost).toEqual({
    text: { input: { price: 2 }, output: { price: 6 } },
    multipliers: [{ when: { region: { equals: "us" } }, factor: 1.1 }],
  });
});

test("a model's own API round-trips through v2 as an [api.<protocol>] table", () => {
  const v1 = {
    base_model: "openai/gpt-oss-120b",
    provider: { npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://bedrock-mantle.us-east-1.api.aws/v1", shape: "responses" },
    interleaved: { field: "reasoning_content" },
    cost: { input: 1, output: 2 },
  };
  const doc = providerModelToV2(v1, "chat-completions");

  expect(doc.api).toEqual({
    responses: {
      base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
      sdk: { aisdk: "@ai-sdk/amazon-bedrock/mantle" },
      compatibility: { reasoning_field: "reasoning_content" },
    },
  });
  const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(doc)) as Record<string, unknown>), id: "m" });
  expect(back.provider).toEqual(v1.provider);
  expect(back.interleaved).toEqual(v1.interleaved);
});

test("formatTomlValue writes an empty inline table as {}", () => {
  expect(formatTomlValue({ budget: {} })).toBe("{ budget = {} }");
});
