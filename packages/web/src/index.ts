const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;

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
  const clone = headerEl.cloneNode(true) as Element;
  clone.querySelectorAll(".filter-icon, .filter-dropdown").forEach((el) => el.remove());
  const text = clone.textContent?.trim().toLowerCase() || "";
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

////////////////////
// Handle Sorting
////////////////////
let currentSort = { column: -1, direction: "asc" };

function sortTable(column: number, direction: "asc" | "desc") {
  const header = document.querySelectorAll("th.sortable")[column];
  const columnType = header.getAttribute("data-type");
  if (!columnType) return;

  // update state
  currentSort = { column, direction };
  updateQueryParams({
    sort: getColumnNameForURL(header),
    order: direction,
  });

  // sort rows
  const tbody = document.querySelector("table tbody")!;
  const rows = Array.from(
    tbody.querySelectorAll("tr")
  ) as HTMLTableRowElement[];
  rows.sort((a, b) => {
    const aValue = getCellValue(a.cells[column], columnType);
    const bValue = getCellValue(b.cells[column], columnType);

    // Handle undefined values - always sort to bottom
    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    let comparison = 0;
    if (columnType === "number" || columnType === "modalities") {
      comparison = (aValue as number) - (bValue as number);
    } else if (columnType === "boolean") {
      comparison = (aValue as string).localeCompare(bValue as string);
    } else {
      comparison = (aValue as string).localeCompare(bValue as string);
    }

    return direction === "asc" ? comparison : -comparison;
  });
  rows.forEach((row) => tbody.appendChild(row));

  // update sort indicators
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header, i) => {
    const indicator = header.querySelector(".sort-indicator")!;

    if (i === column) {
      indicator.textContent = direction === "asc" ? "↑" : "↓";
    } else {
      indicator.textContent = "";
    }
  });
}

function getCellValue(
  cell: HTMLTableCellElement,
  type: string
): string | number | undefined {
  if (type === "modalities")
    return cell.querySelectorAll(".modality-icon").length;

  const text = cell.textContent?.trim() || "";
  if (text === "-") return;
  if (type === "number") return parseFloat(text.replace(/[$,]/g, "")) || 0;
  return text;
}

document.querySelectorAll("th.sortable").forEach((header) => {
  header.addEventListener("click", () => {
    const column = Array.from(header.parentElement!.children).indexOf(header);
    const direction =
      currentSort.column === column && currentSort.direction === "asc"
        ? "desc"
        : "asc";
    sortTable(column, direction);
  });
});

///////////////////
// Handle Search
///////////////////
function filterTable(value: string) {
  updateQueryParams({ search: value || null });
  applyFilters();
}

search.addEventListener("input", () => {
  filterTable(search.value);
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
    search.dispatchEvent(new Event("input"));
  }
});

///////////////////////////////////
// Handle Copy model ID function
///////////////////////////////////
(window as any).copyModelId = async (
  button: HTMLButtonElement,
  modelId: string
) => {
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
};

///////////////////////////////////
// Handle Column Filters
///////////////////////////////////
const filterSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;

const activeFilters: Map<number, Set<string>> = new Map();
let openDropdown: HTMLElement | null = null;

function getColumnIndex(th: Element): number {
  return Array.from(th.parentElement!.children).indexOf(th);
}

function getUniqueValues(colIndex: number): string[] {
  const rows = document.querySelectorAll("table tbody tr") as NodeListOf<HTMLTableRowElement>;
  const values = new Set<string>();
  rows.forEach((row) => {
    const text = row.cells[colIndex]?.textContent?.trim() || "";
    if (text) values.add(text);
  });
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function applyFilters() {
  const rows = document.querySelectorAll("table tbody tr") as NodeListOf<HTMLTableRowElement>;
  rows.forEach((row) => {
    let visible = true;

    // check column filters
    for (const [colIndex, allowed] of activeFilters) {
      if (allowed.size === 0) continue;
      const text = row.cells[colIndex]?.textContent?.trim() || "";
      if (!allowed.has(text)) {
        visible = false;
        break;
      }
    }

    // also respect search
    if (visible && search.value) {
      const lowerCaseValues = search.value.toLowerCase().split(",").filter(str => str.trim() !== "");
      if (lowerCaseValues.length > 0) {
        const cellTexts = Array.from(row.cells).map((cell) => cell.textContent!.toLowerCase());
        visible = lowerCaseValues.some((v) => cellTexts.some((text) => text.includes(v)));
      }
    }

    row.style.display = visible ? "" : "none";
  });

  // update URL
  const filterParams: Record<string, string | null> = {};
  document.querySelectorAll("th.filterable").forEach((th) => {
    const col = getColumnIndex(th);
    const name = getColumnNameForURL(th);
    const selected = activeFilters.get(col);
    filterParams[`filter-${name}`] = selected && selected.size > 0
      ? Array.from(selected).join(",")
      : null;
  });
  updateQueryParams(filterParams);

  // update filter icon active state
  document.querySelectorAll("th.filterable").forEach((th) => {
    const col = getColumnIndex(th);
    const icon = th.querySelector(".filter-icon");
    const selected = activeFilters.get(col);
    if (icon) {
      icon.classList.toggle("active", !!selected && selected.size > 0);
    }
  });
}

function closeDropdown() {
  if (openDropdown) {
    openDropdown.remove();
    openDropdown = null;
  }
}

function openFilterDropdown(th: Element, colIndex: number) {
  closeDropdown();

  const values = getUniqueValues(colIndex);
  const selected = activeFilters.get(colIndex) || new Set<string>();

  const dropdown = document.createElement("div");
  dropdown.className = "filter-dropdown";

  // search within filter
  const filterSearch = document.createElement("input");
  filterSearch.type = "text";
  filterSearch.placeholder = "Search...";
  filterSearch.className = "filter-search";
  dropdown.appendChild(filterSearch);

  // actions row
  const actions = document.createElement("div");
  actions.className = "filter-actions";
  const selectAll = document.createElement("button");
  selectAll.textContent = "All";
  selectAll.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.querySelectorAll<HTMLInputElement>(".filter-option input[type=checkbox]").forEach((cb) => {
      cb.checked = true;
    });
    const newSet = new Set(values);
    activeFilters.set(colIndex, newSet);
    applyFilters();
  });
  const clearAll = document.createElement("button");
  clearAll.textContent = "Clear";
  clearAll.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.querySelectorAll<HTMLInputElement>(".filter-option input[type=checkbox]").forEach((cb) => {
      cb.checked = false;
    });
    activeFilters.delete(colIndex);
    applyFilters();
  });
  actions.appendChild(selectAll);
  actions.appendChild(clearAll);
  dropdown.appendChild(actions);

  // options list
  const list = document.createElement("div");
  list.className = "filter-list";
  values.forEach((value) => {
    const option = document.createElement("label");
    option.className = "filter-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(value);
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      const current = activeFilters.get(colIndex) || new Set<string>();
      if (cb.checked) {
        current.add(value);
      } else {
        current.delete(value);
      }
      if (current.size === 0) {
        activeFilters.delete(colIndex);
      } else {
        activeFilters.set(colIndex, current);
      }
      applyFilters();
    });
    const span = document.createElement("span");
    span.textContent = value;
    option.appendChild(cb);
    option.appendChild(span);
    list.appendChild(option);
  });
  dropdown.appendChild(list);

  // filter search functionality
  filterSearch.addEventListener("input", () => {
    const query = filterSearch.value.toLowerCase();
    list.querySelectorAll<HTMLLabelElement>(".filter-option").forEach((opt) => {
      const text = opt.textContent?.toLowerCase() || "";
      opt.style.display = text.includes(query) ? "" : "none";
    });
  });
  filterSearch.addEventListener("click", (e) => e.stopPropagation());

  th.appendChild(dropdown);
  openDropdown = dropdown;

  // prevent clicks inside dropdown from sorting
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  // focus search
  filterSearch.focus();
}

// inject filter icons into filterable headers
document.querySelectorAll("th.filterable").forEach((th) => {
  const icon = document.createElement("span");
  icon.className = "filter-icon";
  icon.innerHTML = filterSvg;
  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    const colIndex = getColumnIndex(th);
    if (openDropdown && openDropdown.parentElement === th) {
      closeDropdown();
    } else {
      openFilterDropdown(th, colIndex);
    }
  });
  th.appendChild(icon);
});

// close dropdown when clicking outside or pressing Escape
document.addEventListener("click", (e) => {
  if (openDropdown && !openDropdown.contains(e.target as Node)) {
    closeDropdown();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openDropdown) {
    e.stopPropagation();
    closeDropdown();
  }
});

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
function initializeFromURL() {
  const params = getQueryParams();

  // restore search
  (() => {
    const searchQuery = params.get("search");
    if (!searchQuery) return;
    search.value = searchQuery;
  })();

  // restore column filters
  document.querySelectorAll("th.filterable").forEach((th) => {
    const col = getColumnIndex(th);
    const name = getColumnNameForURL(th);
    const filterValue = params.get(`filter-${name}`);
    if (filterValue) {
      activeFilters.set(col, new Set(filterValue.split(",")));
    }
  });

  applyFilters();

  // restore sort
  (() => {
    const columnName = params.get("sort");
    if (!columnName) return;

    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex === -1) return;

    const direction = (params.get("order") as "asc" | "desc") || "asc";
    sortTable(columnIndex, direction);
  })();
}

document.addEventListener("DOMContentLoaded", initializeFromURL);
window.addEventListener("popstate", initializeFromURL);
