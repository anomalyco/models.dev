import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildNebiusModel, nebius, type NebiusFlavor } from "../src/sync/providers/nebius.js";

const flavor = (overrides: Partial<NebiusFlavor> = {}): NebiusFlavor => ({
  model_id: "moonshotai/Kimi-K3",
  input_price_per_million_tokens: 3,
  input_cached_price_per_million_tokens: 0.3,
  output_price_per_million_tokens: 15,
  ...overrides,
});
const authored = { base_model: "moonshotai/kimi-k3", limit: { context: 1_024_000, output: 8_000 }, cost: { input: 2, output: 10 } } as unknown as ExistingModel;

test("Nebius updates token prices and keeps limits", () => {
  const built = buildNebiusModel(flavor(), authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 3, output: 15, cache_read: 0.3 });
  expect(built.limit).toEqual({ context: 1_024_000, output: 8_000 });
});

test("Nebius skips deprecated rows and models with no local file", () => {
  const context = { authored: (id: string) => (id === "moonshotai/Kimi-K3" ? authored : undefined) } as never;
  expect(nebius.translateModel(flavor({ deprecated: true }), context)).toBeUndefined();
  expect(nebius.translateModel(flavor({ model_id: "new/model" }), context)).toBeUndefined();
  expect(nebius.translateModel(flavor(), context)).toMatchObject({ id: "moonshotai/Kimi-K3" });
});

test("Nebius refuses an empty catalog", () => {
  expect(() => nebius.parseModels([])).toThrow();
});
