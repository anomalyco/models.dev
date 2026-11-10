import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "../src/sync/providers/openrouter.js";
import { Labs, REPO_ROOT } from "../src/sync2/catalog.js";
import { plan, sync } from "../src/sync2/engine.js";
import { classifyRisk } from "../src/sync2/risk.js";
import type { Change, Observation, Policy, SyncModule } from "../src/sync2/types.js";
import { labHints, namespaceHints } from "../src/sync2/labs.js";
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

test("merge: kinds with only leaves the file's other kinds alone", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[modalities]\ninput = ["text", "image/png", "application/pdf"]\noutput = ["text"]\n'),
  });
  const module = (input: string[]) => provider([{ id: "lab/a", modalities: { input } }], { owns: [{ path: "modalities.input", merge: "kinds", only: ["image", "audio"] }] });
  expect((await plan(module(["text", "image"]), { root })).writes.size).toBe(0);
  const swapped = await plan(module(["text", "audio"]), { root });
  expect(swapped.result.changes[0]!.fields[0]!.after).toEqual(["text", "application/pdf", "audio"]);
});

test("merge: deprecated sets and clears only a deprecated status", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/beta.toml": file("lab/a", 1, 'status = "beta"\n'),
    "providers/host/models/lab/old.toml": file("lab/a", 1, 'status = "deprecated"\n'),
  });
  const owns = [{ path: "status", merge: "deprecated" as const }];
  const { result } = await plan(provider([{ id: "lab/beta", status: null }, { id: "lab/old", status: null }], { owns }), { root });
  expect(result.changes.map((change) => [change.model, change.fields])).toEqual([["lab/old", [{ path: "status", before: "deprecated", after: undefined }]]]);
  const deprecated = await plan(provider([{ id: "lab/beta", status: "deprecated" }, { id: "lab/old", status: "deprecated" }], { owns }), { root });
  expect(deprecated.result.changes.map((change) => change.model)).toEqual(["lab/beta"]);
});

test("merge: tables adds to the file's tables, after the provider's default API when it has none", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/provider.toml": 'name = "Host"\nnpm = "@ai-sdk/openai-compatible"\n',
    "providers/host/models/lab/a.toml": file("lab/a", 1),
    "providers/host/models/lab/b.toml": file("lab/a", 1, "\n[api.responses]\n"),
  });
  const api = { fim: { sdk: { aisdk: "none" } } };
  const { writes } = await plan(provider([{ id: "lab/a", api }, { id: "lab/b", api }], { owns: [{ path: "api", merge: "tables" }] }), { root });
  const tables = (id: string) => Object.keys((Bun.TOML.parse(writes.get(`providers/host/models/${id}.toml`)!) as { api: object }).api);
  expect(tables("lab/a")).toEqual(["chat-completions", "fim"]);
  expect(tables("lab/b")).toEqual(["responses", "fim"]);
});

test("merge: report turns a disagreement into a gap and leaves the file alone", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(true),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[capabilities]\nreasoning = { supported = true, effort = ["low", "high"] }\n'),
  });
  const owns = ["cost.text.input.price", { path: "capabilities.reasoning.effort", merge: "report" as const }];
  const agree = await plan(provider([{ id: "lab/a", cost: { text: { input: { price: 2 } } }, capabilities: { reasoning: { effort: ["low", "high"] } } }], { owns }), { root });
  expect(agree.result.changes.map((change) => change.fields.map((field) => field.path))).toEqual([["cost.text.input.price"]]);
  const disagree = await plan(provider([{ id: "lab/a", cost: { text: { input: { price: 2 } } }, capabilities: { reasoning: { effort: ["high"] } } }], { owns }), { root });
  expect(disagree.writes.size).toBe(0);
  expect(disagree.result.gaps.map(({ kind, missing }) => ({ kind, missing }))).toEqual([{ kind: "update", missing: ["capabilities.reasoning.effort"] }]);
});

test("standalone fields leave base_model files to the lab; capability tables keep supported", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(true),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
  });
  const owns = [{ path: "release_date", standalone: true }, "capabilities.reasoning.supported", "capabilities.reasoning.effort"];
  const { writes } = await plan(provider([{ id: "lab/a", release_date: "2027-01-01", capabilities: { reasoning: { supported: true, effort: ["low"] } } }], { owns }), { root });
  const content = writes.get("providers/host/models/lab/a.toml")!;
  expect(content).not.toContain("release_date");
  expect(content).toContain('reasoning = { supported = true, effort = ["low"] }');
});

test("turning a capability off drops its details", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(true),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[capabilities]\ntools = { supported = true, strict = true }\nreasoning = { supported = true, effort = ["low", "high"] }\n'),
  });
  const owns = ["capabilities.tools.supported", "capabilities.reasoning.supported"];
  const { writes } = await plan(provider([{ id: "lab/a", capabilities: { tools: { supported: false }, reasoning: { supported: false } } }], { owns }), { root });
  const doc = Bun.TOML.parse(writes.get("providers/host/models/lab/a.toml")!) as { capabilities: unknown };
  expect(doc.capabilities).toEqual({ tools: { supported: false }, reasoning: { supported: false } });
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

test("lab hints: namespaces, spellings, overrides and bare names", () => {
  expect(namespaceHints("z-ai/glm-5:free")).toEqual(["zhipuai/glm-5"]);
  expect(namespaceHints("anthropic/claude-opus-4.6-fast")).toEqual([
    "anthropic/claude-opus-4.6-fast",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-opus-4-6-fast",
    "anthropic/claude-opus-4-6",
  ]);
  expect(namespaceHints("meta-llama/llama-3-3-70b")).toEqual(["meta/llama-3-3-70b", "meta/llama-3.3-70b"]);
  expect(namespaceHints("openai/gpt-5.6-sol-pro")).toEqual(["openai/gpt-5.6-sol"]);
  expect(namespaceHints("acme/model")).toEqual([]);
  expect(namespaceHints("~openai/gpt-latest")).toEqual([]);
  expect(labHints("deepseek/deepseek-v4:free")).toEqual(["deepseek/deepseek-v4"]);
  expect(labHints("glm-5")).toEqual(["glm-5", "*/glm-5"]);
});

test("a */name hint matches the one lab file with that name", async () => {
  const root = await catalog({ "models/lab/Unique.toml": lab(false), "models/one/twin.toml": lab(false), "models/two/twin.toml": lab(false) });
  const { result } = await plan(provider([priced("unique", 1, { base: ["*/unique"] }), priced("twin", 1, { base: ["*/twin"] })]), { root });
  expect(result.changes.map((change) => [change.model, change.fields.find((field) => field.path === "base_model")?.after])).toEqual([["unique", "lab/Unique"]]);
  expect(result.gaps.map((gap) => gap.model)).toEqual(["twin"]);
});

test("merge: seed fills a capability detail only while the file doesn't state the capability", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(true),
    "providers/host/models/lab/none.toml": file("lab/a", 1),
    "providers/host/models/lab/off.toml": file("lab/a", 1, '\n[capabilities]\ntools = { supported = true }\nreasoning = { supported = false }\nstructured_output = true\n'),
    "providers/host/models/lab/on.toml": file("lab/a", 1, '\n[capabilities]\nreasoning = { supported = true }\n'),
  });
  const owns = ["capabilities.reasoning.supported", { path: "capabilities.reasoning.toggle", merge: "seed" as const }];
  const observed = (id: string): Observation => ({ id, capabilities: { reasoning: { supported: true, toggle: true } } });
  const { writes } = await plan(provider([observed("lab/none"), observed("lab/off"), observed("lab/on")], { owns }), { root });
  expect([...writes.keys()].sort()).toEqual(["providers/host/models/lab/none.toml", "providers/host/models/lab/off.toml"]);
  expect(writes.get("providers/host/models/lab/none.toml")).toContain("reasoning = { supported = true, toggle = true }");
  // The table keeps its place when it's turned on and seeded in one patch.
  expect(writes.get("providers/host/models/lab/off.toml")).toContain("tools = { supported = true }\nreasoning = { supported = true, toggle = true }\nstructured_output = true");
});

test("merge: kinds with addOnly adds kinds in the lab's formats and never removes one", async () => {
  const labFile = lab(false).replace('input = ["text"]', 'input = ["text", "image/png", "video/mp4"]');
  const root = await catalog({
    "models/lab/a.toml": labFile,
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[modalities]\ninput = ["text", "image/jpeg"]\noutput = ["text"]\n'),
  });
  const module = (input: string[]) => provider([{ id: "lab/a", modalities: { input } }], { owns: [{ path: "modalities.input", merge: "kinds", addOnly: true }] });
  expect((await plan(module(["text"]), { root })).writes.size).toBe(0);
  const added = await plan(module(["text", "video", "audio"]), { root });
  expect(added.result.changes[0]!.fields[0]!.after).toEqual(["text", "image/jpeg", "video/mp4", "audio"]);
});

test("omitLabInput: a new file with its own context window drops the lab's input limit", async () => {
  const labFile = lab(false).replace("context = 128_000", "context = 128_000\ninput = 100_000");
  const root = await catalog({ "models/lab/a.toml": labFile });
  const observed = [priced("lab/a", 1, { limit: { context: 64_000 } }), priced("lab/same", 1, { base: ["lab/a"], limit: { context: 128_000 } })];
  const { writes } = await plan(provider(observed, { owns: ["cost.text.input.price", "cost.text.output.price", "limit.context"], omitLabInput: true }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).toContain('base_model_omit = ["limit.input"]');
  expect(writes.get("providers/host/models/lab/same.toml")).not.toContain("base_model_omit");
});

// The hints replace the old sync's resolveCanonicalBaseModel and
// resolveModelMetadataBaseModel; on every ID in the catalog they pick the same lab.
test("lab hints resolve every catalog ID like the old resolvers", () => {
  const labs = new Labs(REPO_ROOT);
  const pick = (hints: string[]) => hints.map((hint) => labs.find(hint)).find((found) => found !== undefined);
  const ids = new Set<string>();
  for (const file of new Bun.Glob("providers/*/models/**/*.toml").scanSync({ cwd: REPO_ROOT })) ids.add(file.split("/models/")[1]!.slice(0, -".toml".length));
  for (const file of new Bun.Glob("*/*.toml").scanSync({ cwd: path.join(REPO_ROOT, "models") })) {
    ids.add(file.slice(0, -".toml".length));
    ids.add(file.split("/")[1]!.slice(0, -".toml".length));
  }
  const mismatches = [...ids].flatMap((id) => [id, `${id}:free`, id.toUpperCase()]).filter((id) =>
    resolveCanonicalBaseModel(id) !== pick(namespaceHints(id)) || resolveModelMetadataBaseModel(id) !== pick(labHints(id))
  );
  expect(mismatches).toEqual([]);
}, 60_000);

test("merge: kinds adds a kind in the lab's formats, and a list back to the lab's drops the table", async () => {
  const labFile = lab(false).replace('input = ["text"]', 'input = ["text", "image/png", "video/mp4"]');
  const root = await catalog({
    "models/lab/a.toml": labFile,
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[modalities]\ninput = ["text", "image/png"]\noutput = ["text"]\n'),
  });
  const { writes } = await plan(provider([{ id: "lab/a", modalities: { input: ["text", "image", "video"] } }], { owns: [{ path: "modalities.input", merge: "kinds" }] }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).not.toContain("[modalities]");
});

test("createOnly fields are written into new files only", async () => {
  const root = await catalog({ "models/lab/a.toml": lab(false), "providers/host/models/lab/a.toml": file("lab/a", 1) });
  const owns = ["cost.text.input.price", "cost.text.output.price", { path: "name", createOnly: true }];
  const { writes } = await plan(provider([priced("lab/a", 2, { name: "Host A" }), priced("lab/b", 2, { base: ["lab/a"], name: "Host B" })], { owns }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).not.toContain("name =");
  expect(writes.get("providers/host/models/lab/b.toml")).toContain('name = "Host B"');
});

test("merge: refresh updates a value the file sets and never adds one", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/own.toml": file("lab/a", 1, 'name = "Old"\n'),
    "providers/host/models/lab/inherits.toml": file("lab/a", 1),
  });
  const owns = [{ path: "name", merge: "refresh" as const }];
  const { writes } = await plan(provider([{ id: "lab/own", name: "New" }, { id: "lab/inherits", name: "New" }, { id: "lab/new", base: ["lab/a"], name: "New", cost: { text: { input: { price: 1 }, output: { price: 4 } } } }], { owns: [...owns, "cost.text.input.price", "cost.text.output.price"] }), { root });
  expect([...writes.keys()].sort()).toEqual(["providers/host/models/lab/new.toml", "providers/host/models/lab/own.toml"]);
  expect(writes.get("providers/host/models/lab/new.toml")).toContain('name = "New"');
});

test("defaults fill a new file only, and one write price speaks for the first cache TTL", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1).replace("cache = { read = 0.1 }", 'cache = { read = 0.1, write = { "5m" = 1.25, "1h" = 2 } }'),
  });
  const owns = ["cost.text.input.price", "cost.text.input.cache.write", "cost.text.output.price", "limit.output"];
  const write = (value: number) => ({ text: { input: { price: 1, cache: { write: value } }, output: { price: 4 } } });
  const same = await plan(provider([{ id: "lab/a", cost: write(1.25), defaults: { limit: { output: 1 } } }], { owns }), { root });
  expect(same.writes.size).toBe(0);
  const { writes } = await plan(provider([{ id: "lab/a", cost: write(1.5) }, { id: "lab/b", base: ["lab/a"], cost: write(1.5), defaults: { limit: { output: 1_000 } } }], { owns }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).toContain('write = { "5m" = 1.5, "1h" = 2 }');
  expect(writes.get("providers/host/models/lab/b.toml")).toContain("output = 1_000");
});

test("merge: bands replaces context bands, keeping a band's operator and cache TTLs and other overrides", async () => {
  const bands = `
[[cost.text.input.overrides]]
when = { context = { gte = 200_000 } }
price = 2
cache = { read = 0.2, write = { "5m" = 2.5, "1h" = 4 } }

[[cost.text.input.overrides]]
when = { utc_hours = { gte = "16:00" } }
price = 0.5

[[cost.text.input.overrides]]
when = { context = { gt = 500_000 } }
price = 3
`;
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1).replace("[cost.text.output]", `${bands}\n[cost.text.output]`),
  });
  const owns = [{ path: "cost.text.input.overrides", merge: "bands" as const }];
  const band = { when: { context: { gt: 200_000 } }, price: 2.2, cache: { read: 0.2, write: 3 } };
  const { writes } = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: [band] } } } }], { owns }), { root });
  const overrides = (Bun.TOML.parse(writes.get("providers/host/models/lab/a.toml")!) as any).cost.text.input.overrides;
  expect(overrides).toEqual([
    { when: { context: { gte: 200_000 } }, price: 2.2, cache: { read: 0.2, write: { "5m": 3, "1h": 4 } } },
    { when: { utc_hours: { gte: "16:00" } }, price: 0.5 },
  ]);
  const none = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: null } } } }], { owns }), { root });
  expect((Bun.TOML.parse(none.writes.get("providers/host/models/lab/a.toml")!) as any).cost.text.input.overrides).toEqual([{ when: { utc_hours: { gte: "16:00" } }, price: 0.5 }]);
});

test("merge: bands with replaces owns overrides on those conditions, and optional keeps the file's bands", async () => {
  const overrides = `
[[cost.text.input.overrides]]
when = { context = { gt = 200_000 } }
price = 2

[[cost.text.input.overrides]]
when = { service_tier = { equals = "flex" } }
price = 0.5

[[cost.text.input.overrides]]
when = { utc_hours = { gte = "16:00" } }
price = 0.4
`;
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1).replace("[cost.text.output]", `${overrides}\n[cost.text.output]`),
  });
  const owns = [{ path: "cost.text.input.overrides", merge: "bands" as const, replaces: ["service_tier"], optional: true }];
  const read = (writes: Map<string, string | null>) => (Bun.TOML.parse(writes.get("providers/host/models/lab/a.toml")!) as any).cost.text.input.overrides;
  const priority = { when: { service_tier: { equals: "priority" as const } }, price: 2 };
  const tiers = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: [priority] } } } }], { owns }), { root });
  // The file's overrides that stay come first, then the source's.
  expect(read(tiers.writes)).toEqual([
    { when: { context: { gt: 200_000 } }, price: 2 },
    { when: { utc_hours: { gte: "16:00" } }, price: 0.4 },
    priority,
  ]);
  const band = { when: { context: { gt: 272_000 } }, price: 3 };
  const both = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: [band] } } } }], { owns }), { root });
  expect(read(both.writes)).toEqual([{ when: { utc_hours: { gte: "16:00" } }, price: 0.4 }, band]);
  // A condition inside `all` counts too.
  const nested = { when: { all: [{ service_tier: { equals: "flex" as const } }, { context: { gt: 1 } }] }, price: 9 };
  const deep = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: [nested] } } } }], { owns }), { root });
  expect(read(deep.writes)).toEqual([{ when: { context: { gt: 200_000 } }, price: 2 }, { when: { utc_hours: { gte: "16:00" } }, price: 0.4 }, nested]);
  const none = await plan(provider([{ id: "lab/a", cost: { text: { input: { overrides: null } } } }], { owns }), { root });
  expect(read(none.writes)).toEqual([{ when: { utc_hours: { gte: "16:00" } }, price: 0.4 }]);
});

test("rebuild writes the observation's body on the file's base_model and kept paths, and nothing else", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\nstatus = "beta"\n\n[capabilities]\nstructured_output = true\n\n[metadata]\nnote = "kept"\n'),
  });
  const body = (price: number): Observation => ({
    id: "lab/a",
    base: ["lab/a"],
    rebuild: { keep: ["status", "metadata"] },
    v2_only: true,
    name: null,
    cost: { text: { input: { price } } },
  });
  const { writes, result } = await plan(provider([body(2)], { owns: [] }), { root });
  const written = Bun.TOML.parse(writes.get("providers/host/models/lab/a.toml")!) as Record<string, unknown>;
  expect(written).toEqual({ schema: 2, v2_only: true, base_model: "lab/a", status: "beta", metadata: { note: "kept" }, cost: { text: { input: { price: 2 } } } });
  expect(writes.get("providers/host/models/lab/a.toml")).toStartWith("# Source: example\n");
  expect(result.changes[0]!.fields.map((field) => field.path)).toContain("capabilities.structured_output");
  // The same body again changes nothing.
  const rewritten = await catalog({ "models/lab/a.toml": lab(false), "providers/host/models/lab/a.toml": writes.get("providers/host/models/lab/a.toml")! });
  expect((await plan(provider([body(2)], { owns: [] }), { root: rewritten })).writes.size).toBe(0);
  // A new model takes its base from the hints.
  const created = await plan(provider([{ ...body(3), id: "lab/b", base: ["lab/a"] }], { owns: [] }), { root });
  expect(Bun.TOML.parse(created.writes.get("providers/host/models/lab/b.toml")!)).toEqual({ schema: 2, v2_only: true, base_model: "lab/a", cost: { text: { input: { price: 3 } } } });
});

test("reasoning controls a patch changes are written supported, toggle, effort, budget", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(true),
    "providers/host/models/lab/a.toml": file("lab/a", 1, '\n[capabilities]\nreasoning = { supported = true, effort = ["low", "high"] }\n'),
  });
  const owns = ["capabilities.reasoning.toggle", "capabilities.reasoning.effort"];
  const { writes } = await plan(provider([{ id: "lab/a", capabilities: { reasoning: { toggle: true, effort: ["low"] } } }], { owns }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).toContain('reasoning = { supported = true, toggle = true, effort = ["low"] }');
});

test("headers: replace writes the source's header, a function of the written file", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
    "providers/host/models/lab/b.toml": file("lab/a", 2).replace("# Source: example\n", "# Generated\n"),
  });
  const header = (doc: Record<string, unknown>) => `# Generated\n# price ${(doc.cost as any).text.input.price}\n`;
  const { writes, result } = await plan(provider([priced("lab/a", 1, { header }), priced("lab/b", 2, { header })], { headers: "replace" }), { root });
  expect(writes.get("providers/host/models/lab/a.toml")).toStartWith("# Generated\n# price 1\nschema = 2");
  expect(writes.get("providers/host/models/lab/b.toml")).toStartWith("# Generated\n# price 2\nschema = 2");
  expect(result.changes.map((change) => change.fields.map((field) => field.path))).toEqual([["header"], ["header"]]);
});

test("refine finishes an observation with the file it updates and the provider's files", async () => {
  const root = await catalog({
    "models/lab/a.toml": lab(false),
    "providers/host/models/lab/a.toml": file("lab/a", 1),
    "providers/host/models/lab/b.toml": file("lab/a", 2),
  });
  const module = provider([priced("lab/a", 5), priced("lab/b", 5), priced("lab/c", 5, { base: ["lab/a"] })]);
  const seen: Array<[string, boolean, number]> = [];
  module.refine = (observation, file, files) => {
    seen.push([observation.id, file !== undefined, files.size]);
    return observation.id === "lab/a" ? { ...observation, cost: undefined } : observation;
  };
  const { result } = await plan(module, { root });
  expect(seen).toEqual([["lab/a", true, 2], ["lab/b", true, 2], ["lab/c", false, 2]]);
  expect(result.changes.map((change) => [change.kind, change.model])).toEqual([["update", "lab/b"], ["create", "lab/c"]]);
});
