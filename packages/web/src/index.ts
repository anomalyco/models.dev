import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";

declare global {
  interface Window {
    __TABLE_DATA__: TableRowData[];
  }
}

type TableRowData = [
  providerId: string,
  providerName: string,
  modelId: string,
  modelName: string,
  family: string | null,
  toolCall: boolean,
  reasoning: boolean,
  input: string[],
  output: string[],
  inputCost: number | null,
  outputCost: number | null,
  reasoningCost: number | null,
  cacheReadCost: number | null,
  cacheWriteCost: number | null,
  audioInputCost: number | null,
  audioOutputCost: number | null,
  contextLimit: number,
  inputLimit: number | null,
  outputLimit: number,
  structuredOutput: boolean | null,
  temperature: boolean,
  openWeights: boolean,
  knowledge: string | null,
  releaseDate: string,
  lastUpdated: string,
];

interface TableRowFields {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  family?: string;
  toolCall: boolean;
  reasoning: boolean;
  input: string[];
  output: string[];
  inputCost?: number;
  outputCost?: number;
  reasoningCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  audioInputCost?: number;
  audioOutputCost?: number;
  contextLimit: number;
  inputLimit?: number;
  outputLimit: number;
  structuredOutput?: boolean;
  temperature: boolean;
  openWeights: boolean;
  knowledge?: string;
  releaseDate: string;
  lastUpdated: string;
}

interface TableRow extends TableRowFields {
  key: string;
  searchText: string;
  sortValues: Array<string | number | undefined>;
}

type SortDirection = "asc" | "desc";

const ESTIMATED_ROW_HEIGHT = 47;
const VIRTUAL_OVERSCAN = 200;

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
let allRows: TableRow[] = [];
let visibleRows: TableRow[] = [];
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
function booleanText(value: boolean) {
  return value ? "Yes" : "No";
}

function optionalBooleanText(value?: boolean) {
  return value === undefined ? "-" : booleanText(value);
}

function formatCost(cost?: number) {
  return cost === undefined ? "-" : `$${cost.toFixed(2)}`;
}

function formatNumber(value?: number) {
  return value === undefined ? "-" : value.toLocaleString();
}

function knowledgeText(value?: string) {
  return value ? value.substring(0, 7) : "-";
}

function weightsText(value: boolean) {
  return value ? "Open" : "Closed";
}

function optional<T>(value: T | null) {
  return value === null ? undefined : value;
}

function hydrateRow(row: TableRowData): TableRow {
  const [
    providerId,
    providerName,
    modelId,
    modelName,
    family,
    toolCall,
    reasoning,
    input,
    output,
    inputCost,
    outputCost,
    reasoningCost,
    cacheReadCost,
    cacheWriteCost,
    audioInputCost,
    audioOutputCost,
    contextLimit,
    inputLimit,
    outputLimit,
    structuredOutput,
    temperature,
    openWeights,
    knowledge,
    releaseDate,
    lastUpdated,
  ] = row;
  const fields: TableRowFields = {
    providerId,
    providerName,
    modelId,
    modelName,
    family: optional(family),
    toolCall,
    reasoning,
    input,
    output,
    inputCost: optional(inputCost),
    outputCost: optional(outputCost),
    reasoningCost: optional(reasoningCost),
    cacheReadCost: optional(cacheReadCost),
    cacheWriteCost: optional(cacheWriteCost),
    audioInputCost: optional(audioInputCost),
    audioOutputCost: optional(audioOutputCost),
    contextLimit,
    inputLimit: optional(inputLimit),
    outputLimit,
    structuredOutput: optional(structuredOutput),
    temperature,
    openWeights,
    knowledge: optional(knowledge),
    releaseDate,
    lastUpdated,
  };
  const sortValues: TableRow["sortValues"] = [
    fields.providerName,
    fields.modelName,
    fields.family,
    fields.providerId,
    fields.modelId,
    booleanText(fields.toolCall),
    booleanText(fields.reasoning),
    fields.input.length,
    fields.output.length,
    fields.inputCost,
    fields.outputCost,
    fields.reasoningCost,
    fields.cacheReadCost,
    fields.cacheWriteCost,
    fields.audioInputCost,
    fields.audioOutputCost,
    fields.contextLimit,
    fields.inputLimit,
    fields.outputLimit,
    fields.structuredOutput === undefined
      ? undefined
      : booleanText(fields.structuredOutput),
    booleanText(fields.temperature),
    weightsText(fields.openWeights),
    fields.knowledge ? knowledgeText(fields.knowledge) : undefined,
    fields.releaseDate,
    fields.lastUpdated,
  ];

  const searchableValues = [
    fields.providerName,
    fields.modelName,
    fields.family ?? "",
    fields.providerId,
    fields.modelId,
    booleanText(fields.toolCall),
    booleanText(fields.reasoning),
    fields.input.join(" "),
    fields.output.join(" "),
    formatCost(fields.inputCost),
    formatCost(fields.outputCost),
    formatCost(fields.reasoningCost),
    formatCost(fields.cacheReadCost),
    formatCost(fields.cacheWriteCost),
    formatCost(fields.audioInputCost),
    formatCost(fields.audioOutputCost),
    formatNumber(fields.contextLimit),
    formatNumber(fields.inputLimit),
    formatNumber(fields.outputLimit),
    optionalBooleanText(fields.structuredOutput),
    booleanText(fields.temperature),
    weightsText(fields.openWeights),
    knowledgeText(fields.knowledge),
    fields.releaseDate,
    fields.lastUpdated,
  ];

  return {
    ...fields,
    key: `${fields.providerId}/${fields.modelId}`,
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
  tbody.innerHTML = `<tr class="empty-row"><td colspan="${columnCount}">${escapeHtml(
    message
  )}</td></tr>`;
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

function focusSearch() {
  search.focus();
  search.select();
}

document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "f")) {
    e.preventDefault();
    focusSearch();
  }
});

search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    search.dispatchEvent(new Event("input"));
  }
});

///////////////////////////////////
// Copy model ID
///////////////////////////////////
async function copyModelId(button: HTMLButtonElement, modelId: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(modelId);

      const copyIcon = button.querySelector(".copy-icon") as HTMLElement;
      const checkIcon = button.querySelector(".check-icon") as HTMLElement;

      copyIcon.style.display = "none";
      checkIcon.style.display = "block";

      setTimeout(() => {
        copyIcon.style.display = "block";
        checkIcon.style.display = "none";
      }, 1000);
    }
  } catch (err) {
    console.error("Failed to copy text: ", err);
  }
}

(window as any).copyModelId = copyModelId;

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
// Row HTML
///////////////////////////////////
const MODALITY_ICONS: Record<string, string> = {
  text: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,7 4,4 20,4 20,7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  image: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>`,
  audio: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  video: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"></path><rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect></svg>`,
  pdf: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14,2 14,8 20,8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10,9 9,9 8,9"></polyline></svg>`,
};

function escapeHtml(value: string | number) {
  return String(value).replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function renderModalityIcon(modality: string) {
  const label = modality === "pdf" ? "PDF" : modality[0]!.toUpperCase() + modality.slice(1);
  const icon = MODALITY_ICONS[modality];
  if (!icon) return "";
  return `<span class="modality-icon" data-tooltip="${label}">${icon}</span>`;
}

function renderModalities(modalities: string[]) {
  return `<div class="modalities">${modalities
    .map(renderModalityIcon)
    .join("")}</div>`;
}

function renderCopyButton(modelId: string) {
  const escapedModelId = escapeHtml(modelId);
  return `<button type="button" class="copy-button" data-model-id="${escapedModelId}" aria-label="Copy model ID"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;"><polyline points="20,6 9,17 4,12"></polyline></svg></button>`;
}

function renderRow(row: TableRow, index: number) {
  return `<tr data-index="${index}">
    <td><div class="provider-cell"><img src="/logos/${encodeURIComponent(
      row.providerId
    )}.svg" alt="" loading="lazy" decoding="async"><span>${escapeHtml(
    row.providerName
  )}</span></div></td>
    <td>${escapeHtml(row.modelName)}</td>
    <td>${escapeHtml(row.family ?? "-")}</td>
    <td>${escapeHtml(row.providerId)}</td>
    <td><div class="model-id-cell"><span class="model-id-text">${escapeHtml(
      row.modelId
    )}</span>${renderCopyButton(row.modelId)}</div></td>
    <td>${booleanText(row.toolCall)}</td>
    <td>${booleanText(row.reasoning)}</td>
    <td>${renderModalities(row.input)}</td>
    <td>${renderModalities(row.output)}</td>
    <td>${formatCost(row.inputCost)}</td>
    <td>${formatCost(row.outputCost)}</td>
    <td>${formatCost(row.reasoningCost)}</td>
    <td>${formatCost(row.cacheReadCost)}</td>
    <td>${formatCost(row.cacheWriteCost)}</td>
    <td>${formatCost(row.audioInputCost)}</td>
    <td>${formatCost(row.audioOutputCost)}</td>
    <td>${formatNumber(row.contextLimit)}</td>
    <td>${formatNumber(row.inputLimit)}</td>
    <td>${formatNumber(row.outputLimit)}</td>
    <td>${optionalBooleanText(row.structuredOutput)}</td>
    <td>${booleanText(row.temperature)}</td>
    <td>${weightsText(row.openWeights)}</td>
    <td>${knowledgeText(row.knowledge)}</td>
    <td>${escapeHtml(row.releaseDate)}</td>
    <td>${escapeHtml(row.lastUpdated)}</td>
  </tr>`;
}

///////////////////////////////////
// Initialize State
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
    allRows = window.__TABLE_DATA__.map(hydrateRow);
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
