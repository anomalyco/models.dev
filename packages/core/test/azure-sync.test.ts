import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildAzureModel, modelKey, parseFireworksMeter, parseMeter, parsePartnerMeter, partnerRows, priceRows } from "../src/sync/providers/azure.js";

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

test("Azure reads Fireworks meters with the route before, after or as a suffix", () => {
  expect(parseFireworksMeter("FW DS-V4.1-Flash Gl Cd Inp")).toEqual({ label: "fwdsv41flash", kind: "cache_read", longContext: false, tier: "standard", global: true });
  expect(parseFireworksMeter("FW DS V4.1 Flash Inp - US DZ")).toMatchObject({ label: "fwdsv41flash", kind: "input", global: false });
  expect(parseFireworksMeter("FW GLM 5.3 Inp")).toMatchObject({ label: "fwglm53", kind: "input", global: true });
  expect(parseFireworksMeter("FW GLM 5.3 DZ Opt")).toMatchObject({ label: "fwglm53", kind: "output", global: false });
  expect(parseFireworksMeter("FW Kimi K3 Cd Inp DZ")).toMatchObject({ label: "fwkimik3", kind: "cache_read", global: false });
  expect(parseFireworksMeter("Kimi K3.1 Pro Opt- Global")).toMatchObject({ label: "kimik31pro", kind: "output", global: true });
  expect(parseFireworksMeter("Kimi K3.1 Pro Cd inp - Global")).toMatchObject({ label: "kimik31pro", kind: "cache_read", global: true });
  expect(parseFireworksMeter("FW NVIDIA Nemotron 3.5 LN Cd In DZ")).toMatchObject({ label: "fwnvidianemotron35ln", kind: "cache_read", global: false });
  expect(parseFireworksMeter("Provisioned Managed Global")).toBeUndefined();
  expect(parseFireworksMeter("FW MiniMax 3 Outp DZ")).toBeUndefined();
});

test("Azure prices Fireworks models from real meters, data-zone-only ones from their data-zone rows", () => {
  // eastus2 rows from https://prices.azure.com/api/retail/prices, product Azure Fireworks Models (2026-11-27).
  const item = (skuName: string, unitPrice: number, unitOfMeasure = "1K") => ({ productName: "Azure Fireworks Models", skuName, unitPrice, unitOfMeasure, type: "Consumption" });
  const rows = partnerRows([
    item("FW DS-V4.1-Flash Gl Inp", 0.000375), item("FW DS-V4.1-Flash Gl Cd Inp", 0.000008), item("FW DS-V4.1-Flash Gl Opt", 0.0015),
    item("FW DS V4.1 Flash Inp - US DZ", 0.45, "1M"), item("FW DS V4.1 Flash Cd Inp - US DZ", 0.009, "1M"), item("FW DS V4.1 Flash Opt - US DZ", 1.8, "1M"),
    item("FW GLM 5.3 Inp", 0.00175), item("FW GLM 5.3 Cd Inp", 0.000325), item("FW GLM 5.3 Opt", 0.0055), item("FW GLM 5.3 DZ Inp", 0.0021),
    item("FW GLM-5.3-Flash Gl Inp", 0.000188), item("FW GLM-5.3-Flash Gl Cd Inp", 0.000038), item("FW GLM-5.3-Flash Gl Opt", 0.000625),
    item("GLM 5.3 Flash Inp - US DZ", 0.225, "1M"),
    item("FW Kimi-K3 Gl Inp", 0.003), item("FW Kimi-K3 Gl Cd Inp", 0.0003), item("FW Kimi-K3 Gl Opt", 0.015), item("FW Kimi K3 Inp DZ", 0.0033),
    item("Kimi K3.1 Pro Inp - Global", 2.5, "1M"), item("Kimi K3.1 Pro Cd inp - Global", 0.25, "1M"), item("Kimi K3.1 Pro Opt- Global", 12.5, "1M"),
    item("Kimi K3.1 Pro Inp - US DZ", 3, "1M"),
    item("FW NVIDIA Nemotron 3U Inp DZ", 0.00066), item("FW NVIDIA Nemotron 3U Cd Inp DZ", 0.00013), item("FW NVIDIA Nemotron 3U Opt DZ", 0.00264),
    item("FW NVIDIA Nemotron 3.5 LN In DZ", 0.00006), item("FW NVIDIA Nemotron 3.5 LN Cd In DZ", 0.00001), item("FW NVIDIA Nemotron 3.5 LN Opt DZ", 0.00022),
  ]);
  const expected: Record<string, { input: number; output: number; cache_read: number }> = {
    "fw-deepseek-v4.1-flash": { input: 0.375, output: 1.5, cache_read: 0.008 },
    "fw-glm-5.3": { input: 1.75, output: 5.5, cache_read: 0.325 },
    "fw-glm-5.3-flash": { input: 0.188, output: 0.625, cache_read: 0.038 },
    "fw-kimi-k3": { input: 3, output: 15, cache_read: 0.3 },
    "fw-kimi-k3.1-pro": { input: 2.5, output: 12.5, cache_read: 0.25 },
    "fw-nemotron-3-ultra-nvfp4": { input: 0.66, output: 2.64, cache_read: 0.13 },
    "fw-nemotron-lightning-3.5-30b-a3b": { input: 0.06, output: 0.22, cache_read: 0.01 },
  };
  for (const [id, cost] of Object.entries(expected)) {
    const dataZone = id.startsWith("fw-nemotron");
    const built = buildAzureModel({ id, prices: rows.get(id)!, dataZone }, { cost: { input: 9, output: 9 } } as unknown as ExistingModel) as unknown as ExistingModel;
    expect(built.cost).toEqual(cost);
  }
});
