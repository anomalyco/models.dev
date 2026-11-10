// Reads and writes the catalog files the engine works on.

import path from "node:path";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";

import { mergeDeep, unsetPath } from "./fields.js";
import type { Doc } from "./types.js";

export const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..");

export interface ModelFile {
  id: string;
  /** Repository-relative path. */
  path: string;
  doc: Doc;
  /** Leading comment block, kept on rewrite. */
  header: string;
  symlink: boolean;
}

export function modelsDir(root: string, provider: string) {
  return path.join(root, "providers", provider, "models");
}

export function relativeModelPath(provider: string, id: string) {
  return `providers/${provider}/models/${id}.toml`;
}

export async function readProviderFiles(root: string, provider: string) {
  const dir = modelsDir(root, provider);
  const files = new Map<string, ModelFile>();
  for (const { file, symlink } of await tomlFiles(dir)) {
    const id = file.slice(0, -".toml".length);
    const text = await Bun.file(path.join(dir, file)).text();
    files.set(id, {
      id,
      path: relativeModelPath(provider, id),
      doc: Bun.TOML.parse(text) as Doc,
      header: leadingComments(text),
      symlink,
    });
  }
  return files;
}

async function tomlFiles(root: string, dir = ""): Promise<Array<{ file: string; symlink: boolean }>> {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch (error) {
    if (dir === "" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: Array<{ file: string; symlink: boolean }> = [];
  for (const entry of entries) {
    const file = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await tomlFiles(root, file));
    else if (entry.name.endsWith(".toml") && (entry.isFile() || entry.isSymbolicLink())) {
      result.push({ file, symlink: entry.isSymbolicLink() });
    }
  }
  return result;
}

// Lab files under models/, loaded on first use.
export class Labs {
  private ids: Map<string, string> | undefined;
  private docs = new Map<string, Doc>();

  constructor(private root: string) {}

  private index() {
    if (this.ids === undefined) {
      this.ids = new Map();
      for (const file of new Bun.Glob("**/*.toml").scanSync({ cwd: path.join(this.root, "models") })) {
        const id = file.split(path.sep).join("/").slice(0, -".toml".length);
        this.ids.set(id.toLowerCase(), id);
      }
    }
    return this.ids;
  }

  /** The lab ID as filed, matching exactly or else ignoring case. */
  find(id: string): string | undefined {
    const ids = this.index();
    return ids.get(id.toLowerCase()) === id ? id : ids.get(id.toLowerCase());
  }

  get(id: string): Doc | undefined {
    const found = this.find(id);
    if (found === undefined) return undefined;
    let doc = this.docs.get(found);
    if (doc === undefined) {
      doc = Bun.TOML.parse(readFileSync(path.join(this.root, "models", `${found}.toml`), "utf8")) as Doc;
      this.docs.set(found, doc);
    }
    return doc;
  }
}

/** The lab file a provider file inherits from, as the provider file sees it (after `base_model_omit`). */
export function inherited(doc: Doc, labs: Labs): Doc | undefined {
  if (typeof doc.base_model !== "string") return undefined;
  const lab = labs.get(doc.base_model);
  if (lab === undefined) throw new Error(`base_model ${doc.base_model} has no file under models/`);
  const { schema: _schema, ...fields } = structuredClone(lab);
  for (const omit of (doc.base_model_omit as string[] | undefined) ?? []) unsetPath(fields, omit);
  return fields;
}

/** The model as published: lab fields with the provider file on top. */
export function resolved(doc: Doc, labs: Labs): Doc {
  const { base_model: _base, base_model_omit: _omit, ...own } = doc;
  const base = inherited(doc, labs);
  return base === undefined ? own : mergeDeep(base, own);
}

export function leadingComments(text: string) {
  const header: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) break;
    header.push(line);
  }
  while (header.length > 0 && header.at(-1)!.trim() === "") header.pop();
  return header.length > 0 ? `${header.join("\n")}\n` : "";
}

/** Writes (content) or deletes (null) files under one provider's models/ folder. */
export async function applyWrites(root: string, provider: string, writes: Map<string, string | null>) {
  const dir = path.resolve(modelsDir(root, provider));
  for (const [relative, content] of writes) {
    const target = path.resolve(root, relative);
    const inside = path.relative(dir, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`Refusing to write outside ${dir}: ${relative}`);
    let current = dir;
    for (const part of inside.split(path.sep)) {
      current = path.join(current, part);
      if (await isSymlink(current)) throw new Error(`Refusing to write through a symlink: ${current}`);
    }
    if (content === null) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
  }
}

async function isSymlink(file: string) {
  try {
    return (await lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

