import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type SyncedModel } from "../src/sync/index.js";
import { IncompleteModelError } from "../src/sync/incomplete-model.js";
import { cloudflareAiGateway } from "../src/sync/providers/cloudflare-ai-gateway.js";

function source(id: string, pricing: Record<string, number> = { "Input tokens (per 1M)": 2, "Output tokens (per 1M)": 8 }) {
  return { catalog: { model_id: id, task: "Text Generation" as const, pricing } };
}

async function fixture() {
  const dir = await mkdtemp(path.join(import.meta.dirname, "../../../providers/.incomplete-sync-"));
  const modelsDir = path.join(dir, "models");
  await mkdir(path.join(modelsDir, "anthropic"), { recursive: true });
  const file = path.join(modelsDir, "anthropic/claude-fable-5.1.toml");
  const content = '# Keep authored metadata until curation is fixed\nbase_model = "anthropic/claude-fable-5-1"\nreasoning_options = [{ type = "effort", values = ["low", "medium", "high", "xhigh", "max"] }]\n';
  await writeFile(file, content);
  return { dir, modelsDir, file, content };
}

test.each([true, false])("incomplete Cloudflare models do not block valid models (existing entry: %s)", async (existing) => {
  const data = await fixture();
  if (!existing) await rm(data.file);
  try {
    const result = await syncProvider({
      ...cloudflareAiGateway,
      modelsDir: data.modelsDir,
      async fetchModels() {
        return [
          source("anthropic/claude-fable-5.1"),
          source("anthropic/not-a-real-model"),
          source("openai/gpt-4.1-mini", {}),
          source("openai/gpt-4.1"),
        ];
      },
    }, { openIssues: false });

    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0, unchanged: existing ? 1 : 0, incomplete: 3 });
    if (existing) expect(await readFile(data.file, "utf8")).toBe(data.content);
    else expect(await Bun.file(data.file).exists()).toBe(false);
    expect(await Bun.file(path.join(data.modelsDir, "openai/gpt-4.1.toml")).exists()).toBe(true);
    expect(await Bun.file(path.join(data.modelsDir, "anthropic/not-a-real-model.toml")).exists()).toBe(false);
    expect(await Bun.file(path.join(data.modelsDir, "openai/gpt-4.1-mini.toml")).exists()).toBe(false);
    expect(result.notices.join("\n")).toContain("reasoning_options");
    expect(result.notices.join("\n")).toContain("base_model");
    expect(result.notices.join("\n")).toContain("input and output rates");
  } finally {
    await rm(data.dir, { recursive: true, force: true });
  }
});

test.each(["openai/gpt-4.1-mini", "anthropic/claude-fable-5.1", "anthropic/not-a-real-model"])("unexpected Cloudflare pricing fails before writing even with missing metadata: %s", async (id) => {
  const data = await fixture();
  try {
    await expect(syncProvider({
      ...cloudflareAiGateway,
      modelsDir: data.modelsDir,
      async fetchModels() {
        return [source("openai/gpt-4.1"), {
          catalog: {
            ...source(id).catalog,
            pricing: { "New billing unit": 1 },
          },
        }];
      },
    }, { openIssues: false })).rejects.toThrow("unmapped pricing key");
    expect(await readFile(data.file, "utf8")).toBe(data.content);
    expect(await Bun.file(path.join(data.modelsDir, "openai/gpt-4.1.toml")).exists()).toBe(false);
  } finally {
    await rm(data.dir, { recursive: true, force: true });
  }
});

test.each([
  { dryRun: true, openIssues: true },
  { openIssues: false },
  { openIssues: true, trackMissingModels: false },
  { newOnly: true, openIssues: false },
])("incomplete models respect issue and dry-run controls: %j", async (options) => {
  const data = await fixture();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected subprocess"); });
  try {
    const result = await syncProvider({
      ...cloudflareAiGateway,
      modelsDir: data.modelsDir,
      trackMissingModels: options.trackMissingModels,
      async fetchModels() { return [source("anthropic/claude-fable-5.1")]; },
    }, options);
    expect(spawn).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(1);
    expect(result.notices.join("\n")).toContain("reasoning_options");
    expect(await readFile(data.file, "utf8")).toBe(data.content);
  } finally {
    spawn.mockRestore();
    await rm(data.dir, { recursive: true, force: true });
  }
});

test("incomplete models dispatch the issue fixer even when the provider can auto-create models", async () => {
  const data = await fixture();
  const repository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "example/catalog";
  const calls: string[][] = [];
  const spawn = spyOn(Bun, "spawn").mockImplementation((args) => {
    const command = args as string[];
    calls.push(command);
    const stdout = command[1] === "issue" && command[2] === "list" ? "[]"
      : command[1] === "issue" && command[2] === "create" ? "https://github.com/example/catalog/issues/123"
      : "";
    return { stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
  });
  try {
    const result = await syncProvider({
      ...cloudflareAiGateway,
      modelsDir: data.modelsDir,
      async fetchModels() { return [source("anthropic/claude-fable-5.1"), source("openai/gpt-4.1")]; },
    }, { openIssues: true });
    const create = calls.find((args) => args[1] === "issue" && args[2] === "create")!;
    expect(create[create.indexOf("--title") + 1]).toBe("[missing-model] cloudflare-ai-gateway: anthropic/claude-fable-5.1");
    expect(create[create.indexOf("--body") + 1]).toContain("reasoning_options");
    expect(create[create.indexOf("--body") + 1]).toContain("curation.toml");
    expect(calls.find((args) => args[1] === "api")).toContain("client_payload[issue_number]=123");
    expect(result).toMatchObject({ created: 1, incomplete: 1, deleted: 0 });
    expect(result.notices.join("\n")).toContain("dispatched the issue fixer");
  } finally {
    spawn.mockRestore();
    if (repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = repository;
    await rm(data.dir, { recursive: true, force: true });
  }
});

test("the shared runner reports missing inherited fields and controls without inventing defaults", async () => {
  const data = await fixture();
  const definitions: Record<string, SyncedModel> = {
    "missing-base": { base_model: "unknown/missing" },
    "missing-output": { base_model: "openai/gpt-4.1", base_model_omit: ["limit.output"] },
    "unknown-controls": { base_model: "anthropic/claude-fable-5-1" },
    "always-on": { base_model: "anthropic/claude-fable-5-1", reasoning_options: [] },
    "complete": { base_model: "openai/gpt-4.1" },
  };
  try {
    const result = await syncProvider({
      id: "test", name: "Test", modelsDir: data.modelsDir,
      async fetchModels() { return Object.keys(definitions); },
      parseModels(raw) { return raw as string[]; },
      translateModel(id) { return { id, model: definitions[id]! }; },
    });
    expect(result).toMatchObject({ created: 2, deleted: 1, incomplete: 3 });
    expect(result.notices.join("\n")).toContain("Missing base_model metadata");
    expect(result.notices.join("\n")).toContain("limit.output");
    expect(result.notices.join("\n")).toContain("reasoning_options");
    expect(await Bun.file(path.join(data.modelsDir, "unknown-controls.toml")).exists()).toBe(false);
    expect(await readFile(path.join(data.modelsDir, "always-on.toml"), "utf8")).toContain("reasoning_options = []");
  } finally {
    await rm(data.dir, { recursive: true, force: true });
  }
});

test("incomplete metadata is not written and retained models keep their original lab metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "incomplete-metadata-"));
  const modelsDir = path.join(dir, "providers/test/models");
  const metadataDir = path.join(dir, "models/lab");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  const originalMetadata = await readFile(path.join(import.meta.dirname, "../../../models/anthropic/claude-fable-5-1.toml"), "utf8");
  const original = 'base_model = "lab/kept"\nreasoning_options = []\n';
  await writeFile(path.join(modelsDir, "kept.toml"), original);
  await writeFile(path.join(metadataDir, "kept.toml"), originalMetadata);
  try {
    const result = await syncProvider({
      id: "test", name: "Test", modelsDir, metadataNamespace: "lab",
      async fetchModels() { return ["kept", "new"]; },
      parseModels(raw) { return raw as string[]; },
      translateModel(id) {
        return {
          id, model: { base_model: `lab/${id}` },
          metadata: { id: `lab/${id}`, model: { name: id, description: "Fixture", reasoning: true } },
        };
      },
    });
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, incomplete: 2 });
    expect(await readFile(path.join(modelsDir, "kept.toml"), "utf8")).toBe(original);
    expect(await readFile(path.join(metadataDir, "kept.toml"), "utf8")).toBe(originalMetadata);
    expect(await Bun.file(path.join(metadataDir, "new.toml")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cloudflare --check fails on incomplete models even with no file changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "incomplete-check-"));
  const modelsDir = path.join(dir, "providers/cloudflare-ai-gateway/models/anthropic");
  const metadataDir = path.join(dir, "models/anthropic");
  const fixtures = path.join(dir, "fixtures");
  await Promise.all([modelsDir, metadataDir, fixtures].map((folder) => mkdir(folder, { recursive: true })));
  await writeFile(path.join(modelsDir, "claude-fable-5.1.toml"), 'base_model = "anthropic/claude-fable-5-1"\nreasoning_options = []\n');
  await writeFile(path.join(metadataDir, "claude-fable-5-1.toml"), await readFile(path.join(import.meta.dirname, "../../../models/anthropic/claude-fable-5-1.toml")));
  await writeFile(path.join(fixtures, "catalog.json"), JSON.stringify({
    success: true, result: [source("anthropic/claude-fable-5.1").catalog],
    result_info: { page: 1, per_page: 50, total_count: 1, total_pages: 1 },
  }));
  try {
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dirname, "../script/generate-cloudflare-ai-gateway.ts"), "--check"], {
      cwd: dir, env: { ...process.env, CF_AIG_FIXTURE_DIR: fixtures }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toContain("0 created, 0 updated, 0 removed, 1 unchanged, 1 incomplete");
    expect(stderr).toContain("--check: 1 model(s) need curation");
    expect(stdout).not.toContain("up to date");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["duplicate", "unsafe", "invalid-value", "programming-error", "fetch-error"])("does not turn %s failures into incomplete-model issues", async (mode) => {
  const data = await fixture();
  try {
    await expect(syncProvider({
      id: "test", name: "Test", modelsDir: data.modelsDir,
      async fetchModels() {
        if (mode === "fetch-error") throw new Error("fetch failed");
        return ["first", "second"];
      },
      parseModels(raw) { return raw as string[]; },
      translateModel(id) {
        if (mode === "programming-error") throw new TypeError("bug");
        if (mode === "duplicate") throw new IncompleteModelError("same-id", "missing facts");
        if (mode === "unsafe") throw new IncompleteModelError("../../escape", "missing facts");
        return { id, model: { base_model: "openai/gpt-4.1", limit: { output: -1 } } };
      },
    })).rejects.toThrow();
    expect(await readFile(data.file, "utf8")).toBe(data.content);
    expect(await Bun.file(path.join(data.modelsDir, "first.toml")).exists()).toBe(false);
  } finally {
    await rm(data.dir, { recursive: true, force: true });
  }
});
