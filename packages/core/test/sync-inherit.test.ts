import { expect, test } from "bun:test";

import { findPredecessor, inheritCapabilities, keepInheritedNote, withPredecessorCapabilities } from "../src/sync/inherit.js";

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

test("capabilities the catalog states unsupported are not copied", () => {
  const doc = { base_model: "openai/gpt-6.2-sol", api: structuredClone(api) } as Record<string, any>;
  expect(inheritCapabilities(doc, previous, undefined, false, ["capabilities.system_updates"])).toEqual([
    "capabilities.tools.updates", "api.responses.capabilities.tools.freeform",
  ]);
  expect(doc.capabilities.system_updates).toBeUndefined();
});

test("a new file gets a header line naming where its capabilities came from", () => {
  const content = '# Synced\nschema = 2\nbase_model = "openai/gpt-6.2-sol"\n\n[api.chat-completions]\n\n[api.responses]\n';
  const out = withPredecessorCapabilities(content, existing, labs);
  expect(out).toContain("come from openai/gpt-6.1-sol, this host's previous model in the family.");
  expect(out).toContain("system_updates = true");
});

test("a rewritten header keeps the note naming the predecessor", () => {
  const note = "# Capabilities the catalog doesn't state (capabilities.system_updates) come from openai/gpt-4.1, this host's previous model in the family.";
  const existing = `# Route: native\n${note}\n`;
  expect(keepInheritedNote(existing, "# Route: native\n")).toBe(existing);
  expect(keepInheritedNote(existing, existing)).toBe(existing);
  expect(keepInheritedNote("# Route: native\n", "# Route: native\n")).toBe("# Route: native\n");
  expect(keepInheritedNote(undefined, "")).toBe("");
});

test("copied tool details bring the predecessor's supported flag into a new tools table", () => {
  const doc: Record<string, unknown> = { base_model: "openai/gpt-6.2-sol", capabilities: { structured_output: true } };
  const added = inheritCapabilities(doc, {
    base_model: "openai/gpt-6.1-sol",
    capabilities: { tools: { supported: true, freeform: ["text", "lark", "regex"] } },
  });
  expect(added).toEqual(["capabilities.tools.freeform"]);
  expect((doc.capabilities as { tools: unknown }).tools).toEqual({ freeform: ["text", "lark", "regex"], supported: true });
});

test("a file without API tables matches a predecessor whose only table is the provider's default API, and a reasoning model takes its reasoning field", () => {
  const labs = {
    "thinkingmachines/inkling-small": { family: "inkling-small", release_date: "2026-07-30" },
    "thinkingmachines/inkling-2-small": { family: "inkling-small", release_date: "2026-11-05" },
  };
  const predecessor = {
    base_model: "thinkingmachines/inkling-small",
    capabilities: { system_updates: true },
    api: { "chat-completions": { compatibility: { reasoning_field: "reasoning_content", max_tokens_field: "max_tokens" } } },
  };
  const doc: Record<string, any> = { base_model: "thinkingmachines/inkling-2-small" };
  const existing: [string, Record<string, unknown>][] = [["thinkingmachines/inkling-small.toml", predecessor]];
  expect(findPredecessor(doc, existing, labs)).toBeUndefined();
  expect(findPredecessor(doc, existing, labs, "chat-completions")?.path).toBe("thinkingmachines/inkling-small.toml");
  expect(inheritCapabilities(structuredClone(doc), predecessor, "chat-completions")).toEqual(["capabilities.system_updates"]);
  expect(inheritCapabilities(doc, predecessor, "chat-completions", true)).toEqual([
    "capabilities.system_updates", "api.chat-completions.compatibility.reasoning_field",
  ]);
  expect(doc.api).toEqual({ "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } });
});
