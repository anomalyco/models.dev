import { expect, test } from "bun:test";

import { findComments } from "../src/toml-comments.js";

test("findComments attaches own-line comments to the next key or table", () => {
  const lines = [
    'base_model = "moonshotai/kimi-k2.6"',
    "# Toggle: thinking.type = enabled|disabled",
    "reasoning = true",
    "",
    "# Prices from the pricing page",
    "[cost]",
    "input = 1",
    "# nothing follows",
  ];
  expect(findComments(lines)).toEqual([
    { line: 2, key: "reasoning", text: "Toggle: thinking.type = enabled|disabled" },
    { line: 5, key: "cost", text: "Prices from the pricing page" },
    { line: 8, key: "cost", text: "nothing follows" },
  ]);
});

test("findComments attaches trailing comments to the key on that line", () => {
  const lines = [
    "[[reasoning_options]]",
    'type = "toggle" # API: {"chat_template_kwargs": {"thinking": false}}',
    "",
    "[[reasoning_options]]",
    'type = "effort" # reasoning_effort',
    'values = ["low", "high"] # no medium',
    "",
    "[cost] # USD",
    "input = 1 # per MTok",
  ];
  expect(findComments(lines)).toEqual([
    { line: 2, key: "reasoning_options[0].type", text: 'API: {"chat_template_kwargs": {"thinking": false}}' },
    { line: 5, key: "reasoning_options[1].type", text: "reasoning_effort" },
    { line: 6, key: "reasoning_options[1].values", text: "no medium" },
    { line: 8, key: "cost", text: "USD" },
    { line: 9, key: "cost.input", text: "per MTok" },
  ]);
});

test("findComments attaches comments inside a multi-line value to its key", () => {
  const lines = [
    "reasoning_options = [",
    '  { type = "toggle" }, # enable_thinking',
    "  # budget is thinking_budget",
    '  { type = "budget_tokens" },',
    "]",
  ];
  expect(findComments(lines)).toEqual([
    { line: 2, key: "reasoning_options", text: "enable_thinking" },
    { line: 3, key: "reasoning_options", text: "budget is thinking_budget" },
  ]);
});

test("findComments ignores # inside strings", () => {
  const lines = [
    'description = "Docs at https://example.com/models#pricing"',
    "name = 'C# model' # literal string",
    'tag = "say \\"#1\\"" # escaped quote',
    'notes = """',
    "# not a comment",
    '"""',
    "limit.context = 1_000 # after multi-line string",
  ];
  expect(findComments(lines, 10)).toEqual([
    { line: 11, key: "name", text: "literal string" },
    { line: 12, key: "tag", text: "escaped quote" },
    { line: 16, key: "limit.context", text: "after multi-line string" },
  ]);
});
