import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildUberLLMModel, fetchUberLLMModels, uberllm, type UberLLMModel } from "../src/sync/providers/uberllm.js";

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

function uberllmModel(overrides: Partial<UberLLMModel> = {}): UberLLMModel {
  return {
    id: "moonshotai/kimi-k3",
    available: true,
    context_length: 1_000_000,
    max_output_tokens: 131_072,
    pricing: {
      unit: "1M tokens",
      input_usd: 0.01152,
      output_usd: 0.96,
      cache_read_usd: 0.01092,
      prompt: "0.00000001152",
    },
    ...overrides,
  };
}

// A full definition rather than a base_model overlay, so these assert the
// mapping itself instead of how factorBaseModel diffs against a lab file.
function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Kimi K3",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
    tool_call: true,
    open_weights: true,
    cost: { input: 0.02, output: 1.1, cache_read: 0.015 },
    limit: { context: 262_144, output: 32_768 },
    modalities: { input: ["text", "image"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("takes prices and context from the catalog, keeping authored reasoning and output limit", () => {
  expect(buildUberLLMModel(uberllmModel(), authored())).toMatchObject({
    reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
    cost: { input: 0.01152, output: 0.96, cache_read: 0.01092 },
    limit: { context: 1_000_000, output: 32_768 },
  });
});

test("does not add a cached-input price to a file that has none", () => {
  const built = buildUberLLMModel(uberllmModel(), authored({ cost: { input: 0.02, output: 1.1 } }));
  expect(built.cost).toMatchObject({ input: 0.01152, output: 0.96, cache_read: undefined });
});

test("keeps the authored cached-input price when the catalog stops quoting one", () => {
  const model = uberllmModel({ pricing: { unit: "1M tokens", input_usd: 0.25, output_usd: 1.5 } });
  expect(buildUberLLMModel(model, authored()).cost).toMatchObject({ input: 0.25, output: 1.5, cache_read: 0.015 });
});

test("fails on an existing model without an output price", () => {
  const model = uberllmModel({ pricing: { unit: "1M tokens", input_usd: 0.04 } });
  expect(() => buildUberLLMModel(model, authored())).toThrow("no output price");
});

test("rejects a price unit other than per 1M tokens", () => {
  const raw = { object: "list", data: [{ id: "a/b", pricing: { unit: "1K tokens", input_usd: 1, output_usd: 2 } }] };
  expect(() => uberllm.parseModels(raw)).toThrow();
});

test("maintains existing files only and leaves an unavailable model unchanged", () => {
  expect(uberllm.translateModel(uberllmModel({ id: "some/new-model" }), context({}))).toBeUndefined();

  const existing = authored();
  const translated = uberllm.translateModel(
    uberllmModel({ available: false, pricing: { unit: "1M tokens", input_usd: 3, output_usd: 15 } }),
    context({ "moonshotai/kimi-k3": existing }),
  );
  expect(translated as unknown).toEqual({ id: "moonshotai/kimi-k3", model: existing });
});

test("refuses a truncated catalog so absence cannot read as a mass retirement", async () => {
  const fetcher = (async () => Response.json({ object: "list", data: [uberllmModel()] })) as unknown as typeof fetch;
  await expect(fetchUberLLMModels(fetcher)).rejects.toThrow("below the 50 needed");
});
