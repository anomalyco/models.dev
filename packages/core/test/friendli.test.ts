import { expect, test } from "bun:test";

import { friendli, FriendliModel } from "../src/sync/providers/friendli.js";

const model = FriendliModel.parse({
  id: "example/model",
  name: "Example Model",
  created: 1_775_088_000,
  context_length: 128_000,
  max_completion_tokens: 128_000,
  functionality: {
    tool_call: true,
    structured_output: true,
  },
  pricing: {
    input: "0.000001",
    output: "0.000002",
  },
});

test("tracks active Friendli models missing lab metadata", () => {
  expect(friendli.missingModelID(model)).toBe(model.id);
});

test("rejects an empty Friendli catalog", () => {
  expect(() => friendli.parseModels({ data: [] })).toThrow("empty model catalog");
});

test("skips a factored model when its lab metadata cannot be resolved", () => {
  expect(friendli.translateModel(model, {
    existing: () => ({ base_model: "example/missing" }),
    authored: () => ({ base_model: "example/missing" }),
  })).toBeUndefined();
});

test("does not track deprecated Friendli models as missing", () => {
  expect(friendli.missingModelID({
    ...model,
    deprecation_date: "2000-01-01T00:00:00Z",
  })).toBeUndefined();
});
