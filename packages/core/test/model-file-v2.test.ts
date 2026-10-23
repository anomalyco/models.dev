import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatModelV2, formatTomlValue, patchModelV2, providerModelToV2 } from "../src/model-file-v2.js";
import { modelV2ToV1, readLabMetadata } from "../src/translate.js";

test("patchModelV2 keeps v2 reasoning data when sync inherits reasoning from the lab", () => {
  const doc = {
    schema: 2,
    base_model: "xai/grok-4.7",
    capabilities: {
      reasoning: { supported: true, default: { type: "effort", value: "high" }, effort: ["low", "high"] },
      cache: { implicit: true },
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

test("a bare v1 interleaved round-trips as legacy_interleaved", () => {
  const v1 = { base_model: "moonshotai/kimi-k2", interleaved: true, cost: { input: 1, output: 2 } };
  const doc = providerModelToV2(v1, "chat-completions");

  expect(doc.api).toEqual({ "chat-completions": { legacy_interleaved: true } });
  const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(doc)) as Record<string, unknown>), id: "m" });
  expect(back.interleaved).toBe(true);
});

test("an API table without its own aisdk takes the provider's npm for its v1 shape", () => {
  const toml = { schema: 2, id: "m", base_model: "openai/gpt-5.5", api: { responses: {}, "chat-completions": {} } };
  // On a Responses-default SDK, a leading Responses table is the default and has no v1 shape.
  expect(modelV2ToV1(toml, {}, "@ai-sdk/openai").provider).toBeUndefined();
  // Elsewhere it still publishes one.
  expect(modelV2ToV1(toml, {}, "@ai-sdk/openai-compatible").provider).toEqual({ shape: "responses" });
  expect(modelV2ToV1(toml).provider).toEqual({ shape: "responses" });

  // The writer keeps a redundant v1 shape as legacy_shape, judged against the provider's npm.
  const v1 = { base_model: "openai/gpt-5.5", provider: { shape: "responses" } };
  const doc = providerModelToV2(v1, undefined, "@ai-sdk/openai");
  expect(doc.api).toEqual({ responses: { legacy_shape: "responses" } });
  const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(doc)) as Record<string, unknown>), id: "m" }, {}, "@ai-sdk/openai");
  expect(back.provider).toEqual(v1.provider);
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

test("patchModelV2 keeps the file's exact formats for each kind the catalog still lists", () => {
  const doc = {
    schema: 2,
    base_model: "openai/gpt-5.5",
    modalities: {
      input: ["text", "image/png", "image/jpeg", "application/pdf"],
      output: ["text", "image/png"],
    },
    cost: { text: { input: { price: 1 }, output: { price: 2 } } },
  };
  const { id: _id, ...before } = modelV2ToV1({ ...doc, id: "m" });
  expect(before.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text", "image"] });
  const patch = (input: string[], output = ["text", "image"]) => {
    const after = { ...before, modalities: { input, output } };
    const next = patchModelV2(doc, before, after);
    // The v1 view matches the catalog, so the next sync sees no change.
    const back = modelV2ToV1({ ...(Bun.TOML.parse(formatModelV2(next)) as Record<string, unknown>), id: "m" });
    expect(back.modalities).toEqual(after.modalities);
    const { id: _, ...again } = back;
    expect(patchModelV2(next, again, after)).toEqual(next);
    return next.modalities;
  };

  // No change: the file is untouched.
  expect(patch(["text", "image", "pdf"])).toBe(doc.modalities);
  // A kind added: exact formats are kept, the new kind is generic.
  expect(patch(["text", "image", "pdf", "audio"]).input).toEqual([
    "text", "image/png", "image/jpeg", "application/pdf", "audio",
  ]);
  // A kind removed.
  expect(patch(["text", "image"]).input).toEqual(["text", "image/png", "image/jpeg"]);
  // A new order.
  expect(patch(["pdf", "text", "image"]).input).toEqual(["application/pdf", "text", "image/png", "image/jpeg"]);
  // A new pdf kind is written as application/pdf.
  expect(patch(["text", "pdf"]).input).toEqual(["text", "application/pdf"]);
  // Output is merged on its own; an unchanged input list is kept as is.
  const output = patch(["text", "image", "pdf"], ["text", "image", "audio"]);
  expect(output.input).toBe(doc.modalities.input);
  expect(output.output).toEqual(["text", "image/png", "audio"]);
});

test("patchModelV2 writes the catalog's modalities when the file inherits them", () => {
  const doc = { schema: 2, base_model: "openai/gpt-5.5", cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = { base_model: "openai/gpt-5.5", modalities: { input: ["text", "image"], output: ["text"] }, cost: { input: 1, output: 2 } };
  const after = { ...before, modalities: { input: ["text", "image", "pdf"], output: ["text"] } };

  expect(patchModelV2(doc, before, after).modalities).toEqual({
    input: ["text", "image", "application/pdf"],
    output: ["text"],
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

test("patchModelV2 keeps a file's other API tables and OpenCode package", () => {
  const api = {
    "chat-completions": {
      sdk: { opencodeai: "@opencode/ai/providers/openai-compatible" },
      compatibility: { reasoning_field: "reasoning_details" },
    },
    images: { base_url: "https://images.example.com/v1", sdk: { opencodeai: "@opencode/ai/protocols/openai-images" } },
  };
  const doc = { schema: 2, base_model: "moonshotai/kimi-k2.6", api, cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = modelV2ToV1({ ...doc, id: "m" });
  const { id: _id, ...after } = { ...before, cost: { input: 3, output: 4 } };

  // Unchanged v1 API fields: every table is kept as it is, in order.
  expect(Object.entries(patchModelV2(doc, before, after).api)).toEqual(Object.entries(api));
  // A synced change to v1's fields rewrites the first table and keeps the rest.
  const changed = { ...after, interleaved: { field: "reasoning_content" } };
  expect(Object.entries(patchModelV2(doc, before, changed).api)).toEqual([
    [
      "chat-completions",
      {
        sdk: { opencodeai: "@opencode/ai/providers/openai-compatible" },
        compatibility: { reasoning_field: "reasoning_content" },
      },
    ],
    ["images", api.images],
  ]);
});

test('patchModelV2 keeps aisdk = "none" when sync rewrites the first table', () => {
  const api = { systemone: { base_url: "https://example.com/v1", sdk: { aisdk: "none" } } };
  const doc = { schema: 2, base_model: "typesafe/jev-1.13", api, cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = modelV2ToV1({ ...doc, id: "m" });
  expect(before.provider).toEqual({ api: "https://example.com/v1" });
  const { id: _id, ...after } = { ...before, provider: { api: "https://example.com/v2" } };
  expect(patchModelV2(doc, before, after).api).toEqual({
    systemone: { base_url: "https://example.com/v2", sdk: { aisdk: "none" } },
  });
});

test("patchModelV2 keeps the first table's path when sync rewrites it", () => {
  const api = { systemone: { base_url: "https://example.com/v1", path: "/decisions" } };
  const doc = { schema: 2, base_model: "typesafe/jev-1.13", api, cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = modelV2ToV1({ ...doc, id: "m" });
  expect(before.provider).toEqual({ api: "https://example.com/v1" });
  const { id: _id, ...after } = { ...before, provider: { api: "https://example.com/v2" } };
  expect(Object.entries(patchModelV2(doc, before, after).api.systemone)).toEqual([
    ["base_url", "https://example.com/v2"],
    ["path", "/decisions"],
  ]);
});

test("patchModelV2 keeps the first table's capabilities when sync rewrites it", () => {
  const api = { messages: { base_url: "https://example.com/v1", capabilities: { effort_updates: true } } };
  const doc = { schema: 2, base_model: "anthropic/claude-opus-5-5", api, cost: { text: { input: { price: 1 }, output: { price: 2 } } } };
  const before = modelV2ToV1({ ...doc, id: "m" });
  const { id: _id, ...after } = { ...before, provider: { ...before.provider, api: "https://example.com/v2" } };
  expect(patchModelV2(doc, before, after).api.messages).toEqual({
    base_url: "https://example.com/v2",
    capabilities: { effort_updates: true },
  });
});

test("v1 cache_write falls back to the explicit write price", () => {
  const doc = {
    schema: 2,
    base_model: "alibaba/qwen-plus",
    cost: { text: { input: { price: 0.4, cache: { read: 0.08, explicit: { read: 0.04, write: 0.5 } } }, output: { price: 1.2 } } },
  };
  const v1 = modelV2ToV1({ ...doc, id: "m" });
  expect(v1.cost).toMatchObject({ cache_read: 0.08, cache_write: 0.5 });
});

test("web search prices are written to v2 files, kept by patches, and left out of v1", () => {
  const doc = {
    schema: 2,
    base_model: "openai/gpt-5.4",
    cost: {
      text: { input: { price: 2.5 }, output: { price: 15 } },
      web_search: {
        price: 10,
        overrides: [
          { when: { search_context_size: { equals: "low" } }, price: 5 },
          { when: { search_context_size: { in: ["high"] } }, price: 25 },
        ],
      },
    },
  };
  const toml = formatModelV2(doc);
  expect(toml).toContain([
    "[cost.web_search]",
    "price = 10",
    "",
    "[[cost.web_search.overrides]]",
    'when = { search_context_size = { equals = "low" } }',
    "price = 5",
  ].join("\n"));
  const parsed = { ...(Bun.TOML.parse(toml) as Record<string, unknown>), id: "gpt-5.4" };
  expect(parsed.cost).toEqual(doc.cost);
  expect(modelV2ToV1(parsed).cost).toEqual({ input: 2.5, output: 15 });

  const before = { base_model: "openai/gpt-5.4", cost: { input: 2.5, output: 15 } };
  const after = { base_model: "openai/gpt-5.4", cost: { input: 3, output: 15 } };
  expect(patchModelV2(doc, before, after).cost.web_search).toEqual(doc.cost.web_search);

  // A web search price alone has no v1 cost.
  expect(modelV2ToV1({ schema: 2, id: "x", cost: { web_search: { price: 10 } } }).cost).toBeUndefined();
  expect(() => modelV2ToV1({ schema: 2, id: "x", cost: { web_search: { price: 10, unit: "request" } } })).toThrow();
});

test("v1 mode prices come from an object factor the same way as from a plain number", () => {
  const cost = {
    text: { input: { price: 4, cache: { read: 0.4, write: { "5m": 5, "1h": 8 } } }, output: { price: 20 } },
    audio: { input: { price: 6 } },
    web_search: { price: 10 },
  };
  const mode = (factor: unknown) =>
    (modelV2ToV1({
      schema: 2,
      id: "x",
      cost: { ...cost, multipliers: [{ when: { service_tier: { equals: "fast" } }, factor }] },
      experimental: { modes: { fast: { body: { speed: "fast" } } } },
    }) as any).experimental.modes.fast.cost;

  const expected = { input: 8, output: 40, cache_read: 0.8, cache_write: 10, input_audio: 12 };
  expect(mode(2)).toEqual(expected);
  expect(mode({ text: 2, audio: 2 })).toEqual(expected);
  // Prices an object factor doesn't name keep their base price.
  expect(mode({ text: { output: 2 } })).toEqual({ input: 4, output: 40, cache_read: 0.4, cache_write: 5, input_audio: 6 });
});

test("readLabMetadata reads a v2 lab.toml and rejects v1 or unknown fields", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lab-metadata-"));
  const write = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    return file;
  };
  try {
    expect(readLabMetadata(write("v2.toml", 'schema = 2\ndescription = "A lab."\n'))).toEqual({ description: "A lab." });
    expect(() => readLabMetadata(write("v1.toml", 'description = "A lab."\n'))).toThrow("schema = 2");
    expect(() => readLabMetadata(write("extra.toml", 'schema = 2\ndescription = "A lab."\nname = "Lab"\n'))).toThrow();
    expect(() => readLabMetadata(write("empty.toml", 'schema = 2\ndescription = ""\n'))).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
