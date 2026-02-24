import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  type SortingState,
  type VisibilityState,
} from "@tanstack/table-core";
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
  elementScroll,
  measureElement,
} from "@tanstack/virtual-core";
import { flattenProviders, type Row } from "./data";
import { columnDefs, type ColumnMeta } from "./columns";
import { parseUrlState, serializeUrlState, ALL_COLUMN_IDS } from "./url-state";

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const scrollContainer = document.getElementById(
  "table-scroll-container"
) as HTMLDivElement;
const tableHead = document.getElementById(
  "table-head"
) as HTMLTableSectionElement;
const tableBody = document.getElementById(
  "table-body"
) as HTMLTableSectionElement;
const tableLoading = document.getElementById("table-loading") as HTMLDivElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const columnsToggle = document.getElementById(
  "columns-toggle"
) as HTMLButtonElement;
const columnsPicker = document.getElementById(
  "columns-picker"
) as HTMLDivElement;
const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close") as HTMLButtonElement;
const helpButton = document.getElementById("help") as HTMLButtonElement;

// ─── State ────────────────────────────────────────────────────────────────────
let rows: Row[] = [];
let sorting: SortingState = [];
let globalFilter = "";
let columnVisibility: VisibilityState = {};

// ─── Tanstack Table ───────────────────────────────────────────────────────────
const table = createTable<Row>({
  data: rows,
  columns: columnDefs,
  state: { sorting, globalFilter, columnVisibility },
  onStateChange: () => {},
  renderFallbackValue: null,
  onSortingChange: (updater) => {
    sorting = typeof updater === "function" ? updater(sorting) : updater;
    afterStateChange();
  },
  onGlobalFilterChange: (updater) => {
    globalFilter =
      typeof updater === "function" ? updater(globalFilter) : updater;
    afterStateChange();
  },
  onColumnVisibilityChange: (updater) => {
    columnVisibility =
      typeof updater === "function" ? updater(columnVisibility) : updater;
    afterStateChange();
  },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  globalFilterFn: (row, _columnId, filterValue: string) => {
    const terms = filterValue
      .toLowerCase()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length === 0) return true;
    const orig = row.original as Record<string, unknown>;
    const text = Object.values(orig)
      .map((v) =>
        typeof v === "string" || typeof v === "number" ? String(v) : ""
      )
      .join(" ")
      .toLowerCase();
    return terms.some((term) => text.includes(term));
  },
});

function afterStateChange() {
  table.setOptions((prev) => ({
    ...prev,
    data: rows,
    state: { sorting, globalFilter, columnVisibility },
  }));
  const rowCount = table.getRowModel().rows.length;
  virtualizer.setOptions({
    ...virtualizer.options,
    count: rowCount,
  });
  virtualizer.scrollToOffset(0);
  renderHead();
  renderRows();
  updateUrl();
  updateColumnPickerCheckboxes();
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

// ─── Render: thead ────────────────────────────────────────────────────────────
function renderHead() {
  tableHead.textContent = "";
  const tr = document.createElement("tr");
  tr.style.cssText = "display: flex; width: 100%;";

  for (const headerGroup of table.getHeaderGroups()) {
    for (const header of headerGroup.headers) {
      if (!header.column.getIsVisible()) continue;

      const meta = header.column.columnDef.meta as ColumnMeta | undefined;
      const colSize = header.column.getSize();
      const isSorted = header.column.getIsSorted();

      const th = document.createElement("th");
      th.className = "sortable";
      th.style.cssText = `width: ${colSize}px; flex: 0 0 ${colSize}px; overflow: hidden;`;
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
      const colSize = cell.column.getSize();
      td.style.cssText = `width: ${colSize}px; flex: 0 0 ${colSize}px; overflow: hidden;`;

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
  const state = parseUrlState(new URLSearchParams(window.location.search));

  globalFilter = state.search;
  searchInput.value = state.search;
  sorting = state.sort
    ? [{ id: state.sort, desc: state.order === "desc" }]
    : [];

  const newVisibility: VisibilityState = {};
  for (const id of ALL_COLUMN_IDS) {
    newVisibility[id] = state.cols.includes(id);
  }
  columnVisibility = newVisibility;

  table.setOptions((prev) => ({
    ...prev,
    data: rows,
    state: { sorting, globalFilter, columnVisibility },
  }));

  const rowCount = table.getRowModel().rows.length;
  virtualizer.setOptions({ ...virtualizer.options, count: rowCount });
  virtualizer.scrollToOffset(0);

  renderHead();
  renderRows();
  buildColumnPicker();
}

// ─── Search ───────────────────────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  table.setGlobalFilter(searchInput.value);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    table.setGlobalFilter("");
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
async function init() {
  const res = await fetch("/api.json");
  const api: Record<string, unknown> = await res.json();
  rows = flattenProviders(api as any);

  // Default sort: provider name, then model name
  rows.sort((a, b) => {
    const p = a.providerName.localeCompare(b.providerName);
    return p !== 0 ? p : a.name.localeCompare(b.name);
  });

  table.setOptions((prev) => ({ ...prev, data: rows }));
  tableLoading.remove();
  applyUrlState();
}

window.addEventListener("popstate", applyUrlState);
document.addEventListener("DOMContentLoaded", () => {
  init().catch(console.error);
});
