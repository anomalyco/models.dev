import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildAlibabaModel, flatPrice, type AlibabaModel } from "../src/sync/providers/alibaba.js";

const row = (type: string, price: string, time_band: string | null = "standard") => ({ type, price, price_unit: "Per 1M tokens", time_band });

test("Alibaba reads a flat standard price and skips tiers and time bands", () => {
  expect(flatPrice({ model: "qwen4-max", prices: [{ range_name: "Default", prices: [row("input_token", "1.5"), row("output_token", "4.5")] }] } as AlibabaModel))
    .toEqual({ input: 1.5, output: 4.5, bands: [] });
  expect(flatPrice({ model: "x", prices: [{ range_name: "a", prices: [] }, { range_name: "b", prices: [] }] } as AlibabaModel)).toBeUndefined();
  expect(flatPrice({ model: "x", prices: [{ range_name: "Default", prices: [row("input_token", "1", "peak"), row("output_token", "2", "peak")] }] } as AlibabaModel)).toBeUndefined();
});

test("Alibaba keeps a file price that rounds to the listed one", () => {
  const authored = { base_model: "alibaba/x", cost: { input: 0.0625, output: 1, cache_read: 0.01 } } as unknown as ExistingModel;
  const built = buildAlibabaModel({ input: 0.063, output: 2, bands: [] }, authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.0625, output: 2, cache_read: 0.01 });
});

test("Alibaba updates context bands only where the file has one at the same threshold", () => {
  const model = { model: "qwen3.6-plus", prices: [
    { range_name: "Input<=256k", prices: [row("input_token", "0.5"), row("output_token", "3")] },
    { range_name: "256k<Input<=1m", prices: [row("input_token", "2"), row("output_token", "6")] },
  ] } as AlibabaModel;
  const price = flatPrice(model)!;
  expect(price.bands).toEqual([{ above: 256_000, input: 2, output: 6 }]);
  const banded = { cost: { input: 1, output: 1, tiers: [{ tier: { type: "context", size: 256_000 }, input: 1, output: 1 }] } } as unknown as ExistingModel;
  expect((buildAlibabaModel(price, banded) as unknown as ExistingModel).cost?.tiers?.[0]).toMatchObject({ input: 2, output: 6 });
  expect(buildAlibabaModel(price, { cost: { input: 1, output: 1 } } as unknown as ExistingModel)).toBeUndefined();
});
