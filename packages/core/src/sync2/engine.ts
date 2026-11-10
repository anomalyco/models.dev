// The sync engine: turns a module's observations into file changes and gaps.

import { ZodError } from "zod";

import { formatModelV2 } from "../model-file-v2.js";
import { modelV2ToV1 } from "../translate.js";
import { applyWrites, inherited, Labs, type ModelFile, readProviderFiles, relativeModelPath, REPO_ROOT, resolved } from "./catalog.js";
import { equal, getPath, leafPaths, setPath, unsetPath } from "./fields.js";
import { classifyRisk } from "./risk.js";
import type { Change, Doc, FieldChange, Gap, Observation, Owned, SyncModule, SyncResult } from "./types.js";

// What a published model needs. A lab file always has these, so only a model
// without a base_model can be missing them.
export const REQUIRED = [
  "name",
  "description",
  "release_date",
  "open_weights",
  "modalities.input",
  "modalities.output",
  "capabilities.tools.supported",
  "capabilities.reasoning.supported",
  "limit.context",
  "limit.output",
];

export interface PlanOptions {
  /** Repository root. Defaults to this checkout. */
  root?: string;
  /** Source data to use instead of calling `fetch()`. */
  raw?: unknown;
}

export interface Plan {
  result: SyncResult;
  /** Repository-relative path to new content, or null to delete. */
  writes: Map<string, string | null>;
}

export async function sync<Raw>(module: SyncModule<Raw>, options: PlanOptions & { dryRun?: boolean } = {}) {
  const root = options.root ?? REPO_ROOT;
  const { result, writes } = await plan(module, { ...options, root });
  if (!options.dryRun) await applyWrites(root, module.id, writes);
  return result;
}

export async function plan<Raw>(module: SyncModule<Raw>, options: PlanOptions = {}): Promise<Plan> {
  const root = options.root ?? REPO_ROOT;
  const raw = (options.raw ?? await module.fetch()) as Raw;
  const observations = module.observe(raw);
  const files = await readProviderFiles(root, module.id);
  const labs = new Labs(root);
  const context: Context = { module, labs, changes: [], gaps: [], notices: [], writes: new Map() };

  if (observations.length === 0 && module.policy.removals !== "keep") {
    throw new Error(`${module.name} returned no models; refusing to treat every file as removed`);
  }
  const byLowerID = new Map([...files.values()].map((file) => [file.id.toLowerCase(), file]));
  const seen = new Map<string, string>();
  const skipped: string[] = [];

  for (const observation of observations) {
    const key = observation.id.toLowerCase();
    if (seen.has(key)) throw new Error(`${module.name} lists ${observation.id} twice (or IDs differing only in case: ${seen.get(key)})`);
    seen.set(key, observation.id);
    const file = files.get(observation.id) ?? byLowerID.get(key);
    if (file !== undefined && file.id !== observation.id) {
      context.notices.push(`${module.name} lists \`${observation.id}\`, filed as \`${file.id}\`; matched to that file.`);
    }
    if (file !== undefined) update(context, observation, file);
    else if (module.policy.creates === "never") skipped.push(observation.id);
    else create(context, observation);
  }
  if (skipped.length > 0) {
    context.notices.push(`${skipped.length} models not in the catalog were skipped (creates: never): ${skipped.map((id) => `\`${id}\``).join(", ")}`);
  }

  for (const file of files.values()) {
    if (seen.has(file.id.toLowerCase())) continue;
    if (module.manages?.(file.id, file.doc) === false) continue;
    remove(context, file);
  }

  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  const changes = context.changes.sort(byPath);
  const gaps = context.gaps.sort((a, b) => a.model.localeCompare(b.model));
  const risk = classifyRisk({ provider: module.id, before: files.size, changes, gaps });
  return {
    result: { provider: module.id, changes, gaps, notices: context.notices, risk },
    writes: context.writes,
  };
}

interface Context {
  module: SyncModule<any>;
  labs: Labs;
  changes: Change[];
  gaps: Gap[];
  notices: string[];
  writes: Map<string, string | null>;
}

function update(context: Context, observation: Observation, file: ModelFile) {
  const { module, labs } = context;
  const doc = structuredClone(file.doc);
  const fields = patch(doc, observation, module.policy.owns, inherited(doc, labs));
  if (fields.length === 0) return;

  const before = resolved(file.doc, labs);
  const after = resolved(doc, labs);
  const authored = getPath(file.doc, "capabilities.reasoning") !== undefined;
  if (supportsReasoning(after) && !supportsReasoning(before) && !authored && !hasControls(doc)) {
    context.gaps.push(gap(context, observation, "update", "now reports reasoning, but the file has no reasoning controls", ["capabilities.reasoning"]));
    return;
  }
  const content = render(context, file.id, doc, file.header, "update");
  if (content === undefined) return;
  if (file.symlink) {
    context.notices.push(`${file.path} is a symlink, so it was not updated.`);
    return;
  }
  context.writes.set(file.path, content);
  context.changes.push({
    kind: "update",
    model: file.id,
    path: file.path,
    fields,
    ...(reasoningChanged(before, after) ? { reasoning: true as const } : {}),
  });
}

function create(context: Context, observation: Observation) {
  const { module, labs } = context;
  const base = resolveBase(observation, labs);
  const doc: Doc = { schema: 2 };
  if (base !== undefined) doc.base_model = base;
  patch(doc, observation, module.policy.owns, inherited(doc, labs));

  const merged = resolved(doc, labs);
  const missing = REQUIRED.filter((path) => getPath(merged, path) === undefined);
  if (base === undefined && missing.length > 0) missing.unshift("base_model");
  if (supportsReasoning(merged) && !hasControls(doc)) missing.push("capabilities.reasoning");

  if (module.policy.creates === "gap") {
    context.gaps.push(gap(context, observation, "new", "new models are added by hand for this provider", missing));
    return;
  }
  if (missing.length > 0) {
    const reason = base === undefined
      ? "no lab model to base it on"
      : missing.length === 1 && missing[0] === "capabilities.reasoning"
        ? "a reasoning model, and the source doesn't state its reasoning controls"
        : "the source doesn't state every field a new file needs";
    context.gaps.push(gap(context, observation, "new", reason, missing));
    return;
  }
  const content = render(context, observation.id, doc, comments(observation.header), "new");
  if (content === undefined) return;
  const path = relativeModelPath(module.id, observation.id);
  context.writes.set(path, content);
  context.changes.push({
    kind: "create",
    model: observation.id,
    path,
    fields: leafPaths(doc).filter((field) => field !== "schema").map((field) => ({ path: field, after: getPath(doc, field) })),
    ...(supportsReasoning(merged) ? { reasoning: true as const } : {}),
  });
}

function remove(context: Context, file: ModelFile) {
  const { module } = context;
  if (file.symlink) {
    context.notices.push(`${file.path} is a symlink missing from the source; it was left alone.`);
    return;
  }
  if (module.policy.removals === "keep") {
    context.gaps.push({ provider: module.id, model: file.id, kind: "removal", reason: `${module.name} no longer lists it`, missing: [] });
    return;
  }
  if (module.policy.removals === "delete") {
    context.writes.set(file.path, null);
    context.changes.push({ kind: "remove", model: file.id, path: file.path, fields: [] });
    return;
  }
  if (file.doc.status === "deprecated") return;
  const doc = { ...structuredClone(file.doc), status: "deprecated" };
  const content = render(context, file.id, doc, file.header, "removal");
  if (content === undefined) return;
  context.writes.set(file.path, content);
  context.changes.push({
    kind: "deprecate",
    model: file.id,
    path: file.path,
    fields: [{ path: "status", before: file.doc.status, after: "deprecated" }],
  });
}

/**
 * Copies each owned field the observation states into `doc`. A value equal to
 * the inherited lab value is left to inheritance. `null` removes the file's own
 * value. Returns what changed.
 */
export function patch(doc: Doc, observation: Observation, owns: Owned[], base: Doc | undefined): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const owned of owns) {
    const path = typeof owned === "string" ? owned : owned.path;
    const observed = getPath(observation, path);
    if (observed === undefined) continue;
    const own = getPath(doc, path);
    const fromBase = getPath(base, path);
    const current = own ?? fromBase;

    if (observed === null) {
      if (own === undefined) continue;
      unsetPath(doc, path);
      changes.push({ path, before: own, after: fromBase });
      continue;
    }
    let next = observed;
    if (typeof owned !== "string" && owned.merge === "min" && typeof next === "number" && typeof current === "number") {
      next = Math.min(next, current);
    }
    if (equal(current, next)) continue;
    if (fromBase !== undefined && equal(fromBase, next)) unsetPath(doc, path);
    else setPath(doc, path, structuredClone(next));
    changes.push({ path, before: current, after: next });
  }
  return changes;
}

/** The lab model a new file inherits from: the first hint with a file under models/. */
export function resolveBase(observation: Observation, labs: Labs): string | undefined {
  for (const hint of observation.base ?? []) {
    const found = labs.find(hint);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The file as written, or undefined (with a gap or notice) when it wouldn't be valid.
function render(context: Context, id: string, doc: Doc, header: string, kind: Gap["kind"]) {
  try {
    modelV2ToV1({ ...doc, id });
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const missing = [...new Set(error.issues.map((issue) => issue.path.join(".")))];
    context.gaps.push({ provider: context.module.id, model: id, kind, reason: "the patched file fails the schema", missing });
    return undefined;
  }
  const content = header + formatModelV2(doc);
  if (!equal(Bun.TOML.parse(content), doc)) {
    context.notices.push(`${relativeModelPath(context.module.id, id)} has fields the writer can't reproduce; it was left alone.`);
    return undefined;
  }
  return content;
}

function gap(context: Context, observation: Observation, kind: Gap["kind"], reason: string, missing: string[]): Gap {
  return { provider: context.module.id, model: observation.id, kind, reason, missing, known: observation };
}

function supportsReasoning(model: Doc) {
  return getPath(model, "capabilities.reasoning.supported") === true;
}

// Lab files only say whether a model reasons; the controls (toggle, effort,
// budget) live in the provider file. A source saying only "it reasons" isn't
// enough to publish one, since no controls would claim the caller has none.
function hasControls(doc: Doc) {
  const reasoning = getPath(doc, "capabilities.reasoning");
  return reasoning !== null && typeof reasoning === "object" && Object.keys(reasoning).some((key) => key !== "supported");
}

function reasoningChanged(before: Doc, after: Doc) {
  if (!supportsReasoning(before) && !supportsReasoning(after)) return false;
  return !equal(getPath(before, "capabilities.reasoning"), getPath(after, "capabilities.reasoning"));
}

function comments(header: string | undefined) {
  if (header === undefined || header.trim() === "") return "";
  return `${header.trim().split("\n").map((line) => (line.startsWith("#") ? line : `# ${line}`)).join("\n")}\n`;
}
