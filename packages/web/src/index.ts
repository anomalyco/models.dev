import { TABLE_COLUMNS, type TableColumnId } from "./columns";

const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;
const tbody = document.getElementById("models-tbody") as HTMLTableSectionElement;
const infiniteStatus = document.getElementById("infinite-status")!;
const infiniteSentinel = document.getElementById("infinite-sentinel")!;

const CHUNK_SIZE = 100;

interface ModelData {
  name: string;
  family?: string;
  tool_call: boolean;
  reasoning: boolean;
  modalities: {
    input: string[];
    output: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  structured_output?: boolean;
  temperature?: boolean;
  open_weights: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
  status?: string;
}

interface ProviderData {
  name: string;
  models: Record<string, ModelData>;
}

type ProvidersData = Record<string, ProviderData>;

interface RowData {
  providerId: string;
  providerName: string;
  modelId: string;
  model: ModelData;
  searchText: string;
}

type SortValue = string | number | undefined;
type SortAccessor = (row: RowData) => SortValue;
const COLUMN_IDS = new Set<TableColumnId>(TABLE_COLUMNS.map((column) => column.id));
const TABLE_COLUMN_BY_ID = new Map(TABLE_COLUMNS.map((column) => [column.id, column] as const));

/////////////////////////
// URL State Management
/////////////////////////
function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function updateQueryParams(
  updates: Record<string, string | null>,
  mode: "push" | "replace" = "push"
) {
  const params = getQueryParams();
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }
  const newPath = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;

  if (mode === "replace") {
    window.history.replaceState({}, "", newPath);
    return;
  }
  window.history.pushState({}, "", newPath);
}

function toColumnId(value: string | null): TableColumnId | null {
  if (!value) return null;
  if (COLUMN_IDS.has(value as TableColumnId)) {
    return value as TableColumnId;
  }
  return null;
}

function getColumnIdByUrlName(name: string): TableColumnId | null {
  const column = TABLE_COLUMNS.find((item) => item.urlName === name || item.id === name);
  return column?.id ?? null;
}

function getColumnUrlName(columnId: TableColumnId): string {
  return TABLE_COLUMN_BY_ID.get(columnId)?.urlName ?? columnId;
}

/////////////////////////
// Handle "How to use"
/////////////////////////
let y = 0;

help.addEventListener("click", () => {
  y = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${y}px`;
  modal.showModal();
});

function closeDialog() {
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, y);
}

modalClose.addEventListener("click", closeDialog);
modal.addEventListener("cancel", closeDialog);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeDialog();
});

/////////////////////////////
// Data Loading + Rendering
/////////////////////////////
let allRows: RowData[] = [];
let viewRows: RowData[] = [];
let isDataReady = false;
let isAppending = false;
let renderedCount = 0;
let currentSort = { columnId: null as TableColumnId | null, direction: "asc" as "asc" | "desc" };
let observer: IntersectionObserver | null = null;
const supportsIntersectionObserver = "IntersectionObserver" in window;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCost(cost?: number): string {
  return cost === undefined ? "-" : `$${cost.toFixed(2)}`;
}

function boolToYesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function optionalBoolToYesNo(value?: boolean): string | undefined {
  if (value === undefined) return undefined;
  return value ? "Yes" : "No";
}

function renderModalityIcons(modalities: string[]): string {
  const labels: Record<string, string> = {
    text: "Text",
    image: "Image",
    audio: "Audio",
    video: "Video",
    pdf: "PDF",
  };
  return modalities
    .map((modality) => {
      const label = labels[modality] ?? modality;
      return `<span class="modality-icon" data-tooltip="${escapeHtml(label)}">${escapeHtml(label[0] ?? "?")}</span>`;
    })
    .join("");
}

const SORT_ACCESSORS: Record<TableColumnId, SortAccessor> = {
  provider: (row) => row.providerName,
  model: (row) => row.model.name,
  family: (row) => row.model.family,
  "provider-id": (row) => row.providerId,
  "model-id": (row) => row.modelId,
  "tool-call": (row) => boolToYesNo(row.model.tool_call),
  reasoning: (row) => boolToYesNo(row.model.reasoning),
  "input-modalities": (row) => row.model.modalities.input.length,
  "output-modalities": (row) => row.model.modalities.output.length,
  "input-cost": (row) => row.model.cost?.input,
  "output-cost": (row) => row.model.cost?.output,
  "reasoning-cost": (row) => row.model.cost?.reasoning,
  "cache-read-cost": (row) => row.model.cost?.cache_read,
  "cache-write-cost": (row) => row.model.cost?.cache_write,
  "audio-input-cost": (row) => row.model.cost?.input_audio,
  "audio-output-cost": (row) => row.model.cost?.output_audio,
  "context-limit": (row) => row.model.limit.context,
  "input-limit": (row) => row.model.limit.input,
  "output-limit": (row) => row.model.limit.output,
  "structured-output": (row) => optionalBoolToYesNo(row.model.structured_output),
  temperature: (row) => boolToYesNo(!!row.model.temperature),
  weights: (row) => (row.model.open_weights ? "Open" : "Closed"),
  knowledge: (row) => row.model.knowledge?.substring(0, 7),
  "release-date": (row) => row.model.release_date,
  "last-updated": (row) => row.model.last_updated,
};

function stringifySortValue(value: SortValue): string {
  return value === undefined ? "-" : String(value);
}

function buildRowSearchText(row: RowData): string {
  return TABLE_COLUMNS.map((column) => {
    if (column.id === "input-modalities") {
      return row.model.modalities.input.join(" ");
    }
    if (column.id === "output-modalities") {
      return row.model.modalities.output.join(" ");
    }
    return stringifySortValue(SORT_ACCESSORS[column.id](row));
  })
    .join(" ")
    .toLowerCase();
}

function renderProviderCell(row: RowData): string {
  return `
    <div class="provider-cell">
      <img src="/logos/${encodeURIComponent(row.providerId)}.svg" alt="${escapeHtml(row.providerName)} logo" loading="lazy" decoding="async" width="18" height="18" />
      <span>${escapeHtml(row.providerName)}</span>
    </div>
  `;
}

function renderModelIdCell(row: RowData): string {
  return `
    <div class="model-id-cell">
      <span class="model-id-text">${escapeHtml(row.modelId)}</span>
      <button class="copy-button" data-model-id="${escapeHtml(row.modelId)}" aria-label="Copy model ID">
        <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
        <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
          <polyline points="20,6 9,17 4,12" />
        </svg>
      </button>
    </div>
  `;
}

const CELL_RENDERERS: Record<TableColumnId, (row: RowData) => string> = {
  provider: (row) => renderProviderCell(row),
  model: (row) => escapeHtml(row.model.name),
  family: (row) => escapeHtml(row.model.family ?? "-"),
  "provider-id": (row) => escapeHtml(row.providerId),
  "model-id": (row) => renderModelIdCell(row),
  "tool-call": (row) => boolToYesNo(row.model.tool_call),
  reasoning: (row) => boolToYesNo(row.model.reasoning),
  "input-modalities": (row) =>
    `<div class="modalities">${renderModalityIcons(row.model.modalities.input)}</div>`,
  "output-modalities": (row) =>
    `<div class="modalities">${renderModalityIcons(row.model.modalities.output)}</div>`,
  "input-cost": (row) => renderCost(row.model.cost?.input),
  "output-cost": (row) => renderCost(row.model.cost?.output),
  "reasoning-cost": (row) => renderCost(row.model.cost?.reasoning),
  "cache-read-cost": (row) => renderCost(row.model.cost?.cache_read),
  "cache-write-cost": (row) => renderCost(row.model.cost?.cache_write),
  "audio-input-cost": (row) => renderCost(row.model.cost?.input_audio),
  "audio-output-cost": (row) => renderCost(row.model.cost?.output_audio),
  "context-limit": (row) => row.model.limit.context.toLocaleString(),
  "input-limit": (row) => row.model.limit.input?.toLocaleString() ?? "-",
  "output-limit": (row) => row.model.limit.output.toLocaleString(),
  "structured-output": (row) => optionalBoolToYesNo(row.model.structured_output) ?? "-",
  temperature: (row) => boolToYesNo(!!row.model.temperature),
  weights: (row) => (row.model.open_weights ? "Open" : "Closed"),
  knowledge: (row) => escapeHtml(row.model.knowledge?.substring(0, 7) ?? "-"),
  "release-date": (row) => escapeHtml(row.model.release_date),
  "last-updated": (row) => escapeHtml(row.model.last_updated),
};

function createRow(row: RowData): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.innerHTML = TABLE_COLUMNS.map((column) =>
    `<td>${CELL_RENDERERS[column.id](row)}</td>`
  ).join("");
  return tr;
}

function flattenRows(providers: ProvidersData): RowData[] {
  return Object.entries(providers)
    .sort(([, providerA], [, providerB]) =>
      providerA.name.localeCompare(providerB.name)
    )
    .flatMap(([providerId, provider]) =>
      Object.entries(provider.models)
        .filter(([, model]) => model.status !== "alpha")
        .sort(([, modelA], [, modelB]) => modelA.name.localeCompare(modelB.name))
        .map(([modelId, model]) => {
          const base = {
            providerId,
            providerName: provider.name,
            modelId,
            model,
          };
          const row = {
            ...base,
            searchText: "",
          } as RowData;
          row.searchText = buildRowSearchText(row);
          return row;
        })
    );
}

function setStatusRow(message: string) {
  tbody.innerHTML = `<tr><td colspan="${TABLE_COLUMNS.length}">${escapeHtml(message)}</td></tr>`;
}

function updateInfiniteStatus() {
  if (!isDataReady) {
    infiniteStatus.textContent = "Loading models...";
    return;
  }

  if (viewRows.length === 0) {
    infiniteStatus.textContent = "No models found.";
    return;
  }

  if (renderedCount >= viewRows.length) {
    infiniteStatus.textContent = `Showing all ${viewRows.length.toLocaleString()} models`;
    return;
  }

  infiniteStatus.textContent = `Showing ${renderedCount.toLocaleString()} / ${viewRows.length.toLocaleString()} models`;
}

async function fetchProviders(): Promise<ProvidersData> {
  const candidates = ["/api.json", "/_api.json"];
  let lastError: unknown = null;

  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${endpoint}: ${response.status}`);
      }
      return (await response.json()) as ProvidersData;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Failed to load provider data");
}

function updateSortIndicators(columnId: TableColumnId) {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header) => {
    const indicator = header.querySelector(".sort-indicator")!;
    if (header.getAttribute("data-column-id") === columnId) {
      indicator.textContent = currentSort.direction === "asc" ? "↑" : "↓";
    } else {
      indicator.textContent = "";
    }
  });
}

function clearSortIndicators() {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header) => {
    const indicator = header.querySelector(".sort-indicator");
    if (indicator) indicator.textContent = "";
  });
}

function applySearchAndSort() {
  const terms = search.value
    .toLowerCase()
    .split(",")
    .map((str) => str.trim())
    .filter(Boolean);

  let rows = allRows;
  if (terms.length > 0) {
    rows = allRows.filter((row) =>
      terms.some((term) => row.searchText.includes(term))
    );
  }

  if (currentSort.columnId) {
    const accessor = SORT_ACCESSORS[currentSort.columnId];
    rows = [...rows].sort((a, b) => {
        const aValue = accessor(a);
        const bValue = accessor(b);

        if (aValue === undefined && bValue === undefined) return 0;
        if (aValue === undefined) return 1;
        if (bValue === undefined) return -1;

        let result = 0;
        if (typeof aValue === "number" && typeof bValue === "number") {
          result = aValue - bValue;
        } else {
          result = String(aValue).localeCompare(String(bValue));
        }

        return currentSort.direction === "asc" ? result : -result;
      });
  }

  viewRows = rows;
}

function clearRenderedRows() {
  renderedCount = 0;
  tbody.innerHTML = "";
}

function appendNextChunk() {
  if (!isDataReady || isAppending || renderedCount >= viewRows.length) {
    updateInfiniteStatus();
    return;
  }

  isAppending = true;
  const end = Math.min(renderedCount + CHUNK_SIZE, viewRows.length);
  const fragment = document.createDocumentFragment();
  for (let i = renderedCount; i < end; i++) {
    fragment.appendChild(createRow(viewRows[i]));
  }
  tbody.appendChild(fragment);
  renderedCount = end;
  isAppending = false;
  updateInfiniteStatus();
}

function appendAllRemainingChunks() {
  while (renderedCount < viewRows.length) {
    appendNextChunk();
  }
}

function refreshView() {
  applySearchAndSort();
  clearRenderedRows();

  if (viewRows.length === 0) {
    setStatusRow("No models found.");
    updateInfiniteStatus();
    return;
  }

  appendNextChunk();
  if (!supportsIntersectionObserver) {
    appendAllRemainingChunks();
  }
}

function ensureObserver() {
  if (observer || !supportsIntersectionObserver) return;

  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      appendNextChunk();
    },
    {
      root: null,
      rootMargin: "600px 0px",
      threshold: 0,
    }
  );
  observer.observe(infiniteSentinel);
}

////////////////////
// Handle Sorting
////////////////////
document.querySelectorAll("th.sortable").forEach((header) => {
  header.addEventListener("click", () => {
    if (!isDataReady) return;

    const columnId = toColumnId(header.getAttribute("data-column-id"));
    if (!columnId) return;

    const direction =
      currentSort.columnId === columnId && currentSort.direction === "asc"
        ? "desc"
        : "asc";

    currentSort = { columnId, direction };
    refreshView();
    updateSortIndicators(columnId);
    updateQueryParams(
      {
        sort: getColumnUrlName(columnId),
        order: direction,
      },
      "push"
    );
  });
});

///////////////////
// Handle Search
///////////////////
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
search.addEventListener("input", () => {
  if (!isDataReady) return;
  if (searchDebounceTimer !== undefined) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    refreshView();
    updateQueryParams(
      {
        search: search.value || null,
      },
      "replace"
    );
  }, 120);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    search.focus();
  }
});

search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    if (isDataReady) {
      search.dispatchEvent(new Event("input"));
    }
  }
});

///////////////////////////////////
// Handle Copy model ID function
///////////////////////////////////
async function copyModelId(button: HTMLButtonElement, modelId: string) {
  try {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(modelId);

    const copyIcon = button.querySelector(".copy-icon") as HTMLElement;
    const checkIcon = button.querySelector(".check-icon") as HTMLElement;

    copyIcon.style.display = "none";
    checkIcon.style.display = "block";

    setTimeout(() => {
      copyIcon.style.display = "block";
      checkIcon.style.display = "none";
    }, 1000);
  } catch (err) {
    console.error("Failed to copy text: ", err);
  }
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest("button.copy-button") as
    | HTMLButtonElement
    | null;
  if (!button) return;
  const modelId = button.dataset.modelId;
  if (!modelId) return;
  void copyModelId(button, modelId);
});

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
function applyStateFromURL() {
  const params = getQueryParams();

  const searchQuery = params.get("search") ?? "";
  search.value = searchQuery;

  const columnName = params.get("sort");
  const direction = (params.get("order") as "asc" | "desc") || "asc";

  if (!columnName) {
    currentSort = { columnId: null, direction: "asc" };
    clearSortIndicators();
  } else {
    const columnId = getColumnIdByUrlName(columnName);
    if (!columnId) {
      currentSort = { columnId: null, direction: "asc" };
      clearSortIndicators();
    } else {
      currentSort = { columnId, direction };
      updateSortIndicators(columnId);
    }
  }

  if (isDataReady) {
    refreshView();
  }
}

async function initializePage() {
  search.disabled = true;
  updateInfiniteStatus();
  applyStateFromURL();

  try {
    const providers = await fetchProviders();
    allRows = flattenRows(providers);
    isDataReady = true;
    search.disabled = false;
    ensureObserver();
    applyStateFromURL();
  } catch (error) {
    console.error(error);
    setStatusRow("Failed to load models data.");
    infiniteStatus.textContent = "Load failed";
    search.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void initializePage();
});

window.addEventListener("popstate", () => {
  applyStateFromURL();
});
