import { expect, test } from "bun:test";

import { formatToml, preserveReasoningOptions } from "../src/sync/index.js";

test("formats interleaved as a root field before reasoning option tables", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    interleaved: true,
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("formats empty reasoning options outside the interleaved table", () => {
  const content = formatToml({
    id: "example/model",
    name: "Example Model",
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [],
    tool_call: true,
    interleaved: { field: "reasoning_content" },
    open_weights: false,
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  });

  expect(Bun.TOML.parse(content)).toMatchObject({
    interleaved: { field: "reasoning_content" },
    reasoning_options: [],
  });
});

test("defaults new reasoning models to empty reasoning options", () => {
  expect(preserveReasoningOptions({ reasoning: true }, undefined)).toEqual({
    reasoning: true,
    reasoning_options: [],
  });
});
