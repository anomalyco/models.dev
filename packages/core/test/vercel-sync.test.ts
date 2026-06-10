import { expect, test } from "bun:test";

import { buildVercelModel, type VercelModel, vercel } from "../src/sync/providers/vercel.js";

const model: VercelModel = {
  id: "openai/gpt-test",
  name: "GPT Test",
  created: 1_700_000_000,
  released: 1_710_000_000,
  context_window: 128_000,
  max_tokens: 32_000,
  type: "language",
  tags: ["reasoning", "tool-use", "vision", "file-input"],
  pricing: {
    input: "0.000001",
    output: "0.000004",
    input_cache_read: "0.0000001",
  },
};

test("Vercel models translate gateway metadata", () => {
  const synced = buildVercelModel(model, undefined);

  expect(synced).toMatchObject({
    name: "GPT Test",
    release_date: "2024-03-09",
    last_updated: "2024-03-09",
    attachment: true,
    reasoning: true,
    tool_call: true,
    open_weights: false,
    cost: { input: 1, output: 4, cache_read: 0.1 },
    limit: { context: 128_000, input: 96_000, output: 32_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
});

test("Vercel models preserve curated metadata and missing limits", () => {
  const synced = buildVercelModel({
    ...model,
    context_window: 0,
    max_tokens: 0,
  }, {
    name: "Curated name",
    release_date: "2024-01-01",
    last_updated: "2025-01-01",
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    cost: {
      input: 2,
      output: 8,
      tiers: [{
        tier: { type: "context", size: 200_000 },
        input: 3,
        output: 12,
      }],
    },
    limit: { context: 64_000, input: 48_000, output: 16_000 },
  });

  expect(synced.name).toBe("Curated name");
  expect(synced.last_updated).toBe("2025-01-01");
  expect(synced.reasoning_options).toEqual([{ type: "effort", values: ["low", "high"] }]);
  expect(synced.cost?.tiers).toHaveLength(1);
  expect(synced.limit).toEqual({ context: 64_000, input: 48_000, output: 16_000 });
});

test("Vercel non-language models use API tool capabilities", () => {
  const synced = buildVercelModel({
    ...model,
    type: "image",
    tags: [],
  }, {
    tool_call: true,
  });

  expect(synced.tool_call).toBe(false);
});

test("Vercel sync includes non-language model types", () => {
  for (const [type, output] of [
    ["image", ["image"]],
    ["video", ["video"]],
    ["reranking", ["text"]],
  ] as const) {
    const source = {
      ...model,
      id: `test/${type}`,
      type,
      tags: [],
      context_window: 0,
      max_tokens: 0,
      pricing: undefined,
    };

    expect(vercel.translateModel(source, { existing: () => undefined })).toBeDefined();
    expect(buildVercelModel(source, undefined)).toMatchObject({
      tool_call: false,
      modalities: { input: ["text"], output },
    });
  }
});

test("Vercel models use canonical metadata when available", () => {
  const synced = buildVercelModel({
    ...model,
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron 3 Ultra",
  }, undefined);

  expect("base_model" in synced ? synced.base_model : undefined)
    .toBe("nvidia/nemotron-3-ultra-550b-a55b");
  expect("last_updated" in synced ? synced.last_updated : undefined).toBeUndefined();
});
