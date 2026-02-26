import MiniSearch from "minisearch";
import type { Row } from "./data.js";

const SEARCH_FIELDS = ["providerName", "name", "modelId", "providerId", "family"] as const;

let searchIndex: MiniSearch | null = null;
let indexedRows: Row[] = [];

export function buildSearchIndex(rows: Row[]): void {
  indexedRows = rows;
  searchIndex = new MiniSearch({
    fields: [...SEARCH_FIELDS],
    storeFields: [],
    idField: "_searchId",
    searchOptions: {
      fuzzy: 0.2,
      prefix: true,
      boost: { name: 2, providerName: 1.5 },
    },
  });
  const docs = rows.map((row, i) => ({
    _searchId: i,
    providerName: row.providerName,
    name: row.name,
    modelId: row.modelId,
    providerId: row.providerId,
    family: row.family ?? "",
  }));
  searchIndex.addAll(docs);
}

export function searchRows(query: string): Row[] | null {
  if (!searchIndex || !query.trim()) return null;
  const terms = query.split(",").map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return null;

  // Collect results with scores for proper relevance ordering
  const scoreMap = new Map<number, number>();
  for (const term of terms) {
    const results = searchIndex.search(term, { fuzzy: 0.2, prefix: true });
    for (const r of results) {
      const idx = r.id as number;
      scoreMap.set(idx, Math.max(scoreMap.get(idx) ?? 0, r.score));
    }
  }

  // Sort by relevance score descending
  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([idx]) => indexedRows[idx]);
}

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced as T & { cancel(): void };
}
