// Dotted-path helpers over plain TOML documents.

import type { Doc } from "./types.js";

export function isTable(value: unknown): value is Doc {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getPath(doc: unknown, path: string): unknown {
  let node = doc;
  for (const part of path.split(".")) {
    if (!isTable(node)) return undefined;
    node = node[part];
  }
  return node;
}

export function setPath(doc: Doc, path: string, value: unknown) {
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!isTable(node[part])) node[part] = {};
    node = node[part] as Doc;
  }
  node[parts.at(-1)!] = value;
}

// Removes the value at `path`, then any tables it leaves empty.
export function unsetPath(doc: Doc, path: string) {
  const parts = path.split(".");
  const parents: Doc[] = [];
  let node: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (!isTable(node)) return;
    parents.push(node);
    node = node[part];
  }
  if (!isTable(node)) return;
  delete node[parts.at(-1)!];
  for (let index = parents.length - 1; index >= 0; index--) {
    const child = parents[index]![parts[index]!];
    if (!isTable(child) || Object.keys(child).length > 0) break;
    delete parents[index]![parts[index]!];
  }
}

// Object key order doesn't matter; array order does (effort lists are ordered).
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  }
  if (!isTable(a) || !isTable(b)) return false;
  const keys = (doc: Doc) => Object.keys(doc).filter((key) => doc[key] !== undefined);
  const left = keys(a);
  return left.length === keys(b).length && left.every((key) => equal(a[key], b[key]));
}

// Tables merge key by key; arrays and values replace. Same rule as base_model.
export function mergeDeep(base: Doc, own: Doc): Doc {
  const result: Doc = structuredClone(base);
  for (const [key, value] of Object.entries(own)) {
    if (value === undefined) continue;
    result[key] = isTable(value) && isTable(result[key]) ? mergeDeep(result[key] as Doc, value) : structuredClone(value);
  }
  return result;
}

export function leafPaths(doc: Doc, prefix = ""): string[] {
  return Object.entries(doc).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return isTable(value) && Object.keys(value).length > 0 ? leafPaths(value, path) : [path];
  });
}
