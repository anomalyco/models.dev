export interface SearchIndexItem {
  type: "model" | "provider" | "lab";
  title: string;
  id: string;
  href: string;
  logo: string;
  tokens: string[];
  lab?: string;
  modelCount?: number;
  providerCount?: number;
  context?: number;
  releaseDate?: string;
  inputCost?: number;
  outputCost?: number;
  description?: string;
  npm?: string;
  api?: string;
  updated?: string;
}

export interface SearchResult {
  item: SearchIndexItem;
  score: number;
}

// Keep decimal versions intact: 2.5 must never match 3.5 or a release date.
export function normalizeSearchText(value: string) {
  return (value.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? []).join(" ");
}

// One edit (including an adjacent transposition), restricted to alphabetic words.
function nearWord(a: string, b: string) {
  if (!/^[a-z]{4,}$/.test(a) || !/^[a-z]{4,}$/.test(b)) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differences = [...a].map((c, i) => c === b[i] ? -1 : i).filter(i => i >= 0);
    if (differences.length <= 1) return true;
    const [i, j] = differences;
    return differences.length === 2 && j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

function matchTerm(words: string[], term: string) {
  if (words.includes(term)) return 100;
  // Numeric tokens are exact, even during incremental typing.
  if (/\d/.test(term)) return 0;
  if (words.some(word => word.startsWith(term))) return 75;
  return words.some(word => nearWord(word, term)) ? 45 : 0;
}

interface SearchDocument {
  title: string;
  id: string;
  words: string[];
  metadata: string[];
}
const documents = new WeakMap<SearchIndexItem, SearchDocument>();
function documentFor(item: SearchIndexItem) {
  let doc = documents.get(item);
  if (doc) return doc;
  const title = normalizeSearchText(item.title);
  const id = normalizeSearchText(item.id);
  doc = {
    title, id,
    words: [...new Set(`${title} ${id} ${normalizeSearchText(item.lab ?? "")}`.split(" ").filter(Boolean))],
    // Labs/providers must match their own identity, not models they happen to host.
    metadata: item.type === "model"
      ? [...new Set(item.tokens.flatMap(token => normalizeSearchText(token).split(" ")))] : [],
  };
  documents.set(item, doc);
  return doc;
}

function scoreSearchItem(item: SearchIndexItem, query: string) {
  if (!query) return 1;
  const doc = documentFor(item);
  const compact = query.replace(/ /g, "");
  if ([doc.title, doc.id].some(field => field === query || field.replace(/ /g, "") === compact)) {
    return 10000 - doc.id.split(" ").length;
  }
  const terms = query.split(" ");
  let score = 0;
  let metadataMatches = 0;
  for (const term of terms) {
    const primary = matchTerm(doc.words, term);
    if (primary) {
      score += primary;
      continue;
    }
    // Never source model versions from descriptions, provider aliases, or dates.
    if (/\d/.test(term) || !doc.metadata.includes(term)) return 0;
    metadataMatches++;
  }
  if (metadataMatches) return 10 + score / 100;
  // All identity terms outrank metadata matches; fewer unrequested words favor
  // the base model over Lite, Image, TTS, and dated previews.
  return 1000 + score - Math.max(0, doc.words.length - terms.length) * 12;
}

export function rankSearchItems(searchItems: SearchIndexItem[], query: string) {
  const normalizedQuery = normalizeSearchText(query);
  const results = searchItems
    .map((item) => ({ item, score: scoreSearchItem(item, normalizedQuery) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateComparison = compareSearchDates(
        searchSortDate(a.item),
        searchSortDate(b.item),
      );
      if (dateComparison !== 0) return dateComparison;
      return a.item.title.localeCompare(b.item.title, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  return normalizedQuery ? results.slice(0, 40) : results.slice(0, 18);
}

function compareSearchDates(a?: string, b?: string) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b.localeCompare(a);
}

function searchSortDate(item: SearchIndexItem) {
  return item.releaseDate ?? item.updated;
}

