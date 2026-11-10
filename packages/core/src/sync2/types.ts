import type { AuthoredModelV2 } from "../schema-v2.js";

export type Doc = Record<string, unknown>;

// Every key optional, and `null` anywhere means "the source says there is none".
export type Observed<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Observed<T[K]> | null }
    : T;

type ModelFields = Omit<AuthoredModelV2, "id" | "base_model" | "base_model_omit">;

/**
 * What a source states about one model, in v2 provider-file field names.
 * Leave out anything the source doesn't say; use `null` when it says there is
 * none (e.g. a flat-priced model has `overrides: null`).
 */
export type Observation = Observed<ModelFields> & {
  /** The model ID on this host, which is also the file path. */
  id: string;
  /** Lab model IDs (`models/<lab>/<model>`) this model may be, best first. */
  base?: string[];
  /** Leading comment for a newly created file. */
  header?: string;
  /**
   * Only update a file that already exists: never create it or report it as a
   * gap (e.g. an alias the source lists next to its canonical ID).
   */
  updateOnly?: boolean;
};

/**
 * A v2 field path the source is authoritative for, e.g. `cost.text.input.price`.
 * A plain path replaces the file's value (a list or table whole). A merge rule
 * changes that:
 * - `min`: only lowers a number.
 * - `kinds`: a modality list. The source decides the kinds (text, image, pdf, ...)
 *   and the file keeps its own formats (`image/png`) for kinds it has. With
 *   `only`, the source speaks for just those kinds and the file's others stay.
 * - `deprecated`: `status`. The source says "deprecated" or null; null only
 *   clears a "deprecated" status, never another one.
 * - `tables`: a table of tables (`api`). The source's tables replace or join the
 *   file's, null removes one, and the file's others stay. A file with none gets
 *   the provider's default API first.
 * - `report`: never written. When the source disagrees with the file, the model
 *   is an update gap and its file is left alone.
 * `standalone: true` limits a field to files without a base_model.
 */
export type Owned =
  | string
  | (OwnedRule & { merge?: "min" | "deprecated" | "tables" | "report" })
  | (OwnedRule & { merge: "kinds"; only?: string[] });

interface OwnedRule {
  path: string;
  /** Only patched on files without a base_model; with one, the lab's value stands. */
  standalone?: boolean;
}

export interface Policy {
  /** Fields the engine patches. Everything else in a file is left alone. */
  owns: Owned[];
  /** A model the catalog doesn't have: create it, report it as a gap, or ignore it. */
  creates: "auto" | "gap" | "never";
  /** A file the source no longer lists: delete it, mark it deprecated, or keep it and report a gap. */
  removals: "delete" | "deprecate" | "keep";
}

export interface SyncModule<Raw = unknown> {
  id: string;
  name: string;
  policy: Policy;
  fetch(): Promise<Raw>;
  /** Pure: raw source data to observations. Throw when the data looks wrong. */
  observe(raw: Raw): Observation[];
  /** Local files this source speaks for. Others are never removed. Default: all. */
  manages?(id: string, file: Doc): boolean;
}

export interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface Change {
  kind: "create" | "update" | "remove" | "deprecate";
  model: string;
  /** Repository-relative file path. */
  path: string;
  fields: FieldChange[];
  /** The change touches a reasoning model's reasoning controls (or creates a reasoning model). */
  reasoning?: true;
}

export interface Gap {
  provider: string;
  model: string;
  kind: "new" | "update" | "removal";
  reason: string;
  /** Field paths a person has to fill in. */
  missing: string[];
  known?: Observation;
}

export interface Risk {
  safe: boolean;
  reasons: string[];
  counts: {
    before: number;
    created: number;
    updated: number;
    deleted: number;
    deprecated: number;
    priceChanges: number;
    reasoningChanges: number;
    gaps: number;
  };
}

export interface SyncResult {
  provider: string;
  changes: Change[];
  gaps: Gap[];
  notices: string[];
  risk: Risk;
}
