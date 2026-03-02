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

function getColumnNameForURL(headerEl: Element): string {
  const text = headerEl.textContent?.trim().toLowerCase() || "";
  return text.replace(/↑|↓/g, "").trim().split(/\s+/).slice(0, 2).join("-");
}

function getColumnIndexByUrlName(name: string): number {
  const headers = document.querySelectorAll("th.sortable");
  return Array.from(headers).findIndex(
    (header) => getColumnNameForURL(header) === name
  );
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
let currentSort = { column: -1, direction: "asc" as "asc" | "desc" };
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

function buildRowSearchText(row: {
  providerName: string;
  providerId: string;
  modelId: string;
  model: ModelData;
}): string {
  const model = row.model;
  return [
    row.providerName,
    model.name,
    model.family ?? "-",
    row.providerId,
    row.modelId,
    model.tool_call ? "yes" : "no",
    model.reasoning ? "yes" : "no",
    model.modalities.input.join(" "),
    model.modalities.output.join(" "),
    renderCost(model.cost?.input),
    renderCost(model.cost?.output),
    renderCost(model.cost?.reasoning),
    renderCost(model.cost?.cache_read),
    renderCost(model.cost?.cache_write),
    renderCost(model.cost?.input_audio),
    renderCost(model.cost?.output_audio),
    model.limit.context.toLocaleString(),
    model.limit.input?.toLocaleString() ?? "-",
    model.limit.output.toLocaleString(),
    model.structured_output === undefined
      ? "-"
      : model.structured_output
      ? "yes"
      : "no",
    model.temperature ? "yes" : "no",
    model.open_weights ? "open" : "closed",
    model.knowledge ? model.knowledge.substring(0, 7) : "-",
    model.release_date,
    model.last_updated,
  ]
    .join(" ")
    .toLowerCase();
}

function createRow(row: RowData): HTMLTableRowElement {
  const model = row.model;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>
      <div class="provider-cell">
        <img src="/logos/${encodeURIComponent(row.providerId)}.svg" alt="${escapeHtml(row.providerName)} logo" loading="lazy" decoding="async" width="18" height="18" />
        <span>${escapeHtml(row.providerName)}</span>
      </div>
    </td>
    <td>${escapeHtml(model.name)}</td>
    <td>${escapeHtml(model.family ?? "-")}</td>
    <td>${escapeHtml(row.providerId)}</td>
    <td>
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
    </td>
    <td>${model.tool_call ? "Yes" : "No"}</td>
    <td>${model.reasoning ? "Yes" : "No"}</td>
    <td><div class="modalities">${renderModalityIcons(model.modalities.input)}</div></td>
    <td><div class="modalities">${renderModalityIcons(model.modalities.output)}</div></td>
    <td>${renderCost(model.cost?.input)}</td>
    <td>${renderCost(model.cost?.output)}</td>
    <td>${renderCost(model.cost?.reasoning)}</td>
    <td>${renderCost(model.cost?.cache_read)}</td>
    <td>${renderCost(model.cost?.cache_write)}</td>
    <td>${renderCost(model.cost?.input_audio)}</td>
    <td>${renderCost(model.cost?.output_audio)}</td>
    <td>${model.limit.context.toLocaleString()}</td>
    <td>${model.limit.input?.toLocaleString() ?? "-"}</td>
    <td>${model.limit.output.toLocaleString()}</td>
    <td>${model.structured_output === undefined ? "-" : model.structured_output ? "Yes" : "No"}</td>
    <td>${model.temperature ? "Yes" : "No"}</td>
    <td>${model.open_weights ? "Open" : "Closed"}</td>
    <td>${escapeHtml(model.knowledge ? model.knowledge.substring(0, 7) : "-")}</td>
    <td>${escapeHtml(model.release_date)}</td>
    <td>${escapeHtml(model.last_updated)}</td>
  `;
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
          return {
            ...base,
            searchText: buildRowSearchText(base),
          };
        })
    );
}

function setStatusRow(message: string) {
  tbody.innerHTML = `<tr><td colspan="25">${escapeHtml(message)}</td></tr>`;
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

function getSortValue(row: RowData, column: number, columnType: string) {
  const model = row.model;

  if (columnType === "modalities") {
    if (column === 7) return model.modalities.input.length;
    if (column === 8) return model.modalities.output.length;
    return 0;
  }

  if (columnType === "number") {
    switch (column) {
      case 9:
        return model.cost?.input;
      case 10:
        return model.cost?.output;
      case 11:
        return model.cost?.reasoning;
      case 12:
        return model.cost?.cache_read;
      case 13:
        return model.cost?.cache_write;
      case 14:
        return model.cost?.input_audio;
      case 15:
        return model.cost?.output_audio;
      case 16:
        return model.limit.context;
      case 17:
        return model.limit.input;
      case 18:
        return model.limit.output;
      default:
        return undefined;
    }
  }

  switch (column) {
    case 0:
      return row.providerName;
    case 1:
      return model.name;
    case 2:
      return model.family;
    case 3:
      return row.providerId;
    case 4:
      return row.modelId;
    case 5:
      return model.tool_call ? "Yes" : "No";
    case 6:
      return model.reasoning ? "Yes" : "No";
    case 19:
      return model.structured_output === undefined
        ? undefined
        : model.structured_output
        ? "Yes"
        : "No";
    case 20:
      return model.temperature ? "Yes" : "No";
    case 21:
      return model.open_weights ? "Open" : "Closed";
    case 22:
      return model.knowledge ? model.knowledge.substring(0, 7) : undefined;
    case 23:
      return model.release_date;
    case 24:
      return model.last_updated;
    default:
      return undefined;
  }
}

function updateSortIndicators(column: number) {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header, i) => {
    const indicator = header.querySelector(".sort-indicator")!;
    if (i === column) {
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

  if (currentSort.column >= 0) {
    const header = document.querySelectorAll("th.sortable")[currentSort.column];
    const columnType = header?.getAttribute("data-type") || "text";
    rows = [...rows].sort((a, b) => {
      const aValue = getSortValue(a, currentSort.column, columnType);
      const bValue = getSortValue(b, currentSort.column, columnType);

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

    const column = Array.from(header.parentElement!.children).indexOf(header);
    const direction =
      currentSort.column === column && currentSort.direction === "asc"
        ? "desc"
        : "asc";

    currentSort = { column, direction };
    refreshView();
    updateSortIndicators(column);
    updateQueryParams(
      {
        sort: getColumnNameForURL(header),
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
    currentSort = { column: -1, direction: "asc" };
    clearSortIndicators();
  } else {
    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex === -1) {
      currentSort = { column: -1, direction: "asc" };
      clearSortIndicators();
    } else {
      currentSort = { column: columnIndex, direction };
      updateSortIndicators(columnIndex);
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
