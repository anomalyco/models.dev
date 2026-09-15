import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";

import {
  aiand,
  AiandModel,
  AiandResponse,
  buildAiandModel,
  resolveAiandBaseModel,
} from "../src/sync/providers/aiand.js";

function aiandModel(overrides: Partial<AiandModel> = {}): AiandModel {
  return {
    id: "deepseek-ai/deepseek-v4-flash",
    name: "deepseek-ai/DeepSeek-V4-Flash",
    description: "Fast DeepSeek V4 lane for economical reasoning, coding, and long-context work",
    family: "deepseek",
    release_date: "2026-04-24",
    last_updated: "2026-09-14",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
    temperature: true,
    tool_call: true,
    structured_output: true,
    cost: { input: 0.15, output: 0.25, cache_read: 0.08 },
    limit: { context: 1_048_576, output: 384_000 },
    modalities: { input: ["text"], output: ["text"] },
    open_weights: true,
    ...overrides,
  };
}

test("translates a feed model near-identity when nothing is authored", () => {
  const built = buildAiandModel(aiandModel(), undefined, null);
  expect(built).toMatchObject({
    name: "deepseek-ai/DeepSeek-V4-Flash",
    family: "deepseek",
    release_date: "2026-04-24",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
    structured_output: true,
    cost: { input: 0.15, output: 0.25, cache_read: 0.08 },
    limit: { context: 1_048_576, output: 384_000 },
    open_weights: true,
  });
});

test("curated name, knowledge, and last_updated win over the feed", () => {
  const built = buildAiandModel(
    aiandModel(),
    { name: "DeepSeek V4 Flash", knowledge: "2025-05", last_updated: "2026-07-31" },
    null,
  );
  expect(built.name).toBe("DeepSeek V4 Flash");
  expect(built.knowledge).toBe("2025-05");
  expect(built.last_updated).toBe("2026-07-31");
});

test("the feed's last_updated is row-edit noise: today only fills a blank", () => {
  const built = buildAiandModel(aiandModel({ last_updated: undefined }), undefined, null, "2026-09-14");
  expect(built.last_updated).toBe("2026-09-14");
});

test("a curated release_date wins over the feed's", () => {
  const built = buildAiandModel(
    aiandModel({ release_date: "2026-05-01" }),
    { release_date: "2026-04-24" },
    null,
  );
  expect(built.release_date).toBe("2026-04-24");
});

test("a vocabulary miss preserves authored reasoning options instead of publishing none", () => {
  const built = buildAiandModel(
    aiandModel({ reasoning_options: [{ type: "effort", values: ["turbo"] }] }),
    { reasoning_options: [{ type: "effort", values: ["high"] }] },
    null,
  );
  expect(built.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
});

test("a family the enum does not know falls back to the curated value", () => {
  const unknown = buildAiandModel(aiandModel({ family: "not-a-family" }), undefined, null);
  expect(unknown.family).toBeUndefined();
  const curated = buildAiandModel(aiandModel({ family: "not-a-family" }), { family: "deepseek" }, null);
  expect(curated.family).toBe("deepseek");
});

test("unknown modalities are dropped", () => {
  const built = buildAiandModel(
    aiandModel({ modalities: { input: ["text", "smell"], output: ["text"] } }),
    undefined,
    null,
  );
  expect(built.modalities?.input).toEqual(["text"]);
});

test("a reasoner with no schema-valid controls and nothing authored fails instead of writing []", () => {
  const vocabularyMiss = aiandModel({ reasoning_options: [{ type: "effort", values: ["turbo"] }] });
  expect(() => buildAiandModel(vocabularyMiss, undefined, null)).toThrow(MissingReasoningOptionsError);
  const omitted = aiandModel({ reasoning_options: undefined });
  expect(() => buildAiandModel(omitted, undefined, null)).toThrow(MissingReasoningOptionsError);
  // Authored controls are the escape hatch, and an explicit [] is the feed's own assertion.
  expect(buildAiandModel(omitted, { reasoning_options: [{ type: "effort", values: ["high"] }] }, null).reasoning_options)
    .toEqual([{ type: "effort", values: ["high"] }]);
  expect(buildAiandModel(aiandModel({ reasoning_options: [] }), undefined, null).reasoning_options).toEqual([]);
});

test("omitted reasoning_options assert nothing: authored options stay", () => {
  const built = buildAiandModel(aiandModel({ reasoning_options: undefined }), {
    reasoning_options: [{ type: "effort", values: ["high"] }],
  });
  expect(built.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
});

test("an explicit empty list asserts no caller controls and is written as-is", () => {
  const built = buildAiandModel(
    aiandModel({ reasoning_options: [] }),
    { reasoning_options: [{ type: "effort", values: ["high"] }] },
    null,
  );
  expect(built.reasoning_options).toEqual([]);
});

test("parseModels refuses an empty feed instead of authorizing catalog deletion", () => {
  expect(() => aiand.parseModels({ aiand: { models: {} } })).toThrow(/refusing an empty feed/);
});

test("modalities keep canonical order regardless of feed order", () => {
  const built = buildAiandModel(
    aiandModel({ modalities: { input: ["video", "text", "pdf", "image"], output: ["text"] } }),
    undefined,
    null,
  );
  expect(built.modalities?.input).toEqual(["text", "image", "video", "pdf"]);
});

test("factors against an authored base_model and never overrides family", () => {
  const built = buildAiandModel(aiandModel(), {
    base_model: "deepseek/deepseek-v4-flash",
    base_model_omit: ["limit.input"],
  });
  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash",
    base_model_omit: ["limit.input"],
  });
  expect("family" in built ? built.family : undefined).toBeUndefined();
});

test("a curated alpha/beta survives a feed that omits status; a feed status wins", () => {
  const kept = buildAiandModel(aiandModel(), { status: "beta" }, null);
  expect(kept.status).toBe("beta");
  const overridden = buildAiandModel(aiandModel({ status: "deprecated" }), { status: "beta" }, null);
  expect(overridden.status).toBe("deprecated");
});

test("the feed owns deprecation: an omitted status clears a curated deprecated", () => {
  const reactivated = buildAiandModel(aiandModel(), { status: "deprecated" }, null);
  expect(reactivated.status).toBeUndefined();
});

test("skippedNotice stays silent on a clean sync", () => {
  expect(aiand.skippedNotice([])).toEqual([]);
  expect(aiand.skippedNotice(["unknown-lab/mystery-9"])).toHaveLength(1);
});

test("authored-only cost fields ride along; feed prices are authoritative", () => {
  const built = buildAiandModel(
    aiandModel(),
    { cost: { input: 9, output: 9, cache_write: 0.5 }, limit: { context: 1, input: 128_000, output: 1 } },
    null,
  );
  expect(built.cost).toMatchObject({ input: 0.15, output: 0.25, cache_write: 0.5 });
  expect(built.limit).toEqual({ context: 1_048_576, input: 128_000, output: 384_000 });
});

test("a non-reasoning feed model omits reasoning_options entirely", () => {
  const built = buildAiandModel(
    aiandModel({ reasoning: false, reasoning_options: undefined }),
    undefined,
    null,
  );
  expect(built.reasoning).toBe(false);
  expect(built.reasoning_options).toBeUndefined();
});

test("a new feed id resolves its lab base model despite a different lab prefix", () => {
  expect(resolveAiandBaseModel("deepseek-ai/deepseek-v4-flash", "DeepSeek V4 Flash")).toBe(
    "deepseek/deepseek-v4-flash",
  );
  expect(resolveAiandBaseModel("openai/gpt-oss-120b", "GPT OSS 120B")).toBe("openai/gpt-oss-120b");
  expect(resolveAiandBaseModel("unknown-lab/mystery-9", "Mystery 9")).toBeUndefined();
});

test("translateModel skips a new id with no resolvable base instead of writing a full definition", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const skipped = aiand.translateModel(
    aiandModel({ id: "unknown-lab/mystery-9", name: "Mystery 9" }),
    context,
  );
  expect(skipped).toBeUndefined();

  const resolved = aiand.translateModel(aiandModel(), context);
  expect(resolved?.model).toMatchObject({ base_model: "deepseek/deepseek-v4-flash" });
});

test("a new factored file inherits every lab-owned field instead of asserting the feed's", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const created = aiand.translateModel(
    aiandModel({ description: "gateway blurb", release_date: "2099-01-01", open_weights: false }),
    context,
  );
  expect(created?.model).toMatchObject({ base_model: "deepseek/deepseek-v4-flash" });
  for (const field of ["name", "description", "family", "release_date", "last_updated", "open_weights"]) {
    expect(created?.model).not.toHaveProperty(field);
  }
});

test("a curated description wins over the feed's on a standalone file", () => {
  const built = buildAiandModel(aiandModel(), { description: "curated" }, null);
  expect(built.description).toBe("curated");
});

test("non-effort controls parse but are never written: ai& has no toggle or budget wire path", () => {
  const model = AiandModel.parse({
    ...aiandModel(),
    reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 32_768 }, { type: "effort", values: ["high"] }],
  });
  expect(buildAiandModel(model, undefined, null).reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);

  // Dropping them can't leave an invented [] behind: with nothing authored the model fails for review.
  const toggleOnly = AiandModel.parse({ ...aiandModel(), reasoning_options: [{ type: "toggle" }] });
  expect(() => buildAiandModel(toggleOnly, undefined, null)).toThrow(MissingReasoningOptionsError);

  // A stale authored toggle is not carried forward on update either.
  const authoredStale = { reasoning_options: [{ type: "toggle" as const }, { type: "effort" as const, values: ["high" as const] }] };
  expect(buildAiandModel(aiandModel({ reasoning_options: undefined }), authoredStale, null).reasoning_options)
    .toEqual([{ type: "effort", values: ["high"] }]);
});

test("a new reasoner gets the gateway's reasoning_content side channel; feed and authored values win over it", () => {
  const created = buildAiandModel(aiandModel(), undefined, null);
  expect(created.interleaved).toEqual({ field: "reasoning_content" });
  const authored = buildAiandModel(aiandModel(), { interleaved: true }, null);
  expect(authored.interleaved).toBe(true);
  const fromFeed = buildAiandModel(
    AiandModel.parse({ ...aiandModel(), interleaved: { field: "reasoning_details" } }),
    { interleaved: true },
    null,
  );
  expect(fromFeed.interleaved).toEqual({ field: "reasoning_details" });
  const nonReasoner = buildAiandModel(
    aiandModel({ reasoning: false, reasoning_options: undefined }),
    { interleaved: true },
    null,
  );
  expect(nonReasoner.interleaved).toBeUndefined();
});

test("an unresolvable new id enters the missing-model issue flow", () => {
  expect(aiand.missingModelID(aiandModel({ id: "unknown-lab/mystery-9" }))).toBe("unknown-lab/mystery-9");
});

test("first factor of a full-inline file inherits the lab entry instead of re-emitting its stale lab fields", () => {
  const fullInline = {
    name: "Motif 3",
    description: "old inline description",
    release_date: "2026-08-12",
    last_updated: "2026-09-11",
    attachment: false,
    reasoning: true,
    temperature: false,
    tool_call: false,
    structured_output: false,
    open_weights: false,
    reasoning_options: [],
    interleaved: { field: "reasoning_content" as const },
    cost: { input: 0.5, output: 2 },
    limit: { context: 262_144, output: 262_144 },
    modalities: { input: ["text" as const], output: ["text" as const] },
  };
  const built = buildAiandModel(
    aiandModel({
      id: "motif-technologies/motif-3",
      name: "Motif-Technologies/Motif-3",
      reasoning_options: [{ type: "effort", values: ["none", "high"] }],
      structured_output: false,
      cost: { input: 0.5, output: 2, cache_read: 0.2 },
      limit: { context: 262_144, output: 262_144 },
    }),
    fullInline,
    "motif-technologies/motif-3",
  );
  expect(built).toMatchObject({ base_model: "motif-technologies/motif-3" });
  for (const field of ["name", "description", "release_date", "last_updated", "open_weights", "family", "temperature", "tool_call"]) {
    expect(built).not.toHaveProperty(field);
  }
  expect(built).toMatchObject({ cost: { cache_read: 0.2 }, interleaved: { field: "reasoning_content" } });
});

test("an already-factored file keeps its authored lab-field deltas and omit list", () => {
  const built = buildAiandModel(aiandModel(), {
    base_model: "deepseek/deepseek-v4-flash",
    base_model_omit: ["limit.input"],
    name: "DeepSeek V4 Flash (ai& lane)",
    knowledge: "2025-06",
  });
  // Deltas that differ from the lab entry survive; identical values would be
  // dropped by factoring as redundant, which is the point.
  expect(built).toMatchObject({
    base_model: "deepseek/deepseek-v4-flash",
    base_model_omit: ["limit.input"],
    name: "DeepSeek V4 Flash (ai& lane)",
    knowledge: "2025-06",
  });
});

test("a created reasoner gets a leading header naming the single effort wire path and no other control", () => {
  const context = { existing: () => undefined, authored: () => undefined };
  const created = aiand.translateModel(
    AiandModel.parse({ ...aiandModel(), reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }] }),
    context,
  );
  expect(created?.header).toContain('# Effort: reasoning_effort = "high" | "max"');
  expect(created?.header).toContain("no separate toggle or token-budget field");
  expect(created?.header).not.toContain("# Toggle:");
  expect(created?.header).not.toContain("# Budget:");
  expect(created?.header?.endsWith("\n")).toBe(true);
});

test("runner-level: a full-inline file factored for the first time is written without a lab-identical description", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-aiand-"));
  const modelsDir = path.join(root, "providers", "aiand", "models");
  const labSource = path.join(import.meta.dirname, "..", "..", "..", "models", "motif-technologies", "motif-3.toml");
  const labDest = path.join(root, "models", "motif-technologies", "motif-3.toml");
  await mkdir(path.dirname(labDest), { recursive: true });
  await copyFile(labSource, labDest);
  const providerFile = path.join(modelsDir, "motif-technologies", "motif-3.toml");
  await mkdir(path.dirname(providerFile), { recursive: true });
  await Bun.write(providerFile, [
    "# First-party Motif host entry (no shared lab base_model in catalog yet).",
    'name = "Motif 3"',
    'description = "Motif 3 is a large-scale, decoder-only Mixture-of-Experts (MoE) language model with 314 billion total parameters and 13.2 billion parameters activated per token."',
    'release_date = "2026-08-12"',
    'last_updated = "2026-09-11"',
    "attachment = false",
    "reasoning = true",
    "temperature = false",
    "tool_call = false",
    "structured_output = false",
    "open_weights = false",
    "",
    "[[reasoning_options]]",
    'type = "effort"',
    'values = ["none", "high"]',
    "",
    "[interleaved]",
    'field = "reasoning_content"',
    "",
    "[cost]",
    "input = 0.5",
    "output = 2",
    "",
    "[limit]",
    "context = 262_144",
    "output = 262_144",
    "",
    "[modalities]",
    'input = ["text"]',
    'output = ["text"]',
    "",
  ].join("\n"));

  const feed = aiandModel({
    id: "motif-technologies/motif-3",
    name: "Motif-Technologies/Motif-3",
    reasoning_options: [{ type: "effort", values: ["none", "high"] }],
    structured_output: false,
    cost: { input: 0.5, output: 2, cache_read: 0.2 },
    limit: { context: 262_144, output: 262_144 },
  });
  await syncProvider(
    { ...aiand, modelsDir, fetchModels: async () => ({ aiand: { models: { [feed.id]: feed } } }) },
    { openIssues: false },
  );

  const written = await readFile(providerFile, "utf8");
  expect(written).toContain('base_model = "motif-technologies/motif-3"');
  expect(written).not.toMatch(/^description = /m);
  expect(written).not.toMatch(/^open_weights = /m);
  expect(written).not.toMatch(/^release_date = /m);
  expect(written).toContain("cache_read = 0.2");
  expect(written).toContain('field = "reasoning_content"');
  expect(written.startsWith("# First-party Motif host entry")).toBe(true);
});

test("runner-level: a reasoner the feed leaves without controls is reported and its local file is left untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-aiand-missing-"));
  const modelsDir = path.join(root, "providers", "aiand", "models");
  const labDest = path.join(root, "models", "motif-technologies", "motif-3.toml");
  await mkdir(path.dirname(labDest), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "..", "..", "..", "models", "motif-technologies", "motif-3.toml"), labDest);
  const providerFile = path.join(modelsDir, "motif-technologies", "motif-3.toml");
  await mkdir(path.dirname(providerFile), { recursive: true });
  const original = ['base_model = "motif-technologies/motif-3"', "", "[cost]", "input = 0.5", "output = 2", ""].join("\n");
  await Bun.write(providerFile, original);

  const feed = aiandModel({ id: "motif-technologies/motif-3", name: "Motif-Technologies/Motif-3", reasoning_options: undefined });
  const result = await syncProvider(
    { ...aiand, modelsDir, fetchModels: async () => ({ aiand: { models: { [feed.id]: feed } } }) },
    { openIssues: false },
  );

  expect(await readFile(providerFile, "utf8")).toBe(original);
  expect(result.notices.join(" ")).toContain("motif-technologies/motif-3");
  expect(result.notices.join(" ")).toContain("no authored controls");
});

test("parses the provider entry from the full api.json document", () => {
  const parsed = AiandResponse.parse({
    opencode: { models: {} },
    aiand: { models: { "deepseek-ai/deepseek-v4-flash": aiandModel() } },
  });
  expect(Object.keys(parsed.aiand.models)).toEqual(["deepseek-ai/deepseek-v4-flash"]);
});
