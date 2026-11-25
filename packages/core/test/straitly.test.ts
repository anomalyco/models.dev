import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { buildStraitlyModel, straitly, type StraitlyModel } from "../src/sync/providers/straitly.js";

function straitlyModel(overrides: Partial<StraitlyModel> = {}): StraitlyModel {
  return {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    context: 1_000_000,
    price: { input: 1.2, output: 6, cacheRead: 0.12, cacheWrite: 1.5 },
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "anthropic/claude-sonnet-5-5",
    cost: { input: 1.5, output: 7.5, cache_read: 0.15, cache_write: 1.8 },
    ...overrides,
  } as ExistingModel;
}

test("updates USD/MTok prices and authored cache rates", () => {
  const built = buildStraitlyModel(straitlyModel(), authored());

  expect(built).toMatchObject({
    cost: { input: 1.2, output: 6, cache_read: 0.12, cache_write: 1.5 },
  });
});

test("does not add cache_write to models that only declare cache_read", () => {
  const built = buildStraitlyModel(
    straitlyModel({
      id: "deepseek/deepseek-v4-1-flash",
      context: 1_048_576,
      price: { input: 0.038169, output: 0.152946, cacheRead: 0.00379, cacheWrite: 0.038169 },
    }),
    authored({
      base_model: "deepseek/deepseek-v4.1-flash",
      cost: { input: 0.04, output: 0.16, cache_read: 0.004 },
    }),
  );

  expect(built.cost?.cache_read).toBe(0.00379);
  expect(built.cost?.cache_write).toBeUndefined();
});

test("writes limit.context only when it differs from base_model or is already authored", () => {
  const inherited = buildStraitlyModel(straitlyModel({ context: 1_000_000 }), authored());
  const overridden = buildStraitlyModel(
    straitlyModel({ id: "grok-4.7", context: 524_288 }),
    authored({ base_model: "xai/grok-4.7" }),
  );

  expect(inherited.limit).toBeUndefined();
  expect(overridden.limit).toMatchObject({ context: 524_288 });
});

test("skips models without a local file and rejects truncated catalogs", () => {
  const none = { existing: () => undefined, authored: () => undefined };
  expect(straitly.translateModel(straitlyModel(), none)).toBeUndefined();
  expect(() => straitly.parseModels({ models: [straitlyModel()] })).toThrow(/at least 20/);
});
