import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildZurelayModel, zurelay, type ZurelayModel } from "../src/sync/providers/zurelay.js";

function feedModel(overrides: Partial<ZurelayModel> = {}): ZurelayModel {
  return {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    kind: "chat",
    context_window: 1_050_000,
    price: { input_per_1m: 0.6, output_per_1m: 3, cached_input_per_1m: 0.06 },
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "openai/gpt-6-sol",
    cost: { input: 0.5, output: 2.5, cache_read: 0.05 },
    ...overrides,
  } as ExistingModel;
}

const resolved = { limit: { context: 1_050_000, output: 128_000 } } as ExistingModel;

test("takes input, output and cache read prices from the feed", () => {
  const built = buildZurelayModel(feedModel(), authored(), resolved);

  expect(built).toMatchObject({ cost: { input: 0.6, output: 3, cache_read: 0.06 } });
});

test("adds no cache price to a file that has none", () => {
  const built = buildZurelayModel(feedModel(), authored({ cost: { input: 0.5, output: 2.5 } }), resolved);

  expect(built.cost?.cache_read).toBeUndefined();
});

test("bills cache reads at the input price when the feed lists no cheaper one", () => {
  const model = feedModel({ price: { input_per_1m: 0.6, output_per_1m: 3 } });
  const built = buildZurelayModel(model, authored(), resolved);

  expect(built.cost?.cache_read).toBe(0.6);
});

test("moves long-prompt tiers with the base prices", () => {
  const tiered = authored({
    cost: {
      input: 0.5,
      output: 2.5,
      cache_read: 0.05,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 1, output: 3.75, cache_read: 0.1 }],
    },
  });
  const built = buildZurelayModel(feedModel(), tiered, resolved);

  expect(built.cost?.tiers).toEqual([
    { tier: { type: "context", size: 272_000 }, input: 1.2, output: 4.5, cache_read: 0.12 },
  ]);
});

test("moves cache writes with the input price", () => {
  const claude = authored({ base_model: "anthropic/claude-opus-5-5", cost: { input: 1.4, output: 7, cache_read: 0.07, cache_write: 1.75 } });
  const model = feedModel({ id: "claude-opus-5-5", price: { input_per_1m: 1.6, output_per_1m: 8, cached_input_per_1m: 0.08 } });
  const built = buildZurelayModel(model, claude, resolved);

  expect(built.cost).toMatchObject({ input: 1.6, cache_read: 0.08, cache_write: 2 });
});

test("only lowers the context limit, and caps output to fit", () => {
  const higher = buildZurelayModel(feedModel({ context_window: 2_000_000 }), authored(), resolved);
  const lower = buildZurelayModel(feedModel({ context_window: 100_000 }), authored(), resolved);

  expect(higher.limit).toBeUndefined();
  expect(lower.limit).toMatchObject({ context: 100_000, output: 100_000 });
});

test("skips non-chat models and models without a file", () => {
  const context = { existing: () => resolved, authored: () => authored() };
  const none = { existing: () => undefined, authored: () => undefined };

  expect(zurelay.translateModel(feedModel({ kind: "image" }), context)).toBeUndefined();
  expect(zurelay.translateModel(feedModel(), none)).toBeUndefined();
  expect(zurelay.sourceID(feedModel({ kind: "video" }))).toBeUndefined();
  expect(zurelay.sourceID(feedModel())).toBe("gpt-6-sol");
});

test("refuses a feed too short to be the full list", () => {
  const feed = (count: number) => ({
    currency: "USD",
    models: Array.from({ length: count }, (_, index) => feedModel({ id: `model-${index}` })),
  });

  expect(() => zurelay.parseModels(feed(5))).toThrow("only 5 chat models");
  expect(zurelay.parseModels(feed(20))).toHaveLength(20);
});
