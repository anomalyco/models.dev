export const ALL_COLUMN_IDS = [
  "provider",
  "model",
  "family",
  "provider-id",
  "model-id",
  "tool-call",
  "reasoning",
  "input-modalities",
  "output-modalities",
  "input-cost",
  "output-cost",
  "reasoning-cost",
  "cache-read-cost",
  "cache-write-cost",
  "audio-input-cost",
  "audio-output-cost",
  "context-limit",
  "input-limit",
  "output-limit",
  "structured-output",
  "temperature",
  "weights",
  "knowledge",
  "release-date",
  "last-updated",
] as const;

export type ColumnId = (typeof ALL_COLUMN_IDS)[number];

export const DEFAULT_COLUMN_IDS: string[] = [
  "provider",
  "model",
  "family",
  "model-id",
  "tool-call",
  "reasoning",
  "input-cost",
  "output-cost",
  "context-limit",
];

export type UrlState = {
  search: string;
  sort: string | null;
  order: "asc" | "desc";
  cols: string[];
};

export function parseUrlState(params: URLSearchParams): UrlState {
  const colsParam = params.get("cols");
  const cols = colsParam
    ? colsParam
        .split(",")
        .filter((c) => (ALL_COLUMN_IDS as readonly string[]).includes(c))
    : [...DEFAULT_COLUMN_IDS];

  return {
    search: params.get("search") ?? "",
    sort: params.get("sort"),
    order: params.get("order") === "desc" ? "desc" : "asc",
    cols: cols.length > 0 ? cols : [...DEFAULT_COLUMN_IDS],
  };
}

export function serializeUrlState(state: UrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.sort) {
    params.set("sort", state.sort);
    if (state.order !== "asc") params.set("order", state.order);
  }
  const isDefault =
    state.cols.length === DEFAULT_COLUMN_IDS.length &&
    DEFAULT_COLUMN_IDS.every((id) => state.cols.includes(id));
  if (!isDefault) params.set("cols", state.cols.join(","));
  return params;
}
