import { expect, test } from "bun:test";

import { limitErrors } from "../src/limits";

test("accepts output and input within the context", () => {
  expect(limitErrors([{ file: "a.toml", limit: { context: 128_000, input: 100_000, output: 128_000 } }])).toEqual([]);
});

test("names the file and both numbers when output exceeds the context", () => {
  expect(limitErrors([{ file: "providers/x/models/y.toml", limit: { context: 8_192, output: 16_384 } }])).toEqual([
    "providers/x/models/y.toml: limit.output (16384) is larger than limit.context (8192)",
  ]);
});

test("flags an input larger than the context", () => {
  expect(limitErrors([{ file: "a.toml", limit: { context: 128_000, input: 272_000 } }])).toEqual([
    "a.toml: limit.input (272000) is larger than limit.context (128000)",
  ]);
});

test("skips entries without a positive context or without the other value", () => {
  expect(
    limitErrors([
      { file: "a.toml", limit: { context: 0, output: 10 } },
      { file: "b.toml", limit: { output: 10 } },
      { file: "c.toml", limit: { context: 10 } },
      { file: "d.toml" },
    ]),
  ).toEqual([]);
});
