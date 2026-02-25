import MiniSearch from 'minisearch';
import type { Row } from './data.js';

// Fields to index — deliberately excludes cost values, booleans, limits, dates
const SEARCH_FIELDS = ['providerName', 'name', 'modelId', 'providerId', 'family'] as const;

export const SEARCH_FIELD_NAMES = [...SEARCH_FIELDS]; // exported for testing

let searchIndex: MiniSearch | null = null;

export function buildSearchIndex(rows: Row[]): void {
  // Create MiniSearch instance
  // IMPORTANT: modelId is NOT unique across providers (same model appears under multiple providers)
  // Use array index as the unique ID field
  searchIndex = new MiniSearch({
    fields: [...SEARCH_FIELDS],
    storeFields: [],
    idField: '_searchId',
    searchOptions: {
      fuzzy: 0.2,       // typo tolerance
      prefix: true,      // prefix matching ("claud" matches "claude")
      boost: { name: 2, providerName: 1.5 }, // relevance weighting
    },
  });

  // Add rows with composite IDs (array index)
  const docs = rows.map((row, i) => ({
    _searchId: i,
    providerName: row.providerName,
    name: row.name,
    modelId: row.modelId,
    providerId: row.providerId,
    family: row.family ?? '',
  }));
  searchIndex.addAll(docs);
}

export function searchRows(query: string, rows: Row[]): Row[] | null {
  if (!searchIndex || !query.trim()) return null; // null = show all (no filter)

  // Support comma-separated OR terms
  const terms = query.split(',').map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return null;

  // Union of results for each term (OR logic)
  const matchedIndices = new Set<number>();
  for (const term of terms) {
    const results = searchIndex.search(term, { fuzzy: 0.2, prefix: true });
    for (const r of results) {
      matchedIndices.add(r.id as number);
    }
  }

  return Array.from(matchedIndices).map(i => rows[i]);
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
