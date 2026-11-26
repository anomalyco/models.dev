import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildAzureModel, modelKey, parseMeter, parsePartnerMeter, partnerRows, priceRows } from "../src/sync/providers/azure.js";

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

test("Azure reads partner meters by label, kind, route and long-context flag", () => {
  expect(parsePartnerMeter("4.7 Inp glbl L")).toEqual({ label: "4.7", kind: "input", longContext: true, tier: "standard", global: true });
  expect(parsePartnerMeter("K2.7 Code cached DZ")).toMatchObject({ label: "k2.7 code", kind: "cache_read", global: false });
  expect(parsePartnerMeter("V4.1 Flash Output Glbl")).toMatchObject({ label: "v4.1 flash", kind: "output" });
  expect(parsePartnerMeter("Provisioned Managed Global")).toBeUndefined();
});

test("Azure matches partner rows to their file by exact label and converts per-1K prices", () => {
  const item = (skuName: string, unitPrice: number, unitOfMeasure = "1K") => ({ productName: "Azure Deepseek Models", skuName, unitPrice, unitOfMeasure, type: "Consumption" });
  const rows = partnerRows([item("V4 Flash Inp glbl", 0.00019), item("V4 Flash 0731 Inp glbl", 0.00044), item("V4 Flash cached glbl", 0.000028)]);
  expect(rows.get("deepseek-v4-flash")).toEqual([
    { kind: "input", longContext: false, tier: "standard", global: true, usd: 0.19 },
    { kind: "cache_read", longContext: false, tier: "standard", global: true, usd: 0.028 },
  ]);
});

test("Azure reads GPT-6.2's ShCo/LoCo meters but not its 12-hour cache writes", () => {
  expect(parseMeter("6.2-sol LoCo Cd Inp Std Gl")).toEqual({ key: "62sol", kind: "cache_read", longContext: true, tier: "standard", global: true });
  expect(parseMeter("6.2-astra ShCo Opt Std Gl")).toMatchObject({ key: "62astra", kind: "output", longContext: false, tier: "standard" });
  expect(parseMeter("6.2 astra ShCo Cd Wr 12hr Gl")).toBeUndefined();
});

test("Azure prices Kimi K2.5 from its Thinking and cached meters", () => {
  const item = (skuName: string, unitPrice: number) => ({ productName: "Azure Kimi", skuName, unitPrice, unitOfMeasure: "1K", type: "Consumption" });
  const rows = partnerRows([item("K2.5 Thinking Inp glbl", 0.0006), item("K2.5 cached glbl", 0.0001), item("K2.5 Thinking Outp glbl", 0.003), item("K2.6 Thinking Inp glbl", 0.00095)]);
  const built = buildAzureModel({ id: "kimi-k2.5", prices: rows.get("kimi-k2.5")! }, { cost: { input: 9, output: 9 } } as unknown as ExistingModel) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 0.6, output: 3, cache_read: 0.1 });
});

test("Azure prices Kimi K3.1 Pro including the cached meter that drops Pro", () => {
  const item = (skuName: string, unitPrice: number) => ({ productName: "Azure Kimi", skuName, unitPrice, unitOfMeasure: "1M", type: "Consumption" });
  const rows = partnerRows([item("Kimi 3.1 Pro Inp Glbl", 2.3), item("Kimi 3.1 Cached Inp Glbl", 0.23), item("Kimi 3.1 Pro Outp Glbl", 11.5), item("Kimi 3.1 Pro Inp DZ", 2.53)]);
  const built = buildAzureModel({ id: "kimi-k3.1-pro", prices: rows.get("kimi-k3.1-pro")! }, { cost: { input: 9, output: 9 } } as unknown as ExistingModel) as unknown as ExistingModel;
  expect(built.cost).toEqual({ input: 2.3, output: 11.5, cache_read: 0.23 });
});

test("Azure prices both Grok 4.20 files from the Grok 4.2 meters, not Grok 4.1", () => {
  const item = (skuName: string, unitPrice: number) => ({ productName: "Azure Grok Models", skuName, unitPrice, unitOfMeasure: "1K", type: "Consumption" });
  const rows = partnerRows([item("Grok 4.2 Inp glbl", 0.00125), item("Grok 4.2 Outp glbl", 0.0025), item("Grok 4.2 Inp Dzone", 0.001375), item("Grok 4.1 Inp Glbl", 0.0002)]);
  for (const id of ["grok-4-20-reasoning", "grok-4-20-non-reasoning"]) {
    const built = buildAzureModel({ id, prices: rows.get(id)! }, { cost: { input: 2, output: 6 } } as unknown as ExistingModel) as unknown as ExistingModel;
    expect(built.cost).toEqual({ input: 1.25, output: 2.5 });
  }
});
