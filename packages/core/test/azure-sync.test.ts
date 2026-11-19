import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildAzureModel, modelKey, parseMeter, priceRows } from "../src/sync/providers/azure.js";

test("Azure reduces meter and file names to the same model key", () => {
  expect(["6.1-sol", "61sol", "gpt-6.1-sol"].map(modelKey)).toEqual(["61sol", "61sol", "61sol"]);
  expect(modelKey("61 terra")).toBe(modelKey("gpt-6.1-terra"));
});

test("Azure reads kind, context band, tier and route from a meter", () => {
  expect(parseMeter("6.1-sol LongCo Cd Inp Std Gl")).toEqual({ key: "61sol", kind: "cache_read", longContext: true, tier: "standard", global: true });
  expect(parseMeter("61 terra ShortCo Opt std Gl")).toMatchObject({ key: "61terra", kind: "output", tier: "standard" });
  expect(parseMeter("5.6 luna ShortCo Cd Wr PP DZ")).toMatchObject({ kind: "cache_write", tier: "priority", global: false });
  expect(parseMeter("61sol ShCo Cd Wr 12hr Gl")).toBeUndefined();
  expect(parseMeter("5.4 inp Gl")).toBeUndefined();
});

test("Azure updates global standard prices and the long-context band", () => {
  const item = (skuName: string, unitPrice: number) => ({ productName: "Azure OpenAI GPT6", skuName, unitPrice, unitOfMeasure: "1M", type: "Consumption" });
  const rows = priceRows([
    item("6.1-sol ShortCo Inp Std Gl", 2), item("6.1-sol ShortCo Inp Std DZ", 2.2), item("6.1-sol ShortCo Opt Std Gl", 10),
    item("6.1-sol ShortCo Cd Inp Std Gl", 0.1), item("6.1-sol ShortCo Cd Wr Std Gl", 2.5), item("6.1-sol ShortCo Inp Flex Gl", 1),
    item("6.1-sol LongCo Inp Std Gl", 4), item("6.1-sol LongCo Opt Std Gl", 15), item("6.1-sol LongCo Cd Inp Std Gl", 0.2),
  ]);
  const authored = {
    cost: { input: 9, output: 9, cache_read: 9, cache_write: 9, tiers: [{ tier: { type: "context", size: 272_000 }, input: 9, output: 9, cache_read: 9 }] },
  } as unknown as ExistingModel;
  const built = buildAzureModel({ id: "gpt-6.1-sol", prices: rows.get("61sol")! }, authored) as unknown as ExistingModel;
  expect(built.cost).toEqual({
    input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
    tiers: [{ tier: { type: "context", size: 272_000 }, input: 4, output: 15, cache_read: 0.2 }],
  });
});
