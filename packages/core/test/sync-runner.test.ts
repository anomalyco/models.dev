import { expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readlink, symlink } from "node:fs/promises";
import os from "node:os";

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
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(1);
});
