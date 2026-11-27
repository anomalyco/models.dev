import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildOpenUncensoredModel,
  openuncensored,
  OpenUncensoredResponse,
  type OpenUncensoredModel,
} from "../src/sync/providers/openuncensored.js";

function openUncensoredModel(overrides: Partial<OpenUncensoredModel> = {}): OpenUncensoredModel {
  return OpenUncensoredResponse.parse({
    object: "list",
    data: [
      {
        id: "glm-5.3-flash-uncensored",
        object: "model",
        owned_by: "heretic",
        pricing: { prompt: "0.00000012", completion: "0.0000005" },
        context_length: 1_048_576,
        available: true,
        ...overrides,
      },
    ],
  }).data[0]!;
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "olafangensan/glm-5.3-flash-heretic",
    cost: { input: 0.2, output: 0.8 },
    ...overrides,
  } as ExistingModel;
}

const resolved = { limit: { context: 1_000_000, input: 1_000_000, output: 131_072 } } as ExistingModel;

test("converts per-token string prices to dollars per million tokens", () => {
  const built = buildOpenUncensoredModel(openUncensoredModel(), authored(), resolved);

  expect(built).toMatchObject({ cost: { input: 0.12, output: 0.5 } });
});

test("keeps a cache price the file already declares", () => {
  const built = buildOpenUncensoredModel(
    openUncensoredModel(),
    authored({ cost: { input: 0.2, output: 0.8, cache_read: 0.02 } }),
    resolved,
  );

  expect(built).toMatchObject({ cost: { input: 0.12, output: 0.5, cache_read: 0.02 } });
});

test("only lowers the context limit, and brings input and output down with it", () => {
  const higher = buildOpenUncensoredModel(openUncensoredModel(), authored(), resolved);
  const lower = buildOpenUncensoredModel(openUncensoredModel({ context_length: 65_536 }), authored(), resolved);

  expect(higher.limit).toBeUndefined();
  expect(lower.limit).toEqual({ context: 65_536, input: 65_536, output: 65_536 });
});

test("rejects an empty model list instead of retiring every model", () => {
  expect(() => OpenUncensoredResponse.parse({ object: "list", data: [] })).toThrow();
});

test("skips models without a file", () => {
  const none = { existing: () => undefined, authored: () => undefined };

  expect(openuncensored.translateModel(openUncensoredModel(), none)).toBeUndefined();
  expect(openuncensored.sourceID(openUncensoredModel())).toBe("glm-5.3-flash-uncensored");
});
