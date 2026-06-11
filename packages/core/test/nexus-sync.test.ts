import { expect, test } from "bun:test";

import {
  buildNexusModel,
  fetchNexusModels,
  NexusResponse,
  type NexusModel,
} from "../src/sync/providers/nexus.js";

const model: NexusModel = {
  id: "deepseek/deepseek-v4-pro",
  kind: "public_model",
  created: 0,
  display_name: "Deepseek V4 Pro",
  context_size: 1_048_576,
  max_output_tokens: 393_216,
  input_price_per_1m_tokens_usd: 0.46,
  output_price_per_1m_tokens_usd: 0.91,
  cache_read_price_per_1m_tokens_usd: 0.0115,
  features: [
    "streaming",
    "function-calling",
    "parallel-tool-calls",
    "structured-outputs",
    "reasoning",
  ],
  endpoints: ["chat/completions"],
};

test("Nexus public models translate live catalog pricing and capabilities", () => {
  const synced = buildNexusModel(model, undefined, "2026-06-10");

  expect(synced).toMatchObject({
    base_model: "deepseek/deepseek-v4-pro",
    name: "Deepseek V4 Pro",
    cost: { input: 0.46, output: 0.91, cache_read: 0.0115 },
    limit: { context: 1_048_576, output: 393_216 },
  });
});

test("Nexus router models omit fixed pricing", () => {
  const synced = buildNexusModel({
    id: "nexus/auto",
    kind: "router",
    created: 1_779_115_012,
    display_name: "Auto Router",
    features: ["routing"],
    endpoints: ["chat/completions"],
  }, undefined, "2026-06-10");

  expect(synced).toMatchObject({
    name: "Auto Router",
    family: "auto",
    release_date: "2026-05-18",
    reasoning: true,
    tool_call: true,
    structured_output: true,
    cost: undefined,
    limit: { context: 1_048_576, output: 393_216 },
  });
});

test("Nexus private models translate as ordinary models and add a private name suffix", () => {
  const synced = buildNexusModel({
    ...model,
    id: "private/deepseek-v4-pro",
    display_name: "Deepseek v4 Pro",
    features: ["streaming", "function-calling", "parallel-tool-calls"],
  }, undefined, "2026-06-10");

  expect(synced).toMatchObject({
    name: "Deepseek v4 Pro - Private",
    cost: { input: 0.46, output: 0.91, cache_read: 0.0115 },
    limit: { context: 1_048_576, output: 393_216 },
    reasoning: false,
    tool_call: true,
    structured_output: false,
  });
  expect("base_model" in synced).toBe(false);
});

test("Nexus rejects malformed catalog responses", () => {
  expect(() => NexusResponse.parse({ data: "broken" })).toThrow();
});

test("Nexus rejects non-success API responses", async () => {
  const fetcher = async () => new Response("unavailable", {
    status: 503,
    statusText: "Service Unavailable",
  });

  expect(fetchNexusModels(fetcher as typeof fetch))
    .rejects.toThrow("Nexus request failed: 503 Service Unavailable");
});
