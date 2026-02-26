import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import { flattenProviders, type Row } from "./data.js";
import { buildSearchIndex, searchRows, debounce } from "./search.js";
import {
  ALL_COLUMNS,
  ALL_COLUMN_IDS,
  DEFAULT_COLUMN_IDS,
  getColumn,
  type ColumnDef,
} from "./columns.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const scrollContainer = document.getElementById("table-scroll-container") as HTMLDivElement;
const tableHead = document.getElementById("table-head") as HTMLTableSectionElement;
const tableBody = document.getElementById("table-body") as HTMLTableSectionElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const columnsToggle = document.getElementById("columns-toggle") as HTMLButtonElement;
const columnsPicker = document.getElementById("columns-picker") as HTMLDivElement;
const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close") as HTMLButtonElement;
const helpButton = document.getElementById("help") as HTMLButtonElement;

// ─── State ───────────────────────────────────────────────────────────────────
let allRows: Row[] = [];
let sortedRows: Row[] = [];
let visibleColumnIds: string[] = [...DEFAULT_COLUMN_IDS];
let sortColumnId: string | null = null;
let sortDirection: "asc" | "desc" = "asc";
let searchQuery = "";

// ─── Sorting ─────────────────────────────────────────────────────────────────
function sortRows(rows: Row[]): Row[] {
  if (!sortColumnId) return rows;
  const col = getColumn(sortColumnId);
  if (!col) return rows;

  const sorted = [...rows];
  sorted.sort((a, b) => {
    const aVal = col.getValue(a);
    const bVal = col.getValue(b);

    // Undefined/"-" always sort to bottom
    const aUndef = aVal === undefined || aVal === "-";
    const bUndef = bVal === undefined || bVal === "-";
    if (aUndef && bUndef) return 0;
    if (aUndef) return 1;
    if (bUndef) return -1;

    let cmp = 0;
    if (typeof aVal === "number" && typeof bVal === "number") {
      cmp = aVal - bVal;
    } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
      cmp = (aVal === bVal) ? 0 : aVal ? -1 : 1;
    } else {
      cmp = String(aVal).localeCompare(String(bVal));
    }
    return sortDirection === "asc" ? cmp : -cmp;
  });
  return sorted;
}

// ─── Virtual Scroll ──────────────────────────────────────────────────────────
const ROW_HEIGHT = 45;
let suppressVirtualizerRender = false;

const virtualizer = new Virtualizer<HTMLDivElement, HTMLTableRowElement>({
  count: 0,
  getScrollElement: () => scrollContainer,
  estimateSize: () => ROW_HEIGHT,
  overscan: 20,
  scrollToFn: elementScroll,
  observeElementRect,
  observeElementOffset,
  onChange: () => {
    if (!suppressVirtualizerRender) renderRows();
  },
});
virtualizer._willUpdate();

// ─── Render helpers ──────────────────────────────────────────────────────────
function formatCellValue(col: ColumnDef, row: Row): HTMLElement | string {
  if (col.renderCell) return col.renderCell(row);
  const val = col.getValue(row);
  if (val === undefined) return "-";
  if (col.dataType === "cost") {
    return val === undefined ? "-" : `$${(val as number).toFixed(2)}`;
  }
  if (col.dataType === "boolean") {
    return val === undefined ? "-" : val ? "Yes" : "No";
  }
  if (col.dataType === "number") {
    return val == null ? "-" : (val as number).toLocaleString();
  }
  return String(val);
}

function getVisibleColumns(): ColumnDef[] {
  return visibleColumnIds
    .map((id) => getColumn(id))
    .filter((c): c is ColumnDef => c !== undefined);
}

// ─── Render: thead ───────────────────────────────────────────────────────────
function renderHead() {
  tableHead.textContent = "";
  const tr = document.createElement("tr");
  const cols = getVisibleColumns();

  for (const col of cols) {
    const th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.setAttribute("data-column-id", col.id);

    if (col.sortable) {
      th.classList.add("sortable");

      const container = document.createElement("div");
      container.className = "header-container";

      if (col.subLabel) {
        const headerText = document.createElement("span");
        headerText.className = "header-text";
        headerText.textContent = col.label;
        const br = document.createElement("br");
        const desc = document.createElement("span");
        desc.className = "desc";
        desc.textContent = col.subLabel;
        headerText.append(br, desc);
        container.append(headerText);
      } else {
        const label = document.createTextNode(col.label + " ");
        container.append(label);
      }

      const indicator = document.createElement("span");
      indicator.className = "sort-indicator";
      if (sortColumnId === col.id) {
        indicator.textContent = sortDirection === "asc" ? "↑" : "↓";
        th.setAttribute(
          "aria-sort",
          sortDirection === "asc" ? "ascending" : "descending"
        );
      } else {
        th.setAttribute("aria-sort", "none");
      }
      container.append(indicator);
      th.append(container);

      th.addEventListener("click", () => {
        if (sortColumnId === col.id) {
          sortDirection = sortDirection === "asc" ? "desc" : "asc";
        } else {
          sortColumnId = col.id;
          sortDirection = "asc";
        }
        applyStateAndRender();
        updateUrl(true); // pushState for sort
      });
    } else {
      th.textContent = col.label;
    }

    tr.append(th);
  }
  tableHead.append(tr);
}

// ─── Render: rows ────────────────────────────────────────────────────────────
function renderRows() {
  const virtualItems = virtualizer.getVirtualItems();
  const cols = getVisibleColumns();

  // Clear body and set total height for scrollbar
  tableBody.textContent = "";
  const totalHeight = virtualizer.getTotalSize();

  // Spacer row for total height
  if (virtualItems.length > 0) {
    const spacerTop = document.createElement("tr");
    spacerTop.style.height = `${virtualItems[0].start}px`;
    spacerTop.style.display = "table-row";
    const tdTop = document.createElement("td");
    tdTop.colSpan = cols.length;
    tdTop.style.padding = "0";
    tdTop.style.border = "none";
    spacerTop.append(tdTop);
    tableBody.append(spacerTop);
  }

  for (const item of virtualItems) {
    const row = sortedRows[item.index];
    if (!row) continue;

    const tr = document.createElement("tr");
    for (const col of cols) {
      const td = document.createElement("td");
      td.setAttribute("data-column-id", col.id);
      const content = formatCellValue(col, row);
      if (typeof content === "string") {
        td.textContent = content;
      } else {
        td.append(content);
      }
      tr.append(td);
    }
    tableBody.append(tr);
  }

  // Bottom spacer
  if (virtualItems.length > 0) {
    const lastItem = virtualItems[virtualItems.length - 1];
    const spacerBottom = document.createElement("tr");
    spacerBottom.style.height = `${totalHeight - lastItem.end}px`;
    spacerBottom.style.display = "table-row";
    const tdBottom = document.createElement("td");
    tdBottom.colSpan = cols.length;
    tdBottom.style.padding = "0";
    tdBottom.style.border = "none";
    spacerBottom.append(tdBottom);
    tableBody.append(spacerBottom);
  }
}

// ─── State machine ───────────────────────────────────────────────────────────
function applyStateAndRender() {
  // 1. Filter
  const filteredRows = searchQuery
    ? (searchRows(searchQuery) ?? allRows)
    : allRows;

  // 2. Sort (but not if search is active and no sort applied — preserve relevance)
  sortedRows = sortColumnId ? sortRows(filteredRows) : filteredRows;

  // 3. Update virtualizer
  virtualizer.setOptions({
    ...virtualizer.options,
    count: sortedRows.length,
  });
  suppressVirtualizerRender = true;
  virtualizer._willUpdate();
  virtualizer.scrollToOffset(0, { behavior: "auto" });
  suppressVirtualizerRender = false;

  // 4. Render
  renderHead();
  renderRows();
}

// ─── URL State ───────────────────────────────────────────────────────────────
function parseUrlState() {
  const params = new URLSearchParams(window.location.search);

  searchQuery = params.get("search") ?? "";
  sortColumnId = params.get("sort");
  const order = params.get("order");
  sortDirection = order === "desc" ? "desc" : "asc";

  const colsParam = params.get("cols");
  if (colsParam) {
    const parsed = colsParam.split(",").filter((c) => ALL_COLUMN_IDS.includes(c));
    visibleColumnIds = parsed.length > 0 ? parsed : [...DEFAULT_COLUMN_IDS];
  } else {
    // Check localStorage for saved column preferences
    const saved = localStorage.getItem("models-dev-cols");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as string[];
        const valid = parsed.filter((c) => ALL_COLUMN_IDS.includes(c));
        visibleColumnIds = valid.length > 0 ? valid : [...DEFAULT_COLUMN_IDS];
      } catch {
        localStorage.removeItem("models-dev-cols");
        visibleColumnIds = [...DEFAULT_COLUMN_IDS];
      }
    } else {
      visibleColumnIds = [...DEFAULT_COLUMN_IDS];
    }
  }
}

function updateUrl(pushState = false) {
  const params = new URLSearchParams();
  if (searchQuery) params.set("search", searchQuery);
  if (sortColumnId) {
    params.set("sort", sortColumnId);
    if (sortDirection !== "asc") params.set("order", sortDirection);
  }

  // Only add cols to URL if non-default
  const isDefault =
    visibleColumnIds.length === DEFAULT_COLUMN_IDS.length &&
    DEFAULT_COLUMN_IDS.every((id) => visibleColumnIds.includes(id));
  if (!isDefault) params.set("cols", visibleColumnIds.join(","));

  const newPath = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;

  if (pushState) {
    window.history.pushState({}, "", newPath);
  } else {
    window.history.replaceState({}, "", newPath);
  }

  // Persist columns to localStorage
  localStorage.setItem("models-dev-cols", JSON.stringify(visibleColumnIds));
}

// ─── Column picker ───────────────────────────────────────────────────────────
let pickerBuilt = false;

function buildColumnPicker() {
  if (pickerBuilt) {
    updateColumnPickerCheckboxes();
    return;
  }
  pickerBuilt = true;
  columnsPicker.textContent = "";

  // Reset to defaults button
  const actions = document.createElement("div");
  actions.className = "picker-actions";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    visibleColumnIds = [...DEFAULT_COLUMN_IDS];
    applyStateAndRender();
    updateUrl();
    updateColumnPickerCheckboxes();
  });
  actions.append(resetBtn);
  columnsPicker.append(actions);

  // Group columns
  const groups: Record<string, ColumnDef[]> = {};
  for (const col of ALL_COLUMNS) {
    (groups[col.group] ??= []).push(col);
  }

  const groupLabels: Record<string, string> = {
    identity: "Identity",
    capabilities: "Capabilities",
    modalities: "Modalities",
    cost: "Cost",
    limits: "Limits",
    metadata: "Metadata",
  };

  for (const [groupId, cols] of Object.entries(groups)) {
    const groupDiv = document.createElement("div");
    groupDiv.className = "picker-group";
    const label = document.createElement("div");
    label.className = "picker-group-label";
    label.textContent = groupLabels[groupId] ?? groupId;
    groupDiv.append(label);

    for (const col of cols) {
      const item = document.createElement("label");
      item.className = "picker-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = visibleColumnIds.includes(col.id);
      checkbox.dataset.columnId = col.id;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          // Insert in the canonical order
          const allIds = ALL_COLUMN_IDS;
          visibleColumnIds = allIds.filter(
            (id) => id === col.id || visibleColumnIds.includes(id)
          );
        } else {
          visibleColumnIds = visibleColumnIds.filter((id) => id !== col.id);
          if (visibleColumnIds.length === 0) {
            visibleColumnIds = [...DEFAULT_COLUMN_IDS];
            checkbox.checked = DEFAULT_COLUMN_IDS.includes(col.id);
          }
        }
        applyStateAndRender();
        updateUrl();
      });
      const text = document.createElement("span");
      text.textContent = col.label;
      item.append(checkbox, text);
      groupDiv.append(item);
    }
    columnsPicker.append(groupDiv);
  }
}

function updateColumnPickerCheckboxes() {
  const checkboxes = columnsPicker.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
  for (const cb of checkboxes) {
    const colId = cb.dataset.columnId;
    if (colId) cb.checked = visibleColumnIds.includes(colId);
  }
}

// ─── Modal ───────────────────────────────────────────────────────────────────
let scrollY = 0;

helpButton.addEventListener("click", () => {
  scrollY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${scrollY}px`;
  modal.showModal();
});

function closeDialog() {
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, scrollY);
}

modalClose.addEventListener("click", closeDialog);
modal.addEventListener("cancel", closeDialog);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeDialog();
});

// ─── Search ──────────────────────────────────────────────────────────────────
const debouncedSearch = debounce((value: string) => {
  searchQuery = value;
  applyStateAndRender();
  updateUrl(); // replaceState (default)
}, 150);

searchInput.addEventListener("input", () => {
  debouncedSearch(searchInput.value);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    debouncedSearch.cancel();
    searchInput.value = "";
    searchQuery = "";
    applyStateAndRender();
    updateUrl();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    searchInput.focus();
  }
});

// ─── Column picker toggle ────────────────────────────────────────────────────
columnsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !columnsPicker.hidden;
  columnsPicker.hidden = isOpen;
  columnsToggle.setAttribute("aria-expanded", String(!isOpen));
  if (!isOpen) buildColumnPicker();
});

document.addEventListener("click", (e) => {
  if (!columnsPicker.hidden && !columnsPicker.contains(e.target as Node) && e.target !== columnsToggle) {
    columnsPicker.hidden = true;
    columnsToggle.setAttribute("aria-expanded", "false");
  }
});

// ─── Popstate ────────────────────────────────────────────────────────────────
window.addEventListener("popstate", () => {
  parseUrlState();
  searchInput.value = searchQuery;
  applyStateAndRender();
  if (pickerBuilt) updateColumnPickerCheckboxes();
});

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
  // Parse inline JSON data
  const dataEl = document.getElementById("model-data");
  if (!dataEl?.textContent) return;
  let api: Parameters<typeof flattenProviders>[0];
  try {
    api = JSON.parse(dataEl.textContent);
  } catch (error) {
    console.error("Failed to parse model data", error);
    return;
  }
  allRows = flattenProviders(api);
  buildSearchIndex(allRows);

  // Parse URL state
  parseUrlState();
  searchInput.value = searchQuery;
  columnsToggle.setAttribute("aria-expanded", "false");

  // Initial render
  applyStateAndRender();
}

init();
