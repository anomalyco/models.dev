import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildCerebrasModel, cerebras, type CerebrasModel } from "../src/sync/providers/cerebras.js";

const row = (overrides: Partial<CerebrasModel> = {}): CerebrasModel => ({
  id: "gpt-oss-120b",
  pricing: { prompt: "0.0000004", completion: "0.0000008" },
  deprecated: false,
  ...overrides,
});

const authored = {
  base_model: "openai/gpt-oss-120b",
  limit: { context: 131_072, output: 40_960 },
  cost: { input: 0.35, output: 0.75, cache_read: 0.35 },
} as unknown as ExistingModel;

test("Cerebras updates token prices and keeps everything else", () => {
  const built = buildCerebrasModel(row(), authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.4, output: 0.8, cache_read: 0.4 });
  expect(built.limit).toEqual({ context: 131_072, output: 40_960 });
});

test("Cerebras skips models with no local file and deprecated rows", () => {
  const context = { authored: (id: string) => (id === "gpt-oss-120b" ? authored : undefined) } as never;
  expect(cerebras.translateModel(row({ id: "new-model" }), context)).toBeUndefined();
  expect(cerebras.translateModel(row({ deprecated: true }), context)).toBeUndefined();
  expect(cerebras.translateModel(row(), context)).toMatchObject({ id: "gpt-oss-120b" });
});

test("Cerebras refuses an empty catalog", () => {
  expect(() => cerebras.parseModels({ object: "list", data: [] })).toThrow();
});
