import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { boundless, buildBoundlessModel, type BoundlessModel } from "../src/sync/providers/boundless.js";

const row = (overrides: Partial<BoundlessModel> = {}): BoundlessModel => ({
  id: "deepseek/deepseek-v4.1-flash-1017",
  contextTokens: 1_048_576,
  inputPerMillionTokens: 0.24,
  cachedInputPerMillionTokens: 0.0048,
  outputPerMillionTokens: 0.96,
  serving: true,
  supports: ["text", "reasoning", "tool-use"],
  ...overrides,
});
const authored = {
  base_model: "deepseek/deepseek-v4.1-flash-1017",
  limit: { context: 1_000_000, output: 384_000 },
  cost: { input: 0.2, output: 1, cache_read: 0.01 },
} as unknown as ExistingModel;
const lookup = (id: string) => (id === "deepseek/deepseek-v4.1-flash-1017" ? authored : undefined);
const context = { authored: lookup, existing: lookup } as never;

test("Boundless updates token prices and the context window, and keeps the output limit", () => {
  const built = buildBoundlessModel(row(), authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.24, output: 0.96, cache_read: 0.0048 });
  expect(built.limit).toEqual({ context: 1_048_576, output: 384_000 });
});

test("Boundless does not restate a context window the base model already gives", () => {
  const inherited = { base_model: "anthropic/claude-opus-5-5", cost: { input: 4, output: 20 } } as unknown as ExistingModel;
  const built = buildBoundlessModel(row({ contextTokens: 1_000_000 }), inherited, 1_000_000) as unknown as ExistingModel;
  expect(built.limit).toBeUndefined();
});

test("Boundless keeps the authored cache price when the catalog has none", () => {
  const built = buildBoundlessModel(row({ cachedInputPerMillionTokens: null }), authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.24, output: 0.96, cache_read: 0.01 });
});

test("Boundless drops retiring, unserved, unpriced and tool-less rows, and models with no local file", () => {
  expect(boundless.translateModel(row({ retiresAt: "2026-11-26T23:59:00Z" }), context)).toBeUndefined();
  expect(boundless.translateModel(row({ serving: false }), context)).toBeUndefined();
  expect(boundless.translateModel(row({ inputPerMillionTokens: null }), context)).toBeUndefined();
  expect(boundless.translateModel(row({ supports: ["text"] }), context)).toBeUndefined();
  expect(boundless.translateModel(row({ id: "new/model" }), context)).toBeUndefined();
  expect(boundless.translateModel(row(), context)).toMatchObject({ id: "deepseek/deepseek-v4.1-flash-1017" });
});

test("Boundless reports only listed models that have no local file", () => {
  expect(boundless.sourceID(row({ id: "new/model" }))).toBe("new/model");
  expect(boundless.sourceID(row({ id: "old", retiresAt: "2026-11-26T23:59:00Z" }))).toBeUndefined();
});

test("Boundless refuses a catalog with nothing listed", () => {
  expect(() => boundless.parseModels({ data: [] })).toThrow();
  expect(() => boundless.parseModels({ data: [row({ serving: false })] })).toThrow();
  expect(boundless.parseModels({ data: [row()] })).toHaveLength(1);
});
