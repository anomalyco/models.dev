import { ZodError } from "zod";

// A catalog row with a field in an unexpected shape (Kenari's `sunset_at` turning into a number) used to fail the whole
// provider. This drops only the rows the schema rejects and parses the rest. It gives up, and throws the original
// error, when the problem isn't inside a row or when too many rows would go.
const MAX_ROUNDS = 10;
const MAX_DROPPED_SHARE = 0.2;

export interface LenientResult<T> {
  models: T[];
  dropped: string[];
}

function rowPath(path: (string | number)[]): { container: (string | number)[]; index: number } | undefined {
  const at = path.findIndex((segment) => typeof segment === "number");
  if (at < 0) return undefined;
  return { container: path.slice(0, at), index: path[at] as number };
}

function get(value: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => (current as Record<string | number, unknown> | undefined)?.[key], value);
}

const describe = (row: unknown) => {
  const record = row as Record<string, unknown> | undefined;
  const id = record?.id ?? record?.model ?? record?.name ?? record?.slug;
  return typeof id === "string" ? id : "a row";
};

export function parseLeniently<T>(parse: (raw: unknown) => T[], raw: unknown): LenientResult<T> {
  const dropped: string[] = [];
  let current = raw;
  let firstError: unknown;
  let total: number | undefined;
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    try {
      return { models: parse(current), dropped };
    } catch (error) {
      firstError ??= error;
      if (!(error instanceof ZodError) || round === MAX_ROUNDS) throw firstError;
      const rows = new Map<string, { container: (string | number)[]; indexes: Set<number>; reasons: string[] }>();
      for (const issue of error.issues) {
        const row = rowPath(issue.path);
        if (row === undefined) throw firstError;
        const key = JSON.stringify(row.container);
        const entry = rows.get(key) ?? { container: row.container, indexes: new Set(), reasons: [] };
        entry.indexes.add(row.index);
        entry.reasons.push(`${issue.path.slice(row.container.length + 1).join(".") || "row"}: ${issue.message}`);
        rows.set(key, entry);
      }
      current = structuredClone(current);
      for (const { container, indexes, reasons } of rows.values()) {
        const list = get(current, container);
        if (!Array.isArray(list)) throw firstError;
        total ??= list.length;
        for (const index of [...indexes].sort((a, b) => b - a)) {
          dropped.push(`${describe(list[index])} (${reasons.join("; ")})`);
          list.splice(index, 1);
        }
      }
      if (total !== undefined && dropped.length > Math.max(1, Math.floor(total * MAX_DROPPED_SHARE))) throw firstError;
    }
  }
  throw firstError;
}
