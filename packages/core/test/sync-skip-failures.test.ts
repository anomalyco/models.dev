import { expect, test } from "bun:test";

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index";

const LAB = `schema = 2
name = "Lab Model"
description = "Test model"
open_weights = false
release_date = "2026-01-01"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = false }
reasoning = { supported = false }
temperature = false
top_p = false
top_k = false

[limit]
context = 1_000
output = 100
`;

async function run(ids: string[], failing: Set<string>, existing: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-skip-"));
  try {
    const modelsDir = path.join(root, "providers", "host", "models");
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(root, "models", "acme"), { recursive: true });
    await Bun.write(path.join(root, "models", "acme", "m.toml"), LAB);
    await Bun.write(path.join(root, "providers", "host", "provider.toml"), 'name = "Host"\nnpm = "@ai-sdk/openai-compatible"\nenv = ["HOST_API_KEY"]\napi = "https://example.com/v1"\ndoc = "https://example.com"\n');
    for (const id of existing) {
      await Bun.write(path.join(modelsDir, `${id}.toml`), 'schema = 2\nbase_model = "acme/m"\n');
    }
    const result = await syncProvider(
      {
        id: "host",
        name: "Host",
        modelsDir,
        async fetchModels() {
          return ids.map((id) => ({ id }));
        },
        parseModels: (raw) => raw as { id: string }[],
        sourceID: (source) => source.id,
        translateModel(source) {
          if (failing.has(source.id)) throw new Error(`bad row ${source.id}`);
          return {
            id: source.id,
            model: { base_model: "acme/m" } as any,
          };
        },
      },
      { openIssues: false },
    );
    return { result, files: (await readdir(modelsDir)).sort() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a model that fails to translate is skipped and reported, and nothing is deleted that run", async () => {
  const { result, files } = await run(["a", "b", "c", "d", "e"], new Set(["b"]), ["b", "gone"]);
  expect(files).toEqual(["a.toml", "b.toml", "c.toml", "d.toml", "e.toml", "gone.toml"]);
  expect(JSON.stringify(result)).toContain("bad row b");
});

test("too many failures still fail the provider", async () => {
  expect(run(["a", "b", "c", "d", "e"], new Set(["a", "b", "c", "d"]), [])).rejects.toThrow("4 of 5 models failed to translate");
});
