import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildObscurifyModel, obscurify, type ObscurifyModel } from "../src/sync/providers/obscurify.js";

function obscurifyModel(overrides: Partial<ObscurifyModel> = {}): ObscurifyModel {
  return {
    id: "deepseek/deepseek-v4-flash",
    object: "model",
    owned_by: "deepseek",
    name: "DeepSeek: DeepSeek V4 Flash",
    pricing: { prompt: 1.17e-7, completion: 2.34e-7, input_cache_read: 2.34e-8 },
    context_length: 1_048_576,
    tools: true,
    decisions: false,
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "deepseek/deepseek-v4-flash",
    cost: { input: 0.1183, output: 0.2366 },
    ...overrides,
  } as ExistingModel;
}

const resolved = { tool_call: true, limit: { context: 1_000_000, output: 384_000 } } as ExistingModel;

test("converts per-token prices to dollars per million tokens", () => {
  const built = buildObscurifyModel(obscurifyModel(), authored(), resolved);

  expect(built).toMatchObject({ cost: { input: 0.117, output: 0.234 } });
});

test("adds no cache price to a file that has none", () => {
  const built = buildObscurifyModel(obscurifyModel(), authored(), resolved);

  expect(built.cost?.cache_read).toBeUndefined();
});

test("updates a cache price the file already declares", () => {
  const built = buildObscurifyModel(
    obscurifyModel(),
    authored({ cost: { input: 0.1183, output: 0.2366, cache_read: 0.03 } }),
    resolved,
  );

  expect(built).toMatchObject({ cost: { cache_read: 0.0234 } });
});

test("only lowers the context limit", () => {
  const higher = buildObscurifyModel(obscurifyModel(), authored(), resolved);
  const lower = buildObscurifyModel(obscurifyModel({ context_length: 131_072 }), authored(), resolved);

  expect(higher.limit).toBeUndefined();
  expect(lower.limit).toMatchObject({ context: 131_072 });
});

test("overrides tool support only when the route differs from the lab", () => {
  const same = buildObscurifyModel(obscurifyModel(), authored(), resolved);
  const without = buildObscurifyModel(obscurifyModel({ tools: false }), authored(), resolved);

  expect(same.tool_call).toBeUndefined();
  expect(without.tool_call).toBe(false);
});

test("skips decision models and models without a file", () => {
  const context = { existing: () => resolved, authored: () => authored() };
  const none = { existing: () => undefined, authored: () => undefined };

  expect(obscurify.translateModel(obscurifyModel({ decisions: true }), context)).toBeUndefined();
  expect(obscurify.translateModel(obscurifyModel(), none)).toBeUndefined();
  expect(obscurify.sourceID(obscurifyModel({ decisions: true }))).toBeUndefined();
});
