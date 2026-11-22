import { expect, test } from "bun:test";

import { findPredecessor, inheritCapabilities, withPredecessorCapabilities } from "../src/sync/inherit.js";

const labs = {
  "openai/gpt-6.1-sol": { family: "gpt", release_date: "2026-10-01" },
  "openai/gpt-6.1-sol-fast": { family: "gpt", release_date: "2026-10-01" },
  "openai/gpt-6": { family: "gpt", release_date: "2026-08-01" },
  "openai/gpt-6.2-sol": { family: "gpt", release_date: "2026-11-17" },
  "google/gemini-4": { family: "gemini", release_date: "2026-10-15" },
};
const api = { "chat-completions": {}, responses: {} };
const previous = {
  base_model: "openai/gpt-6.1-sol",
  capabilities: { reasoning: { supported: true, effort: ["low"] }, system_updates: true, tools: { supported: true, updates: ["add"] } },
  api: { "chat-completions": {}, responses: { capabilities: { tools: { freeform: ["text"] } } } },
};
const existing: [string, Record<string, unknown>][] = [
  ["openai/gpt-6.toml", { base_model: "openai/gpt-6", api }],
  ["openai/gpt-6.1-sol-fast.toml", { base_model: "openai/gpt-6.1-sol-fast", api }],
  ["openai/gpt-6.1-sol.toml", previous],
  ["google/gemini-4.toml", { base_model: "google/gemini-4", api }],
];

test("the predecessor is the latest earlier model in the family with the same APIs, base before variant", () => {
  const doc = { base_model: "openai/gpt-6.2-sol", api: structuredClone(api) };
  expect(findPredecessor(doc, existing, labs)?.path).toBe("openai/gpt-6.1-sol.toml");
  expect(findPredecessor({ base_model: "openai/gpt-6.2-sol", api: { responses: {} } }, existing, labs)).toBeUndefined();
});

test("only missing hand-set capabilities are copied, never reasoning controls", () => {
  const doc = {
    base_model: "openai/gpt-6.2-sol",
    capabilities: { reasoning: { supported: true, effort: ["low", "max"] }, tools: { supported: true } },
    api: structuredClone(api),
  } as Record<string, any>;
  expect(inheritCapabilities(doc, previous)).toEqual([
    "capabilities.system_updates", "capabilities.tools.updates", "api.responses.capabilities.tools.freeform",
  ]);
  expect(doc.capabilities.reasoning.effort).toEqual(["low", "max"]);
  expect(doc.api.responses.capabilities.tools.freeform).toEqual(["text"]);
});

test("a new file gets a header line naming where its capabilities came from", () => {
  const content = '# Synced\nschema = 2\nbase_model = "openai/gpt-6.2-sol"\n\n[api.chat-completions]\n\n[api.responses]\n';
  const out = withPredecessorCapabilities(content, existing, labs);
  expect(out).toContain("come from openai/gpt-6.1-sol, this host's previous model in the family.");
  expect(out).toContain("system_updates = true");
});
