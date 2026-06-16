import { expect, test } from "bun:test";

import {
  buildMoonshotModel,
  fetchMoonshotModels,
  MoonshotResponse,
  type MoonshotModel,
} from "../src/sync/providers/moonshotai.js";

const model: MoonshotModel = {
  id: "kimi-k2.7-code-highspeed",
  created: 1_781_516_706,
  context_length: 262_144,
  supports_image_in: true,
  supports_video_in: true,
  supports_reasoning: true,
};

test("Moonshot sync keeps base models compact", () => {
  const synced = buildMoonshotModel(model, {
    base_model: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code HighSpeed",
    family: "kimi-k2",
    release_date: "2026-06-12",
    last_updated: "2026-06-12",
    attachment: true,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    structured_output: true,
    temperature: false,
    knowledge: "2025-01",
    open_weights: true,
    cost: { input: 1.9, output: 8, cache_read: 0.38 },
    limit: { context: 262_144, output: 262_144 },
    modalities: { input: ["text", "image", "video"], output: ["text"] },
  });

  expect(synced).toEqual({
    base_model: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code HighSpeed",
    reasoning_options: [],
    interleaved: { field: "reasoning_content" },
    cost: { input: 1.9, output: 8, cache_read: 0.38 },
  });
});

test("Moonshot sync maps authoritative capabilities and preserves curated fields", () => {
  const synced = buildMoonshotModel({
    ...model,
    supports_image_in: undefined,
    supports_video_in: undefined,
    supports_reasoning: undefined,
    context_length: 131_072,
  }, {
    name: "Moonshot Test",
    family: "kimi-k2",
    release_date: "2025-01-01",
    last_updated: "2025-02-01",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    structured_output: true,
    temperature: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 262_144, output: 32_768 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });

  expect(synced).toMatchObject({
    attachment: false,
    reasoning: false,
    tool_call: true,
    structured_output: true,
    cost: { input: 1, output: 2 },
    limit: { context: 131_072, output: 32_768 },
    modalities: { input: ["text"], output: ["text"] },
  });
  expect(synced.reasoning_options).toBeUndefined();
  expect(synced.interleaved).toBeUndefined();
});

test("Moonshot rejects malformed catalog responses", () => {
  expect(() => MoonshotResponse.parse({ data: [{ id: "broken" }] })).toThrow();
});

test("Moonshot rejects non-success API responses", async () => {
  const fetcher = async () => new Response("unauthorized", {
    status: 401,
    statusText: "Unauthorized",
  });

  expect(fetchMoonshotModels("https://example.com/v1/models", "fixture-key", fetcher as typeof fetch))
    .rejects.toThrow("Moonshot models request failed: 401 Unauthorized");
});
