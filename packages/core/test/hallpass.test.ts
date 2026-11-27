import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildHallPassModel, hallpass, type HallPassModel } from "../src/sync/providers/hallpass.js";

function hallpassModel(overrides: Partial<HallPassModel> = {}): HallPassModel {
  return {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    provider: "anthropic",
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 5,
    contextLength: 1_000_000,
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "anthropic/claude-opus-5-5",
    cost: { input: 5, output: 25 },
    ...overrides,
  } as ExistingModel;
}

const resolved = { limit: { context: 1_000_000, output: 128_000 } } as ExistingModel;

test("parses models from the public catalog payload", () => {
  const models = hallpass.parseModels({ updatedAt: "2026-11-27T00:00:00Z", models: [hallpassModel()] });

  expect(models).toHaveLength(1);
  expect(models[0]?.id).toBe("claude-opus-5.5");
});

test("updates input and output prices in dollars per million tokens", () => {
  const built = buildHallPassModel(hallpassModel(), authored(), resolved);

  expect(built).toMatchObject({ cost: { input: 4, output: 20 } });
});

test("adds no cache prices to a file that has none", () => {
  const built = buildHallPassModel(hallpassModel(), authored(), resolved);

  expect(built.cost?.cache_read).toBeUndefined();
  expect(built.cost?.cache_write).toBeUndefined();
});

test("updates cache prices the file already declares", () => {
  const built = buildHallPassModel(
    hallpassModel(),
    authored({ cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } }),
    resolved,
  );

  expect(built).toMatchObject({ cost: { cache_read: 0.2, cache_write: 5 } });
});

test("only lowers the context limit", () => {
  const equal = buildHallPassModel(hallpassModel(), authored(), resolved);
  const higher = buildHallPassModel(hallpassModel({ contextLength: 1_048_576 }), authored(), resolved);
  const lower = buildHallPassModel(hallpassModel({ contextLength: 200_000 }), authored(), resolved);

  expect(equal.limit).toBeUndefined();
  expect(higher.limit).toBeUndefined();
  expect(lower.limit).toMatchObject({ context: 200_000 });
});

test("skips models without an authored file", () => {
  const none = { existing: () => undefined, authored: () => undefined };

  expect(hallpass.translateModel(hallpassModel(), none)).toBeUndefined();
});
