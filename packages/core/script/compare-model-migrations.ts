#!/usr/bin/env bun

import path from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generate } from "../src/generate.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const providersPath = path.join(root, "providers");

const diffOutput = await Bun.$`git diff --name-only HEAD -- providers`.cwd(root).text();
const changedProviderPaths = diffOutput
  .split("\n")
  .filter(Boolean)
  .filter((filePath) => /^providers\/[^/]+\/models\/.+\.toml$/.test(filePath));

if (changedProviderPaths.length === 0) {
  process.exit(0);
}

const baselineRoot = path.join(tmpdir(), `models-dev-compare-${Date.now()}`);
await mkdir(baselineRoot, { recursive: true });

try {
  const baselineProvidersPath = path.join(baselineRoot, "providers");
  await cp(providersPath, baselineProvidersPath, { recursive: true });

  for (const filePath of changedProviderPaths) {
    const tempFilePath = path.join(baselineRoot, filePath);
    const show = Bun.spawn(["git", "show", `HEAD:${filePath}`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await show.exited;
    if (exitCode !== 0) {
      await rm(tempFilePath, { force: true });
      continue;
    }

    const contents = await new Response(show.stdout).text();
    await mkdir(path.dirname(tempFilePath), { recursive: true });
    await writeFile(tempFilePath, contents);
  }

  const before = await generate(baselineProvidersPath);
  const after = await generate(providersPath);

  for (const filePath of changedProviderPaths) {
    const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(filePath);
    if (!match) continue;

    const [, providerID, modelID] = match;
    const beforeModel = before[providerID]?.models[modelID];
    const afterModel = after[providerID]?.models[modelID];
    const beforeJson = JSON.stringify(beforeModel, null, 2);
    const afterJson = JSON.stringify(afterModel, null, 2);

    if (beforeJson === afterJson) {
      continue;
    }

    const beforeFilePath = path.join(baselineRoot, "before.json");
    const afterFilePath = path.join(baselineRoot, "after.json");
    await writeFile(beforeFilePath, `${beforeJson}\n`);
    await writeFile(afterFilePath, `${afterJson}\n`);

    const diff = Bun.spawn(
      [
        "diff",
        "-u",
        "-L",
        `${filePath} (before)`,
        "-L",
        `${filePath} (after)`,
        beforeFilePath,
        afterFilePath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(diff.stdout).text();
    process.stdout.write(output);
  }
} finally {
  await rm(baselineRoot, { recursive: true, force: true });
}
