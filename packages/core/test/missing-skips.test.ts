import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type SyncProvider } from "../src/sync/index.js";
import * as missingIssues from "../src/sync/missing-issues.js";

test("opens issues for selectively skipped missing models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sync-missing-model-"));
  const modelsDir = path.join(dir, "providers", "example", "models");
  await mkdir(modelsDir, { recursive: true });
  const existingPath = path.join(modelsDir, "needs-metadata.toml");
  await Bun.write(existingPath, 'name = "Keep me"\n');
  const issues = spyOn(missingIssues, "openMissingModelIssues").mockResolvedValue([]);
  const provider: SyncProvider<{ id: string; missing: boolean }> = {
    id: "example",
    name: "Example",
    modelsDir,
    async fetchModels() {
      return [
        { id: "needs-metadata", missing: true },
        { id: "intentional-skip", missing: false },
      ];
    },
    parseModels(raw) {
      return raw as { id: string; missing: boolean }[];
    },
    translateModel() {
      return undefined;
    },
    sourceID(model) {
      return model.id;
    },
    missingModelID(model) {
      return model.missing ? model.id : undefined;
    },
  };

  try {
    const result = await syncProvider(provider, { openIssues: true });
    expect(result).toMatchObject({ deleted: 0, unchanged: 1 });
    expect(await Bun.file(existingPath).text()).toBe('name = "Keep me"\n');
    expect(issues).toHaveBeenCalledTimes(1);
    expect(issues.mock.calls[0]?.[1]).toEqual(["needs-metadata"]);
  } finally {
    issues.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
