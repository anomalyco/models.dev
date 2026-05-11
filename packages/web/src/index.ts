import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import {
  type TableRow,
  renderRow,
  escapeHtml,
  booleanText,
  knowledgeText,
  weightsText,
} from "./shared.js";

declare global {
  interface Window {
    __TABLE_DATA__: TableRow[];
  }
}

interface VirtualizedRow extends TableRow {
  key: string;
  searchText: string;
  sortValues: Array<string | number | undefined>;
}

type SortDirection = "asc" | "desc";

const ESTIMATED_ROW_HEIGHT = 48;
const VIRTUAL_OVERSCAN = 5;

const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;
const viewport = document.getElementById("table-viewport") as HTMLElement;
const tbody = document.getElementById(
  "models-table-body"
) as HTMLTableSectionElement;
const headers = Array.from(document.querySelectorAll("th.sortable"));
const columnCount = document.querySelectorAll("thead th").length;

let isLoaded = false;
let allRows: VirtualizedRow[] = [];
let visibleRows: VirtualizedRow[] = [];
let currentSort: { column: number; direction: SortDirection } = {
  column: -1,
  direction: "asc",
};

/////////////////////////
// URL State Management
/////////////////////////
function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function updateQueryParams(updates: Record<string, string | null>) {
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
  window.history.pushState({}, "", newPath);
}

function getColumnNameForURL(headerEl: Element): string {
  const text = headerEl.textContent?.trim().toLowerCase() || "";
  return text.replace(/↑|↓/g, "").trim().split(/\s+/).slice(0, 2).join("-");
}

function getColumnIndexByUrlName(name: string): number {
  return headers.findIndex((header) => getColumnNameForURL(header) === name);
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

////////////////////
// Row Data
////////////////////
function lockColumnWidths() {
  const ths = document.querySelectorAll("#models-table thead th");
  const widths = Array.from(ths).map((th) => th.getBoundingClientRect().width);

  const measurementRow = tbody.querySelector('tr[aria-hidden="true"]');
  if (measurementRow) measurementRow.remove();

  const table = document.getElementById("models-table")!;
  table.style.tableLayout = "fixed";

  const colgroup = document.createElement("colgroup");
  for (const width of widths) {
    const col = document.createElement("col");
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }
  table.insertBefore(colgroup, table.firstChild);
}

function prepareRow(row: TableRow): VirtualizedRow {
  const sortValues: VirtualizedRow["sortValues"] = [
    row.providerName,
    row.modelName,
    row.family,
    row.providerId,
    row.modelId,
    booleanText(row.toolCall),
    booleanText(row.reasoning),
    row.input.length,
    row.output.length,
    row.inputCost,
    row.outputCost,
    row.reasoningCost,
    row.cacheReadCost,
    row.cacheWriteCost,
    row.audioInputCost,
    row.audioOutputCost,
    row.imageInputCost,
    row.videoInputCost,
    row.contextLimit,
    row.inputLimit,
    row.outputLimit,
    row.structuredOutput === undefined
      ? undefined
      : booleanText(row.structuredOutput),
    booleanText(row.temperature),
    weightsText(row.openWeights),
    row.knowledge ? knowledgeText(row.knowledge) : undefined,
    row.releaseDate,
    row.lastUpdated,
  ];

  const searchableValues = [
    row.providerName,
    row.modelName,
    row.family ?? "",
    row.providerId,
    row.modelId,
    row.releaseDate,
    row.lastUpdated,
  ];

  return {
    ...row,
    key: `${row.providerId}/${row.modelId}`,
    searchText: searchableValues.join(" ").toLowerCase(),
    sortValues,
  };
}

////////////////////
// Virtual Table
////////////////////
function getVirtualizerOptions(count: number) {
  return {
    count,
    getScrollElement: () => viewport,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index: number) => visibleRows[index]?.key ?? index,
    initialRect: {
      width: viewport.clientWidth || window.innerWidth,
      height: viewport.clientHeight || window.innerHeight,
    },
    overscan: VIRTUAL_OVERSCAN,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: () => renderVirtualRows(),
  };
}

const virtualizer = new Virtualizer<HTMLElement, HTMLTableRowElement>(
  getVirtualizerOptions(0)
);
const cleanupVirtualizer = virtualizer._didMount();
virtualizer._willUpdate();
window.addEventListener("pagehide", () => cleanupVirtualizer());

function renderStatusRow(message: string) {
  tbody.innerHTML = `<tr class="empty-row"><td colspan="${columnCount}"><div>${escapeHtml(
    message
  )}</div></td></tr>`;
}

function setVirtualizerCount(count: number, resetScroll: boolean) {
  virtualizer.setOptions(getVirtualizerOptions(count));
  virtualizer._willUpdate();
  if (resetScroll) virtualizer.scrollToOffset(0);
  renderVirtualRows();
}

function renderVirtualRows() {
  if (!isLoaded) return;
  if (visibleRows.length === 0) {
    renderStatusRow("No models found");
    return;
  }

  const virtualRows = virtualizer.getVirtualItems();
  if (virtualRows.length === 0) return;

  const firstRow = virtualRows[0]!;
  const lastRow = virtualRows[virtualRows.length - 1]!;
  const paddingTop = firstRow.start;
  const paddingBottom = Math.max(virtualizer.getTotalSize() - lastRow.end, 0);
  const html: string[] = [];

  if (paddingTop > 0) html.push(renderSpacerRow(paddingTop));
  for (const virtualRow of virtualRows) {
    const row = visibleRows[virtualRow.index];
    if (row) html.push(renderRow(row, virtualRow.index));
  }
  if (paddingBottom > 0) html.push(renderSpacerRow(paddingBottom));

  tbody.innerHTML = html.join("");
  tbody.querySelectorAll<HTMLTableRowElement>("tr[data-index]").forEach((row) =>
    virtualizer.measureElement(row)
  );
}

function renderSpacerRow(height: number) {
  return `<tr class="virtual-spacer" style="height: ${height}px"><td colspan="${columnCount}"></td></tr>`;
}

function applyRows(resetScroll = true) {
  if (!isLoaded) return;
  visibleRows = getRowsForDisplay();
  setVirtualizerCount(visibleRows.length, resetScroll);
}

////////////////////
// Sorting
////////////////////
function getRowsForDisplay() {
  const terms = search.value
    .toLowerCase()
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  const filteredRows =
    terms.length === 0
      ? allRows
      : allRows.filter((row) =>
          terms.some((term) => row.searchText.includes(term))
        );

  if (currentSort.column === -1) return filteredRows;

  const columnType = headers[currentSort.column]?.getAttribute("data-type");
  if (!columnType) return filteredRows;

  return [...filteredRows].sort((a, b) => {
    const aValue = a.sortValues[currentSort.column];
    const bValue = b.sortValues[currentSort.column];

    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    let comparison = 0;
    if (columnType === "number" || columnType === "modalities") {
      comparison = (aValue as number) - (bValue as number);
    } else {
      comparison = String(aValue).localeCompare(String(bValue));
    }

    return currentSort.direction === "asc" ? comparison : -comparison;
  });
}

function sortTable(
  column: number,
  direction: SortDirection,
  updateURL = true
) {
  const header = headers[column];
  if (!header?.getAttribute("data-type")) return;

  currentSort = { column, direction };
  if (updateURL) {
    updateQueryParams({
      sort: getColumnNameForURL(header),
      order: direction,
    });
  }

  updateSortIndicators();
  applyRows();
}

function updateSortIndicators() {
  headers.forEach((header, i) => {
    const indicator = header.querySelector(".sort-indicator")!;
    indicator.textContent =
      i === currentSort.column
        ? currentSort.direction === "asc"
          ? "↑"
          : "↓"
        : "";
  });
}

headers.forEach((header, column) => {
  header.addEventListener("click", () => {
    const direction =
      currentSort.column === column && currentSort.direction === "asc"
        ? "desc"
        : "asc";
    sortTable(column, direction);
  });
});

///////////////////
// Search
///////////////////
search.addEventListener("input", () => {
  updateQueryParams({ search: search.value || null });
  applyRows();
});

document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "f")) {
    e.preventDefault();
    search.focus();
    search.select();
  }
});

search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    search.dispatchEvent(new Event("input"));
  }
});

///////////////////////////////////
// Handle Copy model ID function
///////////////////////////////////
async function copyModelId(button: HTMLButtonElement, modelId: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(modelId);

      // Switch to check icon
      const copyIcon = button.querySelector(".copy-icon") as HTMLElement;
      const checkIcon = button.querySelector(".check-icon") as HTMLElement;

      copyIcon.style.display = "none";
      checkIcon.style.display = "block";

      // Switch back after 1 second
      setTimeout(() => {
        copyIcon.style.display = "block";
        checkIcon.style.display = "none";
      }, 1000);
    }
  } catch (err) {
    console.error("Failed to copy text: ", err);
  }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(
    ".copy-button[data-model-id]"
  );
  if (!button) return;

  const modelId = button.dataset.modelId;
  if (modelId) void copyModelId(button, modelId);
});

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
function initializeFromURL() {
  const params = getQueryParams();

  search.value = params.get("search") ?? "";

  currentSort = { column: -1, direction: "asc" };
  const columnName = params.get("sort");
  if (columnName) {
    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex !== -1) {
      currentSort = {
        column: columnIndex,
        direction: params.get("order") === "desc" ? "desc" : "asc",
      };
    }
  }

  updateSortIndicators();
  applyRows(false);
}

function loadRows() {
  try {
    allRows = window.__TABLE_DATA__.map(prepareRow);
    lockColumnWidths();
    isLoaded = true;
    initializeFromURL();
  } catch (error) {
    console.error(error);
    isLoaded = true;
    visibleRows = [];
    renderStatusRow("Failed to load model data");
  }
}

loadRows();
window.addEventListener("popstate", initializeFromURL);
