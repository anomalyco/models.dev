import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import { buildNagaAIModel, nagaai, NagaAIModel } from "../src/sync/providers/nagaai.js";

const model = NagaAIModel.parse({
  id: "claude-sonnet-5.5",
  operations: [{ operation: "chat", endpoints: ["chat.completions", "responses", "messages"] }],
  pricing: [
    { meter: "input_token", unit: "token", price: "0.0000015" },
    { meter: "output_token", unit: "token", price: "0.0000075" },
    { meter: "cached_input_token", unit: "token", price: "0.00000015" },
    { meter: "input_token", unit: "token", price: "0.000003", conditions: { input_tokens: { gt: 200000 } } },
  ],
  deprecates_at: null,
});

const authored = {
  base_model: "anthropic/claude-sonnet-5-5",
  cost: { input: 1, output: 5 },
};

const context = {
  existing: (id: string) => (id === model.id ? authored : undefined),
  authored: (id: string) => (id === model.id ? authored : undefined),
};

test("converts per-token catalog prices to per-1M prices without float noise", () => {
  const built = buildNagaAIModel(model, authored) as Record<string, any>;
  expect(built.cost).toEqual({ input: 1.5, output: 7.5, cache_read: 0.15 });
});

test("ignores price rows that apply only to a subset of requests", () => {
  const onlyConditioned = { ...model, pricing: model.pricing.filter((row) => row.conditions !== undefined) };
  const built = buildNagaAIModel(onlyConditioned, authored) as Record<string, any>;
  expect(built.cost).toEqual(authored.cost);
});

test("falls back to the text input meter and leaves a free cache price out", () => {
  const built = buildNagaAIModel(
    {
      ...model,
      pricing: [
        { meter: "input_text_token", unit: "token", price: "0.0000002" },
        { meter: "output_token", unit: "token", price: "0.0000008" },
        { meter: "cached_input_token", unit: "token", price: "0" },
      ],
    },
    authored,
  ) as Record<string, any>;
  expect(built.cost).toEqual({ input: 0.2, output: 0.8 });
});

test("marks a model with an announced shutdown deprecated and clears it when the date is withdrawn", () => {
  const scheduled = buildNagaAIModel({ ...model, deprecates_at: 1_800_000_000 }, authored) as Record<string, any>;
  expect(scheduled.status).toBe("deprecated");
  const withdrawn = buildNagaAIModel(model, { ...authored, status: "deprecated" }) as Record<string, any>;
  expect(withdrawn.status).toBeUndefined();
});

test("updates only authored chat models", () => {
  expect(nagaai.translateModel(model, context)?.id).toBe("claude-sonnet-5.5");
  expect(nagaai.translateModel({ ...model, id: "new-model" }, context)).toBeUndefined();
  const image = { ...model, operations: [{ operation: "image_generation", endpoints: ["images.generations"] }] };
  expect(nagaai.sourceID(image)).toBeUndefined();
  expect(nagaai.translateModel(image, context)).toBeUndefined();
});

test("rejects a catalog in another format", () => {
  expect(() => nagaai.parseModels({ models: [] })).toThrow();
  expect(() => nagaai.parseModels({ data: [{ id: "x" }] })).toThrow();
});

test("sync rewrites prices and status of an authored model and keeps its other fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-nagaai-"));
  const modelsDir = path.join(dir, "providers", "nagaai", "models");
  const file = path.join(modelsDir, "claude-sonnet-5.5.toml");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(dir, "models", "anthropic"), { recursive: true });
  await copyFile(
    path.join(import.meta.dirname, "..", "..", "..", "models", "anthropic", "claude-sonnet-5-5.toml"),
    path.join(dir, "models", "anthropic", "claude-sonnet-5-5.toml"),
  );
  await Bun.write(
    file,
    [
      "schema = 2",
      'base_model = "anthropic/claude-sonnet-5-5"',
      "",
      "[api.responses]",
      "",
      "[cost.text.input]",
      "price = 1",
      "",
      "[cost.text.output]",
      "price = 5",
      "",
    ].join("\n"),
  );

  try {
    const result = await syncProvider({
      ...nagaai,
      modelsDir,
      async fetchModels() {
        return { data: [{ ...model, deprecates_at: 1_800_000_000 }] };
      },
    });

    expect(result).toMatchObject({ updated: 1 });
    const content = await readFile(file, "utf8");
    expect(content).toContain("price = 1.5");
    expect(content).toContain("price = 7.5");
    expect(content).toContain('status = "deprecated"');
    expect(content).toContain("[api.responses]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
