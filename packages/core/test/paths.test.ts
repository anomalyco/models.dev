import { expect, test } from "bun:test";

import { pathCollisions } from "../src/paths";

test("accepts paths that are unique when lowercased", () => {
  expect(
    pathCollisions([
      "providers/nearai/models/qwen/qwen3.toml",
      "providers/nearai/models/qwen/qwen3.5.toml",
      "models/qwen/qwen3.toml",
    ]),
  ).toEqual([]);
});

test("flags directories that differ only in case", () => {
  expect(
    pathCollisions(["providers/nearai/models/qwen/a.toml", "providers/nearai/models/Qwen/b.toml"]),
  ).toEqual(["providers/nearai/models/Qwen and providers/nearai/models/qwen"]);
});

test("flags files that differ only in case", () => {
  expect(pathCollisions(["models/x/Model-A.toml", "models/x/model-a.toml"])).toEqual([
    "models/x/Model-A.toml and models/x/model-a.toml",
  ]);
});

test("reports a collision once even when many files sit under it", () => {
  expect(pathCollisions(["p/Qwen/a.toml", "p/qwen/b.toml", "p/qwen/c.toml", "p/Qwen/d.toml"])).toEqual([
    "p/Qwen and p/qwen",
  ]);
});
