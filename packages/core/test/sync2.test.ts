import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { plan, sync } from "../src/sync2/engine.js";
import { classifyRisk } from "../src/sync2/risk.js";
import type { Change, Observation, Policy, SyncModule } from "../src/sync2/types.js";
import { labCandidates, perMillion, reasoningControls } from "../src/sync2/units.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function lab(reasoning: boolean) {
  return `schema = 2
name = "Example"
description = "Example model"
open_weights = true
release_date = "2026-01-01"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = ${reasoning} }
temperature = true
top_p = true
top_k = false

[limit]
context = 128_000
output = 16_000
`;
}

async function catalog(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "sync2-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) await Bun.write(path.join(root, file), content);
  return root;
}

function provider(observations: Observation[], policy: Partial<Policy> = {}, manages?: SyncModule["manages"]): SyncModule<null> {
  return {
    id: "host",
    name: "Host",
    policy: {
      owns: ["cost.text.input.price", "cost.text.input.cache.read", "cost.text.output.price", { path: "limit.context", merge: "min" }],
      creates: "auto",
      removals: "delete",
      ...policy,
    },
    fetch: async () => null,
    observe: () => observations,
    manages,
  };
}

const priced = (id: string, input: number, extra: Partial<Observation> = {}): Observation => ({
  id,
  base: [id],
  cost: { text: { input: { price: input }, output: { price: input * 4 } } },
  ...extra,
});

const file = (base: string, input: number, extra = "") => `# Source: example
schema = 2
base_model = "${base}"
${extra}
[cost.text.input]
price = ${input}
cache = { read = 0.1 }

[cost.text.output]
price = ${input * 4}
`;

test("updates only owned fields and keeps the header and the rest of the file", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1, "\n[capabilities]\nstructured_output = true\n"),
  });
  const result = await sync(provider([priced("lab/a", 2)]), { root });

  expect(result.changes).toEqual([{
    kind: "update",
    model: "lab/a",
    path: "providers/host/models/lab/a.toml",
    fields: [
      { path: "cost.text.input.price", before: 1, after: 2 },
      { path: "cost.text.output.price", before: 4, after: 8 },
    ],
  }]);
  expect(await Bun.file(path.join(root, "providers/host/models/lab/a.toml")).text()).toBe(`# Source: example
schema = 2
base_model = "lab/a"

[capabilities]
structured_output = true

[cost.text.input]
price = 2
cache = { read = 0.1 }

[cost.text.output]
price = 8
`);
});

test("null removes a value; a value equal to the lab's is left to inheritance; min only lowers", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1, "\n[limit]\ncontext = 100_000\n"),
  });
  const observation = priced("lab/a", 1, {
    cost: { text: { input: { price: 1, cache: { read: null } }, output: { price: 4 } } },
    limit: { context: 128_000 },
  });
  const { result, writes } = await plan(provider([observation]), { root });
  expect(result.changes[0]!.fields).toEqual([{ path: "cost.text.input.cache.read", before: 0.1, after: undefined }]);
  expect(writes.get("providers/host/models/lab/a.toml")).toContain("context = 100_000");

  const lower = await plan(provider([{ ...observation, limit: { context: 64_000 } }]), { root });
  expect(lower.result.changes[0]!.fields).toContainEqual({ path: "limit.context", before: 100_000, after: 64_000 });

  const inherit = await plan(provider([observation], { owns: ["limit.context"] }), { root });
  expect(inherit.result.changes[0]!.fields).toEqual([{ path: "limit.context", before: 100_000, after: 128_000 }]);
  expect(inherit.writes.get("providers/host/models/lab/a.toml")).not.toContain("[limit]");
});

test("creates a base_model file from a lab match, ignoring case", async () => {
  const root = await catalog({ "models/lab/Model-A.toml": lab(false) });
  const { result, writes } = await plan(provider([priced("lab/model-a", 1, { base: ["missing/x", "lab/model-a"] })]), { root });
  expect(result.changes.map((change) => change.kind)).toEqual(["create"]);
  expect(writes.get("providers/host/models/lab/model-a.toml")).toBe(`schema = 2
base_model = "lab/Model-A"

[cost.text.input]
price = 1

[cost.text.output]
price = 4
`);
});

test("a new model without a lab match or reasoning controls is a gap, not a file", async () => {
  const root = await catalog({ "models/lab/thinker.toml": lab(true) });
  const { result, writes } = await plan(provider([priced("lab/unknown", 1), priced("lab/thinker", 1)]), { root });
  expect(writes.size).toBe(0);
  expect(result.gaps.map(({ model, kind, missing }) => ({ model, kind, missing }))).toEqual([
    { model: "lab/thinker", kind: "new", missing: ["capabilities.reasoning"] },
    {
      model: "lab/unknown",
      kind: "new",
      missing: ["base_model", "name", "description", "release_date", "open_weights", "modalities.input", "modalities.output", "capabilities.tools.supported", "capabilities.reasoning.supported", "limit.context", "limit.output"],
    },
  ]);
  expect(result.gaps[0]!.known?.id).toBe("lab/thinker");
});

test("creates: gap reports every new model; creates: never only notes them", async () => {
  const root = await catalog({ "models/lab/a.toml": lab(false) });
  const gaps = await plan(provider([priced("lab/a", 1)], { creates: "gap" }), { root });
  expect(gaps.result.gaps.map((gap) => [gap.model, gap.missing])).toEqual([["lab/a", []]]);
  const never = await plan(provider([priced("lab/a", 1)], { creates: "never" }), { root });
  expect(never.result.gaps).toEqual([]);
  expect(never.result.notices).toEqual(["1 models not in the catalog were skipped (creates: never): `lab/a`"]);
});

test("removals follow the policy and skip files the source doesn't manage", async () => {
  const files = {
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
    "providers/host/models/lab/gone.toml": file("lab/a", 1),
    "providers/host/models/lab/image.toml": file("lab/a", 1),
  };
  const manages = (id: string) => id !== "lab/image";
  const root = await catalog(files);
  const seen = [priced("lab/a", 1)];

  const deleted = await plan(provider(seen, {}, manages), { root });
  expect(deleted.result.changes).toEqual([{ kind: "remove", model: "lab/gone", path: "providers/host/models/lab/gone.toml", fields: [] }]);
  expect(deleted.writes.get("providers/host/models/lab/gone.toml")).toBeNull();

  const deprecated = await plan(provider(seen, { removals: "deprecate" }, manages), { root });
  expect(deprecated.result.changes[0]!.kind).toBe("deprecate");
  expect(deprecated.writes.get("providers/host/models/lab/gone.toml")).toContain('status = "deprecated"');

  const kept = await plan(provider(seen, { removals: "keep" }, manages), { root });
  expect(kept.writes.size).toBe(0);
  expect(kept.result.gaps.map((gap) => [gap.model, gap.kind])).toEqual([["lab/gone", "removal"]]);
});

test("an update that turns reasoning on without controls is a gap", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
  });
  const module = provider([{ id: "lab/a", capabilities: { reasoning: { supported: true } } }], { owns: ["capabilities.reasoning.supported"] });
  const { result, writes } = await plan(module, { root });
  expect(writes.size).toBe(0);
  expect(result.gaps.map(({ kind, missing }) => ({ kind, missing }))).toEqual([{ kind: "update", missing: ["capabilities.reasoning"] }]);
});

test("refuses an empty source when absence deletes, and duplicate IDs", async () => {
  const root = await catalog({ "models/lab/a.toml": lab(false) });
  expect(plan(provider([]), { root })).rejects.toThrow("returned no models");
  expect(plan(provider([priced("lab/a", 1), priced("LAB/A", 1)]), { root })).rejects.toThrow("twice");
});

test("matches a source ID that differs from the file only in case", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/Lab/a.toml": file("lab/a", 1),
  });
  const { result } = await plan(provider([priced("lab/a", 2)]), { root });
  expect(result.changes.map((change) => [change.kind, change.path])).toEqual([["update", "providers/host/models/Lab/a.toml"]]);
  expect(result.notices[0]).toContain("filed as `Lab/a`");
});

test("updateOnly observations never create or report a gap", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
  });
  const { result, writes } = await plan(provider([priced("lab/a", 2, { updateOnly: true }), priced("lab/alias", 2, { updateOnly: true })]), { root });
  expect(result.gaps).toEqual([]);
  expect([...writes.keys()]).toEqual(["providers/host/models/lab/a.toml"]);
});

test("merge: kinds keeps the file's formats and only changes the kinds", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[modalities]\ninput = ["text", "image/png", "image/jpeg"]\noutput = ["text"]\n'),
  });
  const module = (input: string[]) => provider([{ id: "lab/a", modalities: { input } }], { owns: [{ path: "modalities.input", merge: "kinds" }] });
  expect((await plan(module(["text", "image"]), { root })).writes.size).toBe(0);
  const added = await plan(module(["text", "image", "application/pdf"]), { root });
  expect(added.result.changes[0]!.fields).toEqual([
    { path: "modalities.input", before: ["text", "image/png", "image/jpeg"], after: ["text", "image/png", "image/jpeg", "application/pdf"] },
  ]);
});

const change = (kind: Change["kind"], extra: Partial<Change> = {}): Change => ({ kind, model: "m", path: "providers/p/models/m.toml", fields: [], ...extra });

test("risk keeps today's auto-merge limits", () => {
  const many = (kind: Change["kind"], count: number) => Array.from({ length: count }, () => change(kind));
  const risk = (changes: Change[], before = 100, provider = "p") => classifyRisk({ provider, before, changes, gaps: [] });

  expect(risk(many("create", 10)).safe).toBe(true);
  expect(risk(many("create", 11)).reasons).toEqual(["11 models created (limit 10)"]);
  expect(risk([...many("create", 8), ...many("remove", 8)]).reasons).toEqual(["16 models created or deleted (limit 15)"]);
  expect(risk(many("remove", 3), 5).reasons).toEqual(["3 of 5 p models deleted (limit half)"]);
  expect(risk(many("remove", 2), 2).reasons).toContain("leaves p with no models");
  expect(risk(many("remove", 1), 100, "cloudflare-ai-gateway").safe).toBe(false);
  expect(risk([change("update", { reasoning: true })]).safe).toBe(false);
  expect(risk([change("update", { reasoning: true })], 100, "openrouter").safe).toBe(true);
  expect(risk([change("update", { fields: [{ path: "cost.text.input.price", before: 1, after: 2 }] })]).counts.priceChanges).toBe(1);
});

test("shared conversions", () => {
  expect(perMillion("0.00000026")).toBe(0.26);
  expect(perMillion(0.0000033)).toBe(3.3);
  expect(perMillion("free")).toBeUndefined();
  expect(reasoningControls({ effort: ["high", "low", "medium"], toggle: true })).toEqual({ supported: true, toggle: true, effort: ["low", "medium", "high"] });
  expect(reasoningControls({ effort: ["low", "none"], toggle: true })).toEqual({ supported: true, effort: ["none", "low"] });
  expect(labCandidates("Qwen/Qwen3-8B", { qwen: "alibaba" })).toEqual(["alibaba/qwen3-8b", "qwen/qwen3-8b"]);
});
