import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildOutrunCost, outrun, parseOutrunPricing } from "../src/sync/providers/outrun.js";
import { syncProvider } from "../src/sync/index.js";

function feed(models: unknown[]) {
  return { currency: "USD", generated_at: 1, paused: [], models };
}

const haikuRow = {
  id: "claude-haiku-5-5",
  kind: "text",
  unit: "1M tokens",
  tiers: [
    {
      label: "up to 100k tokens",
      prices: { input: 0.084, output: 0.42, cache_read: 0.0084, cache_write: 0.105, cache_write_1h: 0.168 },
      max_context_tokens: 100000,
    },
    {
      label: "over 100k tokens",
      prices: { input: 0.42, output: 2.1, cache_read: 0.042, cache_write: 0.525, cache_write_1h: 0.84 },
      min_context_tokens: 100001,
    },
  ],
};

const geminiRow = {
  id: "gemini-3.8-flash",
  kind: "text",
  unit: "1M tokens",
  tiers: [{ label: "", prices: { input: 0.315, output: 1.575, cache_read: 0.0315 } }],
};

test("keeps only token-priced text rows", () => {
  const models = parseOutrunPricing(feed([
    geminiRow,
    { id: "some-image-model", kind: "image", unit: "image", tiers: [{ prices: { input: 0.04 } }] },
    { id: "some-video-model", kind: "video", unit: "second", tiers: [{ prices: { output: 0.1 } }] },
  ]));
  expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash"]);
});

test("builds flat cost and context tiers from feed bands", () => {
  const [gemini, haiku] = parseOutrunPricing(feed([geminiRow, haikuRow]));
  expect(buildOutrunCost(gemini!)).toEqual({
    input: 0.315,
    output: 1.575,
    cache_read: 0.0315,
    cache_write: undefined,
    tiers: undefined,
  });
  expect(buildOutrunCost(haiku!)).toEqual({
    input: 0.084,
    output: 0.42,
    cache_read: 0.0084,
    cache_write: 0.105,
    tiers: [{ tier: { type: "context", size: 100_000 }, input: 0.42, output: 2.1, cache_read: 0.042, cache_write: 0.525 }],
  });
});

test("rejects a feed row without exactly one base tier", () => {
  const [model] = parseOutrunPricing(feed([{ ...geminiRow, tiers: [{ prices: { input: 1, output: 2 }, min_context_tokens: 10 }] }]));
  expect(() => buildOutrunCost(model!)).toThrow("Expected exactly one base pricing tier");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratchProvider(files: Record<string, string>, labs: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "outrun-sync-test-"));
  roots.push(root);
  const modelsDir = path.join(root, "providers/outrun/models");
  await mkdir(modelsDir, { recursive: true });
  await Bun.write(path.join(root, "providers/outrun/provider.toml"), await Bun.file("providers/outrun/provider.toml").text());
  for (const lab of labs) {
    await Bun.write(path.join(root, "models", `${lab}.toml`), await Bun.file(`models/${lab}.toml`).text());
  }
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(modelsDir, file), text);
  return modelsDir;
}

test("runner patches prices in place, including both cache-write TTLs, and keeps everything else", async () => {
  const haiku = await Bun.file("providers/outrun/models/claude-haiku-5-5.toml").text();
  const gemini = await Bun.file("providers/outrun/models/gemini-3.8-flash.toml").text();
  const modelsDir = await scratchProvider({
    "claude-haiku-5-5.toml": haiku
      .replace('"1h" = 0.168', '"1h" = 0.2')
      .replace("[cost.text.output]\nprice = 0.42", "[cost.text.output]\nprice = 0.5"),
    "gemini-3.8-flash.toml": gemini.replace("[cost.text.output]\nprice = 1.575", "[cost.text.output]\nprice = 2"),
  }, ["anthropic/claude-haiku-5-5", "google/gemini-3.8-flash"]);
  const provider = { ...outrun, modelsDir, fetchModels: async () => feed([haikuRow, geminiRow]) };

  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 2, deleted: 0 });
  expect(await Bun.file(path.join(modelsDir, "claude-haiku-5-5.toml")).text()).toBe(haiku);
  expect(await Bun.file(path.join(modelsDir, "gemini-3.8-flash.toml")).text()).toBe(gemini);
  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
});

test("does not create files for feed models without a catalog entry", async () => {
  const gemini = await Bun.file("providers/outrun/models/gemini-3.8-flash.toml").text();
  const modelsDir = await scratchProvider({ "gemini-3.8-flash.toml": gemini }, ["google/gemini-3.8-flash"]);
  const provider = { ...outrun, modelsDir, fetchModels: async () => feed([geminiRow, { ...geminiRow, id: "not-in-catalog" }]) };

  expect(await syncProvider(provider)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
});
