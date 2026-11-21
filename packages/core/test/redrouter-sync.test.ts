import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { redrouter } from "../src/sync/providers/redrouter.js";

const source = {
  id: "host-model", context_tokens: 100_000, max_output_tokens: 8_000,
  pricing: { source: "retail", input_usd_per_mtok: "0.28", output_usd_per_mtok: "1.10", cached_input_usd_per_mtok: "0.13" },
};

test("syncs published retail prices and limits while preserving model identity and controls", () => {
  const model = redrouter.parseModels({ models: [source] })[0]!;
  const authored = {
    name: "Host model", release_date: "2026-01", open_weights: false,
    reasoning_options: { effort: ["low", "high"] },
    cost: { input: 1, output: 2, cache_read: 0.5 },
    limit: { context: 50_000, output: 4_000 },
  } as ExistingModel;
  const result = redrouter.translateModel(model, { authored: () => authored, existing: () => authored });
  expect(result?.model).toEqual({
    ...authored,
    cost: { input: 0.28, output: 1.10, cache_read: 0.13 },
    limit: { context: 100_000, output: 8_000 },
  });
});

test("does not create an unknown model or invent prices for an unpriced model", () => {
  const models = redrouter.parseModels({ models: [source, { ...source, pricing: null }] });
  const missing = { authored: () => undefined, existing: () => undefined };
  expect(redrouter.translateModel(models[0]!, missing)).toBeUndefined();
  const existing = { authored: () => ({}), existing: () => ({}) };
  expect(redrouter.translateModel(models[1]!, existing)).toBeUndefined();
});

test("rejects invalid or supplier pricing rather than publishing a zero price", () => {
  expect(() => redrouter.parseModels({ models: [{ ...source, pricing: { ...source.pricing, input_usd_per_mtok: "" } }] })).toThrow();
  expect(() => redrouter.parseModels({ models: [{ ...source, pricing: { ...source.pricing, source: "supplier" } }] })).toThrow();
});
