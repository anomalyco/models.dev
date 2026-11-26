import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  assertPlugskyInventory,
  plugsky,
  type PlugskyModel,
} from "../src/sync/providers/plugsky.js";

function model(overrides: Partial<PlugskyModel> = {}): PlugskyModel {
  return {
    id: "plugsky-pro",
    created: 1_795_680_182,
    name: "Plugsky Pro",
    description: "Plugsky Pro: 550B (activated: ~55B), 262144 token serving context.",
    reasoning: true,
    function_calling: true,
    json_mode: true,
    modality: ["text"],
    context_window: 262_144,
    max_output_tokens: 16_384,
    ...overrides,
  };
}

function context(entries: Record<string, ExistingModel> = {}) {
  return {
    existing: (id: string) => entries[id],
    authored: (id: string) => entries[id],
  };
}

function existing(overrides: Partial<ExistingModel> = {}): ExistingModel {
  return {
    name: "Plugsky Pro",
    description: "Curated description",
    attachment: false,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: false,
    release_date: "2025-01-01",
    last_updated: "2025-02-01",
    modalities: { input: ["text"], output: ["text"] },
    open_weights: false,
    limit: { context: 131_072, output: 8_192 },
    ...overrides,
  } as ExistingModel;
}

test("refuses a truncated inventory", () => {
  const small = Array.from({ length: 17 }, (_, index) =>
    model({ id: `plugsky-brand-${index}` }),
  );

  expect(() => assertPlugskyInventory(small)).toThrow(/below the 18/);
});

test("accepts a complete branded inventory", () => {
  const full = Array.from({ length: 18 }, (_, index) =>
    model({ id: `plugsky-brand-${index}` }),
  );

  expect(() => assertPlugskyInventory(full)).not.toThrow();
});

test("fails instead of inventing a missing limit", () => {
  expect(() =>
    plugsky.translateModel(
      model({ context_window: null, engine_context_window: null }),
      context() as never,
    ),
  ).toThrow(/missing context or output limits/);
});

test("reports every source ID so skipped aliases reach the notice", () => {
  expect(plugsky.sourceID?.(model({ id: "plugsky-deepseek-flash" }))).toBe("plugsky-deepseek-flash");
  expect(plugsky.sourceID?.(model({ id: "plugsky-embed" }))).toBe("plugsky-embed");
  expect(plugsky.sourceID?.(model({ id: "plugsky-pro" }))).toBe("plugsky-pro");
});

test("skips lab-sounding aliases and embeddings", () => {
  for (const id of [
    "plugsky-deepseek-flash",
    "plugsky-gpt-oss",
    "plugsky-gemma-4",
    "plugsky-kimi",
    "plugsky-qwen-vl",
    "plugsky-embed",
  ]) {
    expect(plugsky.translateModel(model({ id }), context() as never)).toBeUndefined();
  }
});

test("publishes a base_model entry with documented sampling overrides", () => {
  const result = plugsky.translateModel(model(), context() as never);

  expect(result).toBeDefined();
  expect(result?.model).toMatchObject({
    base_model: "nvidia/nemotron-3-ultra-550b-a55b",
    limit: { context: 262_144, output: 16_384 },
  });
  expect(result?.v2Set).toEqual({
    "capabilities.top_p": true,
    "capabilities.top_k": false,
  });
});

test("standalone entries publish documented sampling flags", () => {
  const result = plugsky.translateModel(model({ id: "plugsky-gpu-27b" }), context() as never);

  expect(result?.model).toMatchObject({
    temperature: true,
    limit: { context: 262_144, output: 16_384 },
  });
});

test("preserves an existing release date and last update on standalone entries", () => {
  const result = plugsky.translateModel(
    model({ id: "plugsky-gpu-27b" }),
    context({ "plugsky-gpu-27b": existing() }) as never,
  );

  expect(result?.model).toMatchObject({
    release_date: "2025-01-01",
    last_updated: "2025-02-01",
  });
});

test("stamps a new standalone entry with its first catalog date", () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = plugsky.translateModel(model({ id: "plugsky-gpu-27b" }), context() as never);

  expect(result?.model).toMatchObject({
    release_date: today,
    last_updated: today,
  });
});

test("base_model entries carry only host deltas, not dates or lab capabilities", () => {
  const result = plugsky.translateModel(model(), context() as never);

  expect(result?.model).toMatchObject({
    base_model: "nvidia/nemotron-3-ultra-550b-a55b",
    limit: { context: 262_144, output: 16_384 },
  });
  expect(result?.model).not.toHaveProperty("release_date");
  expect(result?.model).not.toHaveProperty("last_updated");
  expect(result?.model).not.toHaveProperty("reasoning");
  expect(result?.model).not.toHaveProperty("tool_call");
});
