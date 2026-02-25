import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  type VisibilityState,
} from "@tanstack/table-core";
import {
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/virtual-core";
import { type ColumnMeta, columnDefs } from "./columns";
import { flattenProviders, type Row } from "./data";
import { buildSearchIndex, searchRows, debounce } from "./search";
import {
  ALL_COLUMN_IDS,
  DEFAULT_COLUMN_IDS,
  parseUrlState,
  serializeUrlState,
} from "./url-state";

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const scrollContainer = document.getElementById(
  "table-scroll-container",
) as HTMLDivElement;
const tableHead = document.getElementById(
  "table-head",
) as HTMLTableSectionElement;
const tableBody = document.getElementById(
  "table-body",
) as HTMLTableSectionElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const columnsToggle = document.getElementById(
  "columns-toggle",
) as HTMLButtonElement;
const columnsPicker = document.getElementById(
  "columns-picker",
) as HTMLDivElement;
const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close") as HTMLButtonElement;
const helpButton = document.getElementById("help") as HTMLButtonElement;

// ─── State ────────────────────────────────────────────────────────────────────
let allRows: Row[] = [];
let rows: Row[] = [];
let sorting: SortingState = [];
let globalFilter = "";
let columnVisibility: VisibilityState = {};
let computedColumnSizes: Partial<Record<string, number>> = {};

function textWidthPx(length: number, mono = false): number {
  return length * (mono ? 8 : 7);
}

function maxLength<T>(items: T[], getLength: (item: T) => number): number {
  let max = 0;
  for (const item of items) max = Math.max(max, getLength(item));
  return max;
}

function formatCost(value: number | undefined): string {
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

function formatNumber(value: number | undefined): string {
  return value == null ? "-" : value.toLocaleString();
}

function computeColumnSizes(data: Row[]): Partial<Record<string, number>> {
  const tdHorizontalPaddingPx = 24;
  const sortIndicatorPx = 18;
  const extraSafetyPx = 16;
  const iconSizePx = 16;
  const iconGapPx = 6;
  const copyButtonWidthPx = 30;
  const modalityIconWidthPx = 20;
  const modalityIconGapPx = 4;
  const widths: Partial<Record<string, number>> = {};

  for (const col of columnDefs) {
    const id = String(col.id ?? "");
    if (!id) continue;

    const meta = col.meta as ColumnMeta | undefined;
    const baseSize = col.size ?? 0;
    const headerLabel = meta?.headerLabel ?? id;
    const headerSubLabel = meta?.headerSubLabel ?? "";
    const headerTextWidth =
      Math.max(
        textWidthPx(headerLabel.length),
        textWidthPx(headerSubLabel.length),
      ) +
      tdHorizontalPaddingPx +
      sortIndicatorPx +
      extraSafetyPx;

    let cellWidth = baseSize;
    switch (id) {
      case "provider":
        cellWidth =
          textWidthPx(maxLength(data, (row) => row.providerName.length)) +
          iconSizePx +
          iconGapPx +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "model":
        cellWidth =
          textWidthPx(maxLength(data, (row) => row.name.length)) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "family":
        cellWidth =
          textWidthPx(maxLength(data, (row) => (row.family ?? "-").length)) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "provider-id":
        cellWidth =
          textWidthPx(maxLength(data, (row) => row.providerId.length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "model-id":
        cellWidth =
          textWidthPx(maxLength(data, (row) => row.modelId.length), true) +
          copyButtonWidthPx +
          iconGapPx +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "input-modalities":
        cellWidth =
          maxLength(data, (row) => {
            const count = row.modalities.input.length;
            return count * modalityIconWidthPx + Math.max(0, count - 1) * modalityIconGapPx;
          }) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "output-modalities":
        cellWidth =
          maxLength(data, (row) => {
            const count = row.modalities.output.length;
            return count * modalityIconWidthPx + Math.max(0, count - 1) * modalityIconGapPx;
          }) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "input-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.input).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "output-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.output).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "reasoning-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.reasoning).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "cache-read-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.cache_read).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "cache-write-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.cache_write).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "audio-input-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.input_audio).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "audio-output-cost":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatCost(row.cost?.output_audio).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "context-limit":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatNumber(row.limit.context).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "input-limit":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatNumber(row.limit.input).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "output-limit":
        cellWidth =
          textWidthPx(maxLength(data, (row) => formatNumber(row.limit.output).length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "knowledge":
        cellWidth =
          textWidthPx(
            maxLength(data, (row) => (row.knowledge ? row.knowledge.substring(0, 7) : "-").length),
            true,
          ) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "release-date":
        cellWidth =
          textWidthPx(maxLength(data, (row) => (row.release_date ?? "-").length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      case "last-updated":
        cellWidth =
          textWidthPx(maxLength(data, (row) => (row.last_updated ?? "-").length), true) +
          tdHorizontalPaddingPx +
          extraSafetyPx;
        break;
      default:
        if (meta?.dataType === "boolean") {
          cellWidth = textWidthPx(3) + tdHorizontalPaddingPx + extraSafetyPx;
        } else if (meta?.dataType === "text") {
          cellWidth =
            textWidthPx(
              maxLength(data, (row) => {
                if (id === "weights") return (row.open_weights ? "Open" : "Closed").length;
                return 1;
              }),
            ) +
            tdHorizontalPaddingPx +
            extraSafetyPx;
        }
        break;
    }

    widths[id] = Math.max(baseSize, headerTextWidth, cellWidth);
  }

  return widths;
}

function getColumnSize(columnId: string, fallbackSize: number): number {
  return Math.max(fallbackSize, computedColumnSizes[columnId] ?? fallbackSize);
}

// ─── Tanstack Table ───────────────────────────────────────────────────────────
const table = createTable<Row>({
  data: rows,
  columns: columnDefs,
  state: { sorting, columnVisibility },
  onStateChange: () => {},
  renderFallbackValue: null,
  onSortingChange: (updater) => {
    sorting = typeof updater === "function" ? updater(sorting) : updater;
    afterStateChange();
  },
  onColumnVisibilityChange: (updater) => {
    columnVisibility =
      typeof updater === "function" ? updater(columnVisibility) : updater;
    afterStateChange();
  },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
});

// Prime state with all feature-provided defaults (e.g. columnPinning: {left:[],right:[]})
// so that getHeaderGroups() never reads undefined.left
table.setOptions((prev) => ({
  ...prev,
  state: { ...table.initialState, ...prev.state },
}));

function afterStateChange() {
  const filtered = globalFilter
    ? searchRows(globalFilter, allRows) ?? allRows
    : allRows;
  rows = filtered;
  table.setOptions((prev) => ({
    ...prev,
    data: rows,
    state: { ...prev.state, sorting, columnVisibility },
  }));
  const rowCount = table.getRowModel().rows.length;
  virtualizer.setOptions({
    ...virtualizer.options,
    count: rowCount,
  });
  virtualizer._willUpdate();
  virtualizer.scrollToOffset(0);
  renderHead();
  renderRows();
  updateUrl();
  updateColumnPickerCheckboxes();

  // Persist column visibility changes to localStorage
  const visibleCols = table
    .getAllColumns()
    .filter((c) => c.getIsVisible())
    .map((c) => c.id);
  saveColsToStorage(visibleCols);
}

// ─── Tanstack Virtual ─────────────────────────────────────────────────────────
const virtualizer = new Virtualizer<HTMLDivElement, HTMLTableRowElement>({
  count: 0,
  getScrollElement: () => scrollContainer,
  estimateSize: () => 45,
  overscan: 5,
  scrollToFn: elementScroll,
  observeElementRect,
  observeElementOffset,
  measureElement,
  onChange: () => renderRows(),
});
// In vanilla JS, _willUpdate() must be called manually to start observing
// the scroll element (frameworks call it automatically via lifecycle hooks).
virtualizer._willUpdate();

/** Compute proportional flex-grow so text-heavy columns absorb more extra space. */
export function flexGrow(dataType: string | undefined, baseSize: number): number {
  switch (dataType) {
    case "text":
      // Text columns grow proportionally to their base size
      // e.g. Model (200) → grow 3, Provider (150) → grow 2, Family (120) → grow 2
      return Math.max(1, Math.round(baseSize / 80));
    case "cost":
    case "number":
      // Numbers/costs get minimal growth — they're fairly fixed width
      return 1;
    case "boolean":
    case "modalities":
      // Booleans and modality icons don't need extra space at all
      return 0;
    default:
      return 1;
  }
}

// ─── Render: thead ────────────────────────────────────────────────────────────
function renderHead() {
  tableHead.textContent = "";
  const tr = document.createElement("tr");
  tr.style.cssText = "display: flex; width: 100%;";

  for (const headerGroup of table.getHeaderGroups()) {
    for (const header of headerGroup.headers) {
      if (!header.column.getIsVisible()) continue;

      const meta = header.column.columnDef.meta as ColumnMeta | undefined;
      const colSize = getColumnSize(header.column.id, header.column.getSize());
      const isSorted = header.column.getIsSorted();

      const th = document.createElement("th");
      th.className = "sortable";
      const grow = flexGrow(meta?.dataType, colSize);
      th.style.cssText = `width: ${colSize}px; flex: ${grow} 0 ${colSize}px; overflow: hidden;`;
      th.setAttribute("data-column-id", header.column.id);

      if (meta?.headerSubLabel) {
        const container = document.createElement("div");
        container.className = "header-container";

        const textSpan = document.createElement("span");
        textSpan.className = "header-text";
        textSpan.textContent = meta.headerLabel;

        const descSpan = document.createElement("span");
        descSpan.className = "desc";
        descSpan.textContent = meta.headerSubLabel;
        textSpan.append(document.createElement("br"), descSpan);

        const sortSpan = document.createElement("span");
        sortSpan.className = "sort-indicator";
        sortSpan.textContent =
          isSorted === "asc" ? "↑" : isSorted === "desc" ? "↓" : "";

        container.append(textSpan, sortSpan);
        th.append(container);
      } else {
        const label = meta?.headerLabel ?? header.column.id;
        const sortIndicator =
          isSorted === "asc" ? " ↑" : isSorted === "desc" ? " ↓" : "";
        th.textContent = label + sortIndicator;
      }

      th.addEventListener("click", () => {
        header.column.toggleSorting(header.column.getIsSorted() === "asc");
      });

      tr.append(th);
    }
  }

  tableHead.append(tr);
}

// ─── Render: tbody (virtual) ──────────────────────────────────────────────────
function renderRows() {
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const tableRows = table.getRowModel().rows;

  tableBody.style.cssText = `height: ${totalSize}px; position: relative;`;
  tableBody.textContent = "";

  for (const virtualRow of virtualItems) {
    const row = tableRows[virtualRow.index];
    if (!row) continue;

    const tr = document.createElement("tr");
    tr.style.cssText = [
      "position: absolute",
      "top: 0",
      `transform: translateY(${virtualRow.start}px)`,
      "display: flex",
      "width: 100%",
    ].join("; ");
    tr.dataset.index = String(virtualRow.index);

    for (const cell of row.getVisibleCells()) {
      const td = document.createElement("td");
      const colSize = getColumnSize(cell.column.id, cell.column.getSize());
      const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
      const grow = flexGrow(meta?.dataType, colSize);
      td.style.cssText = `width: ${colSize}px; flex: ${grow} 0 ${colSize}px; overflow: hidden;`;
      td.dataset.columnId = cell.column.id;

      const colDef = cell.column.columnDef;
      if (typeof colDef.cell === "function") {
        const rendered = colDef.cell(cell.getContext());
        if (rendered instanceof HTMLElement) {
          td.append(rendered);
        } else if (rendered != null) {
          td.textContent = String(rendered);
        }
      } else {
        const v = cell.getValue();
        td.textContent = v != null ? String(v) : "-";
      }

      // Add tooltip for text cells that might overflow
      if (meta?.dataType === "text" && td.textContent) {
        td.title = td.textContent;
      }

      tr.append(td);
    }

    tableBody.append(tr);
  }
}

// ─── Column picker ────────────────────────────────────────────────────────────
const COLUMN_GROUPS: { label: string; ids: string[] }[] = [
  {
    label: "Identity",
    ids: ["provider", "model", "family", "provider-id", "model-id"],
  },
  {
    label: "Capabilities",
    ids: [
      "tool-call",
      "reasoning",
      "structured-output",
      "temperature",
      "weights",
    ],
  },
  { label: "Modalities", ids: ["input-modalities", "output-modalities"] },
  {
    label: "Cost",
    ids: [
      "input-cost",
      "output-cost",
      "reasoning-cost",
      "cache-read-cost",
      "cache-write-cost",
      "audio-input-cost",
      "audio-output-cost",
    ],
  },
  { label: "Limits", ids: ["context-limit", "input-limit", "output-limit"] },
  { label: "Metadata", ids: ["knowledge", "release-date", "last-updated"] },
];

function buildColumnPicker() {
  columnsPicker.textContent = "";

  const actions = document.createElement("div");
  actions.className = "picker-actions";
  const showAll = document.createElement("button");
  showAll.textContent = "Show all";
  showAll.addEventListener("click", () => {
    table.toggleAllColumnsVisible(true);
    saveColsToStorage([...ALL_COLUMN_IDS]);
  });
  actions.append(showAll);
  columnsPicker.append(actions);

  for (const group of COLUMN_GROUPS) {
    const groupEl = document.createElement("div");
    groupEl.className = "picker-group";

    const groupLabel = document.createElement("div");
    groupLabel.className = "picker-group-label";
    groupLabel.textContent = group.label;
    groupEl.append(groupLabel);

    for (const colId of group.ids) {
      const col = table.getColumn(colId);
      if (!col) continue;
      const meta = col.columnDef.meta as ColumnMeta | undefined;

      const label = document.createElement("label");
      label.className = "picker-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = col.getIsVisible();
      checkbox.dataset.colId = colId;
      checkbox.addEventListener("change", () => {
        col.toggleVisibility(checkbox.checked);
      });

      const labelText = document.createTextNode(meta?.headerLabel ?? colId);
      label.append(checkbox, labelText);
      groupEl.append(label);
    }

    columnsPicker.append(groupEl);
  }
}

function updateColumnPickerCheckboxes() {
  columnsPicker
    .querySelectorAll<HTMLInputElement>("[data-col-id]")
    .forEach((cb) => {
      const col = table.getColumn(cb.dataset.colId ?? "");
      if (col) cb.checked = col.getIsVisible();
    });
}

columnsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !columnsPicker.hidden;
  columnsPicker.hidden = isOpen;
  if (!isOpen) buildColumnPicker();
});

document.addEventListener("click", (e) => {
  if (
    !columnsPicker.hidden &&
    !columnsPicker.contains(e.target as Node) &&
    e.target !== columnsToggle
  ) {
    columnsPicker.hidden = true;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !columnsPicker.hidden) {
    columnsPicker.hidden = true;
  }
});

// ─── localStorage persistence ─────────────────────────────────────────────────
const LS_KEY = "models.dev:cols";

function saveColsToStorage(cols: string[]): void {
  try {
    localStorage.setItem(LS_KEY, cols.join(","));
  } catch {
    // localStorage unavailable (e.g. private browsing with strict settings)
  }
}

function loadColsFromStorage(): string[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const cols = raw
      .split(",")
      .filter((c) => (ALL_COLUMN_IDS as readonly string[]).includes(c));
    return cols.length > 0 ? cols : null;
  } catch {
    return null;
  }
}

// ─── URL state ────────────────────────────────────────────────────────────────
function updateUrl() {
  const visibleCols = table
    .getAllColumns()
    .filter((c) => c.getIsVisible())
    .map((c) => c.id);

  const params = serializeUrlState({
    search: globalFilter,
    sort: sorting[0]?.id ?? null,
    order: sorting[0]?.desc ? "desc" : "asc",
    cols: visibleCols,
  });

  const newPath = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.pushState({}, "", newPath);
}

function applyUrlState() {
  const urlParams = new URLSearchParams(window.location.search);
  const state = parseUrlState(urlParams);

  globalFilter = state.search;
  searchInput.value = state.search;
  sorting = state.sort
    ? [{ id: state.sort, desc: state.order === "desc" }]
    : [];

  // Priority: URL cols= param > localStorage > DEFAULT_COLUMN_IDS
  let activeCols: string[];
  if (urlParams.has("cols")) {
    // Explicit URL param — use it (already parsed and validated in state.cols)
    activeCols = state.cols;
  } else {
    // No URL param — check localStorage, fall back to defaults
    activeCols = loadColsFromStorage() ?? [...DEFAULT_COLUMN_IDS];
  }

  const newVisibility: VisibilityState = {};
  for (const id of ALL_COLUMN_IDS) {
    newVisibility[id] = activeCols.includes(id);
  }
  columnVisibility = newVisibility;

  const filtered = globalFilter
    ? searchRows(globalFilter, allRows) ?? allRows
    : allRows;
  rows = filtered;
  table.setOptions((prev) => ({
    ...prev,
    data: rows,
    state: { ...prev.state, sorting, columnVisibility },
  }));

  const rowCount = table.getRowModel().rows.length;
  virtualizer.setOptions({ ...virtualizer.options, count: rowCount });
  virtualizer._willUpdate();
  virtualizer.scrollToOffset(0);

  renderHead();
  renderRows();
  buildColumnPicker();
}

// ─── Search ───────────────────────────────────────────────────────────────────
const debouncedSearch = debounce((value: string) => {
  globalFilter = value;
  afterStateChange();
}, 150);

searchInput.addEventListener("input", () => {
  debouncedSearch(searchInput.value);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    debouncedSearch.cancel();
    searchInput.value = "";
    globalFilter = "";
    afterStateChange();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    searchInput.focus();
  }
});

// ─── Help modal ───────────────────────────────────────────────────────────────
let savedScrollY = 0;

helpButton.addEventListener("click", () => {
  savedScrollY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${savedScrollY}px`;
  modal.showModal();
});

function closeDialog() {
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, savedScrollY);
}

modalClose.addEventListener("click", closeDialog);
modal.addEventListener("cancel", closeDialog);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeDialog();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  const dataEl = document.getElementById("model-data");
  const api = JSON.parse(dataEl!.textContent!);
  allRows = flattenProviders(api as any);

  // Default sort: provider name, then model name
  allRows.sort((a, b) => {
    const p = a.providerName.localeCompare(b.providerName);
    return p !== 0 ? p : a.name.localeCompare(b.name);
  });

  computedColumnSizes = computeColumnSizes(allRows);

  buildSearchIndex(allRows);
  rows = allRows;
  table.setOptions((prev) => ({ ...prev, data: rows }));
  applyUrlState();
}

window.addEventListener("popstate", applyUrlState);
document.addEventListener("DOMContentLoaded", () => {
  init();
});
