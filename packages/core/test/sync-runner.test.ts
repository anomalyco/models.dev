import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readlink, symlink } from "node:fs/promises";
import os from "node:os";

import { generate } from "../src/index.js";
import { AuthoredModelShape } from "../src/schema.js";
import { syncProvider, type SyncProvider, type SyncedFullModel } from "../src/sync/index.js";

const model: SyncedFullModel = {
  name: "Test model",
  release_date: "2026-01-01",
  last_updated: "2026-01-01",
  attachment: false,
  reasoning: false,
  tool_call: false,
  open_weights: false,
  cost: { input: 1, output: 2 },
  limit: { context: 1_000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
};

test("reasoning budgets allow only the -1 negative sentinel", () => {
  const authored = { id: "model", ...model };

  expect(AuthoredModelShape.safeParse({
    ...authored,
    reasoning_options: [{ type: "budget_tokens", min: -1, max: 32_768 }],
  }).success).toBe(true);
  expect(AuthoredModelShape.safeParse({
    ...authored,
    reasoning_options: [{ type: "budget_tokens", min: -2, max: 32_768 }],
  }).success).toBe(false);
});

test("reasoning efforts accept the provider default value", () => {
  expect(AuthoredModelShape.safeParse({
    id: "model",
    ...model,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "default"] }],
  }).success).toBe(true);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "models-dev-sync-"));
  const modelsDir = path.join(root, "providers", "test", "models");
  await mkdir(modelsDir, { recursive: true });
  return { root, modelsDir };
}

function provider(
  modelsDir: string,
  ids: string[],
  deleteMissing = true,
  preserveSymlinks = false,
): SyncProvider<string> {
  return {
    id: "test",
    name: "Test",
    modelsDir,
    deleteMissing,
    preserveSymlinks,
    missingNotice: (paths) => paths.map((item) => `missing: ${item}`),
    async fetchModels() {
      return ids;
    },
    parseModels(raw) {
      return raw as string[];
    },
    translateModel(id) {
      return { id, model };
    },
  };
}

test("sync repairs a broken symlink returned by the source", async () => {
  const { modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await symlink("missing.toml", filePath);

  const result = await syncProvider(provider(modelsDir, ["model"]));

  expect(result.created).toBe(1);
  expect(await Bun.file(filePath).text()).toContain('name = "Test model"');
  expect(readlink(filePath)).rejects.toThrow();
});

test("sync preserves valid symlink aliases when configured", async () => {
  const { root, modelsDir } = await fixture();
  const targetPath = path.join(root, "target.toml");
  const filePath = path.join(modelsDir, "model.toml");
  await Bun.write(targetPath, `name = "Alias target"\n`);
  await symlink(targetPath, filePath);

  const result = await syncProvider(provider(modelsDir, ["model"], true, true));

  expect(result.updated).toBe(0);
  expect(await readlink(filePath)).toBe(targetPath);
});

test("sync removes a broken symlink absent from the source", async () => {
  const { modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await symlink("missing.toml", filePath);

  const result = await syncProvider(provider(modelsDir, []));

  expect(result.deleted).toBe(1);
  expect(await Bun.file(filePath).exists()).toBe(false);
});

test("non-deleting sync reports missing broken symlinks", async () => {
  const { modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await symlink("missing.toml", filePath);

  const result = await syncProvider(provider(modelsDir, [], false));

  expect(result.deleted).toBe(0);
  expect(result.notices).toEqual(["missing: model.toml"]);
  expect(await readlink(filePath)).toBe("missing.toml");
});

test("sync preserves authored reasoning options omitted by a translator", async () => {
  const { modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await Bun.write(filePath, `name = "Old name"
release_date = "2026-01-01"
last_updated = "2026-01-01"
attachment = false
reasoning = true
tool_call = false
open_weights = false

[[reasoning_options]]
type = "effort"
values = ["low", "high"]

[[reasoning_options]]
type = "budget_tokens"
min = -1
max = 32768

[cost]
input = 1
output = 2

[limit]
context = 1000
output = 100

[modalities]
input = ["text"]
output = ["text"]
`);
  const sync = provider(modelsDir, ["model"]);
  sync.translateModel = (id) => ({
    id,
    model: { ...model, reasoning: true },
  });

  const first = await syncProvider(sync);
  const content = await Bun.file(filePath).text();
  const second = await syncProvider(sync);

  expect(first.updated).toBe(1);
  expect(content).toContain("[[reasoning_options]]");
  expect(content).toContain('values = ["low", "high"]');
  expect(content).toContain("min = -1");
  expect(content).toContain("max = 32_768");
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(1);
});

test("sync removes authored reasoning options when a translator disables reasoning", async () => {
  const { modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await Bun.write(filePath, `name = "Old name"
release_date = "2026-01-01"
last_updated = "2026-01-01"
attachment = false
reasoning = true
reasoning_options = [{ type = "toggle" }]
tool_call = false
open_weights = false

[cost]
input = 1
output = 2

[limit]
context = 1000
output = 100

[modalities]
input = ["text"]
output = ["text"]
`);
  const sync = provider(modelsDir, ["model"]);
  sync.translateModel = (id) => ({
    id,
    model: {
      ...model,
      reasoning: false,
      reasoning_options: [{ type: "toggle" }],
    },
  });

  const first = await syncProvider(sync);
  const content = await Bun.file(filePath).text();
  const second = await syncProvider(sync);

  expect(first.updated).toBe(1);
  expect(content).toContain("reasoning = false");
  expect(content).not.toContain("reasoning_options");
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(1);
});

test("sync removes authored reasoning options inherited beside reasoning false", async () => {
  const { root, modelsDir } = await fixture();
  const filePath = path.join(modelsDir, "model.toml");
  await Bun.write(path.join(root, "providers", "test", "provider.toml"), `name = "Test"
npm = "@ai-sdk/openai"
env = ["TEST_API_KEY"]
doc = "https://example.com/models"
`);
  await mkdir(path.join(root, "models", "test"), { recursive: true });
  await Bun.write(path.join(root, "models", "test", "model.toml"), `name = "Test model"
release_date = "2026-01-01"
last_updated = "2026-01-01"
attachment = false
reasoning = false
tool_call = false
open_weights = false

[limit]
context = 1000
output = 100

[modalities]
input = ["text"]
output = ["text"]
`);
  await Bun.write(filePath, `base_model = "test/model"
reasoning_options = [{ type = "toggle" }]

[cost]
input = 1
output = 2
`);
  const sync = provider(modelsDir, ["model"]);
  sync.translateModel = (id) => ({
    id,
    model: {
      base_model: "test/model",
      cost: { input: 1, output: 2 },
    },
  });

  const first = await syncProvider(sync);
  const content = await Bun.file(filePath).text();
  const generated = (await generate(path.join(root, "providers"))).test?.models.model;
  const second = await syncProvider(sync);

  expect(first.updated).toBe(1);
  expect(content).toContain('base_model = "test/model"');
  expect(content).not.toContain("reasoning_options");
  expect(generated?.reasoning).toBe(false);
  expect(generated?.reasoning_options).toBeUndefined();
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(1);
});

test("sync writes metadata returned by a provider translator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "models-dev-sync-metadata-"));
  const modelsDir = path.join(root, "providers", "test", "models");
  await mkdir(modelsDir, { recursive: true });
  const sync = provider(modelsDir, ["model"]);
  sync.translateModel = () => ({
    id: "model",
    model: {
      base_model: "test/model",
      reasoning_options: [],
      cost: { input: 1, output: 2 },
    },
    metadata: {
      id: "test/model",
      model: {
        name: "Model",
        release_date: "2026-06-10",
        last_updated: "2026-06-10",
        attachment: false,
        reasoning: false,
        tool_call: true,
        open_weights: false,
        limit: { context: 1_000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  });

  const first = await syncProvider(sync);
  const second = await syncProvider(sync);

  expect(first).toMatchObject({ created: 2, updated: 0 });
  expect(second).toMatchObject({ created: 0, updated: 0 });
  expect(await Bun.file(path.join(root, "models", "test", "model.toml")).text()).toContain('name = "Model"');
});

test("sync removes missing metadata only from its owned namespace", async () => {
  const { root, modelsDir } = await fixture();
  const ownedDir = path.join(root, "models", "test");
  const otherDir = path.join(root, "models", "other");
  await mkdir(ownedDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  await Bun.write(path.join(ownedDir, "stale.toml"), 'name = "Stale"\n');
  await Bun.write(path.join(otherDir, "retained.toml"), 'name = "Retained"\n');
  const sync = provider(modelsDir, []);
  sync.metadataNamespace = "test";

  const result = await syncProvider(sync);

  expect(result.deleted).toBe(1);
  expect(await Bun.file(path.join(ownedDir, "stale.toml")).exists()).toBe(false);
  expect(await Bun.file(path.join(otherDir, "retained.toml")).exists()).toBe(true);
});
