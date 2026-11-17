import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildUnrestrictedModel,
  unrestricted,
  UnrestrictedResponse,
  type UnrestrictedModel,
} from "../src/sync/providers/unrestricted.js";

function unrestrictedModel(overrides: Partial<UnrestrictedModel> = {}): UnrestrictedModel {
  return {
    id: "qwen3.8-27b-uncensored",
    object: "model",
    pricing: { input: 0.5, cached_input: 0.05, output: 1 },
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "Qwen3.8 27B Uncensored",
    limit: { context: 262_144, output: 32_768 },
    cost: { input: 0.4, output: 0.8, cache_read: 0.04 },
    ...overrides,
  } as ExistingModel;
}

test("takes input, output and cached-input prices from the endpoint", () => {
  const built = buildUnrestrictedModel(unrestrictedModel(), authored());

  expect(built).toMatchObject({ cost: { input: 0.5, output: 1, cache_read: 0.05 } });
});

test("adds no cache price to a file that has none", () => {
  const built = buildUnrestrictedModel(unrestrictedModel(), authored({ cost: { input: 0.4, output: 0.8 } }));

  expect(built.cost?.cache_read).toBeUndefined();
});

test("drops a cache price the endpoint no longer states", () => {
  const built = buildUnrestrictedModel(
    unrestrictedModel({ pricing: { input: 0.5, output: 1 } }),
    authored(),
  );

  expect(built.cost?.cache_read).toBeUndefined();
});

test("keeps hand-authored fields", () => {
  const built = buildUnrestrictedModel(unrestrictedModel(), authored());

  expect(built).toMatchObject({ name: "Qwen3.8 27B Uncensored", limit: { context: 262_144, output: 32_768 } });
});

test("skips models the catalog does not carry", () => {
  const none = { existing: () => undefined, authored: () => undefined };

  expect(unrestricted.translateModel(unrestrictedModel(), none)).toBeUndefined();
});

test("rejects an empty model list", () => {
  expect(() => UnrestrictedResponse.parse({ object: "list", data: [] })).toThrow();
});
