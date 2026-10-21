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

test("a v1 shape that repeats the SDK default round-trips as legacy_shape", () => {
  const v1 = {
    base_model: "openai/gpt-5.5",
    provider: { npm: "@ai-sdk/openai", api: "https://example.com/v1", shape: "responses" },
    cost: { input: 1, output: 2 },
  };
  const doc = providerModelToV2(v1);

  expect(doc.api).toEqual({
    responses: { base_url: "https://example.com/v1", sdk: { aisdk: "@ai-sdk/openai" }, legacy_shape: "responses" },
  });
  const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(doc)) as Record<string, unknown>), id: "m" });
  expect(back.provider).toEqual(v1.provider);

  // Without a v1 shape, nothing legacy is written.
  const { shape: _shape, ...provider } = v1.provider;
  expect(providerModelToV2({ ...v1, provider }, "responses").api).toEqual({
    responses: { base_url: "https://example.com/v1", sdk: { aisdk: "@ai-sdk/openai" } },
  });
});

test("legacy_shape must name the protocol of its [api.<protocol>] table", () => {
  expect(() =>
    modelV2ToV1({
      id: "m",
      api: { "chat-completions": { sdk: { aisdk: "@ai-sdk/openai" }, legacy_shape: "responses" } },
    }),
  ).toThrow('legacy_shape = "responses" doesn\'t match [api.chat-completions]');
});

test("patchModelV2 keeps legacy_shape", () => {
  const api = {
    responses: { base_url: "https://example.com/v1", sdk: { aisdk: "@ai-sdk/openai" }, legacy_shape: "responses" },
  };
  const doc = { schema: 2, base_model: "openai/gpt-5.5", api, cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = modelV2ToV1({ ...doc, id: "m" });
  const { id: _id, ...after } = { ...before, cost: { input: 3, output: 4 } };

  // Same provider: the file's API table is kept as is.
  expect(patchModelV2(doc, before, after).api).toEqual(api);
  // A changed provider is rewritten from v1 and still keeps the shape.
  const moved = { ...after, provider: { ...(after.provider as object), api: "https://example.com/v2" } };
  expect(patchModelV2(doc, before, moved).api).toEqual({
    responses: { ...api.responses, base_url: "https://example.com/v2" },
  });
});

test("formatTomlValue writes an empty inline table as {}", () => {
  expect(formatTomlValue({ budget: {} })).toBe("{ budget = {} }");
});

test('v2 effort "default" stays the literal "default" in v1', () => {
  const v1 = {
    base_model: "alibaba/qwen3.8-27b",
    reasoning_options: [{ type: "effort", values: ["none", "default", "low"] }],
    cost: { input: 1, output: 2 },
  };
  const doc = providerModelToV2(v1);
  expect(doc.capabilities.reasoning).toEqual({ supported: true, effort: ["none", "default", "low"] });

  const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(doc)) as Record<string, unknown>), id: "m" });
  expect(back.reasoning_options).toEqual([{ type: "effort", values: ["none", "default", "low"] }]);
});
