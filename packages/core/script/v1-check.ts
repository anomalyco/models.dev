#!/usr/bin/env bun
// Compares the v1 API output of the working tree with a base commit.
//
//   bun run v1:check            # base = merge-base of HEAD and origin/dev
//   bun run v1:check <ref>      # any commit, branch or tag
//
// Prints every changed v1 field (grouped, with example models), models added
// to or removed from v1, and v2 files changed since the base that still list a
// generic modality (`image`, `audio`, `video`, `pdf`). Exits 1 when v1 changed.

import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = (await Bun.$`git rev-parse --show-toplevel`.text()).trim();
const ref = process.argv[2] ?? (await Bun.$`git -C ${root} merge-base HEAD origin/dev`.text()).trim();
const baseCommit = (await Bun.$`git -C ${root} rev-parse --short ${ref}`.text()).trim();
const baseRoot = await mkdtemp(path.join(tmpdir(), "models-dev-v1-check-"));

type Json = Record<string, any>;

async function views(dir: string) {
  const core = await import(path.join(dir, "packages/core/src/index.ts"));
  const catalog = await core.generateCatalog(dir);
  const full = { models: catalog.models, providers: catalog.providers };
  const filters: Array<[string, unknown]> = [
    ["", "default"],
    ["-all", "all"],
    ...core.MODEL_TYPES.map((type: string) => [`-${type}`, [type]] as [string, unknown]),
  ];
  const out: Record<string, Json> = {};
  for (const [suffix, filter] of filters) {
    const view = core.filterCatalogByModelType(full, filter);
    out[`api${suffix}`] = view.providers;
    out[`models${suffix}`] = view.models;
  }
  return out;
}

try {
  await Bun.$`git -C ${root} worktree add -q --detach ${baseRoot} ${ref}`.quiet();
  await symlink(path.join(root, "node_modules"), path.join(baseRoot, "node_modules"));
  console.log(`v1 check: working tree vs ${baseCommit} (${ref})`);

  const [before, after] = [await views(baseRoot), await views(root)];
  const changedViews = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

  const groups = new Map<string, Set<string>>();
  const added: string[] = [];
  const removed: string[] = [];
  const add = (key: string, model: string) => (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(model);
  const short = (value: unknown) => {
    const text = JSON.stringify(value);
    return text === undefined ? "undefined" : text.length > 50 ? `${text.slice(0, 47)}...` : text;
  };
  const walk = (a: unknown, b: unknown, model: string, field: string[], view: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const objects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    if (objects) {
      for (const key of new Set([...Object.keys(a as Json), ...Object.keys(b as Json)])) {
        walk((a as Json)[key], (b as Json)[key], model, [...field, key], view);
      }
      return;
    }
    const change = a === undefined ? "added" : b === undefined ? "removed" : `${short(a)} -> ${short(b)}`;
    add(`${view} ${field.join(".")}: ${change}`, model);
  };

  for (const [provider, data] of Object.entries(after["api-all"] as Json)) {
    const models = (data as Json).models ?? {};
    const old = (before["api-all"] as Json)[provider]?.models ?? {};
    for (const [id, model] of Object.entries(models)) {
      if (!(id in old)) added.push(`${provider}/${id}`);
      else walk(old[id], model, `${provider}/${id}`, [], "api");
    }
    for (const id of Object.keys(old)) if (!(id in models)) removed.push(`${provider}/${id}`);
    const { models: _a, ...meta } = data as Json;
    const { models: _b, ...oldMeta } = ((before["api-all"] as Json)[provider] ?? {}) as Json;
    walk(oldMeta, meta, `${provider} (provider)`, [], "api");
  }
  for (const provider of Object.keys(before["api-all"] as Json)) {
    if (!(provider in (after["api-all"] as Json))) removed.push(`${provider} (whole provider)`);
  }
  for (const [id, model] of Object.entries(after["models-all"] as Json)) {
    const old = (before["models-all"] as Json)[id];
    if (old === undefined) added.push(`lab ${id}`);
    else walk(old, model, id, [], "lab");
  }
  for (const id of Object.keys(before["models-all"] as Json)) {
    if (!(id in (after["models-all"] as Json))) removed.push(`lab ${id}`);
  }

  const list = (items: string[]) => items.slice(0, 4).join(", ") + (items.length > 4 ? ", ..." : "");
  if (added.length) console.log(`\nAdded to v1 (${added.length}; new models should usually be v2_only): ${list(added)}`);
  if (removed.length) console.log(`\nRemoved from v1 (${removed.length}): ${list(removed)}`);
  if (groups.size) {
    console.log("\nChanged v1 fields (count, change, examples):");
    for (const [key, models] of [...groups].sort((a, b) => b[1].size - a[1].size)) {
      console.log(`  ${String(models.size).padStart(4)}  ${key}   [${list([...models])}]`);
    }
  }

  const changedFiles = (await Bun.$`git -C ${root} diff --name-only --diff-filter=AM ${ref} -- models providers`.text())
    .split("\n")
    .filter((file) => file.endsWith(".toml"));
  const untracked = (await Bun.$`git -C ${root} ls-files --others --exclude-standard -- models providers`.text())
    .split("\n")
    .filter((file) => file.endsWith(".toml"));
  const generic = new Set(["image", "audio", "video", "pdf"]);
  const genericFiles: string[] = [];
  for (const file of [...new Set([...changedFiles, ...untracked])]) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const text = await Bun.file(full).text();
    if (!/^schema = 2$/m.test(text)) continue;
    const modalities = (Bun.TOML.parse(text) as Json).modalities ?? {};
    const values = [...(modalities.input ?? []), ...(modalities.output ?? [])];
    if (values.some((value: string) => generic.has(value))) genericFiles.push(file);
  }
  if (genericFiles.length) {
    console.log(`\nChanged v2 files with generic modalities (${genericFiles.length}; use exact MIME types where documented):`);
    for (const file of genericFiles) console.log(`  ${file}`);
  }

  const unchanged = changedViews.length === 0;
  console.log(
    unchanged
      ? "\nv1 output is byte-identical."
      : `\nv1 output changed in ${changedViews.length} of ${Object.keys(after).length} views.`,
  );
  process.exitCode = unchanged ? 0 : 1;
} finally {
  await Bun.$`git -C ${root} worktree remove --force ${baseRoot}`.quiet().nothrow();
  await rm(baseRoot, { recursive: true, force: true });
}
