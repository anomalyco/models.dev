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

////////////////////
// Handle Sorting
////////////////////
let currentSort = { column: -1, direction: "asc" };

function sortTable(column: number, direction: "asc" | "desc") {
  const header = document.querySelectorAll("th.sortable")[column];
  const columnType = header.getAttribute("data-type");
  if (!columnType) return;

  currentSort = { column, direction };
  updateQueryParams({
    sort: getColumnNameForURL(header),
    order: direction,
  });

  const tbody = document.querySelector("table tbody")!;
  const rows = Array.from(
    tbody.querySelectorAll("tr")
  ) as HTMLTableRowElement[];
  rows.sort((a, b) => {
    const aValue = getCellValue(a.cells[column], columnType);
    const bValue = getCellValue(b.cells[column], columnType);

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
  const lowerCaseValues = value.toLowerCase().split(",").filter(str => str.trim() !== "");
  const rows = document.querySelectorAll(
    "table tbody tr"
  ) as NodeListOf<HTMLTableRowElement>;

  rows.forEach((row) => {
    const cellTexts = Array.from(row.cells).map((cell) =>
      cell.textContent!.toLowerCase()
    );
    const isVisible = lowerCaseValues.length === 0 ||
     lowerCaseValues.some((lowerCaseValue) => cellTexts.some((text) => text.includes(lowerCaseValue)));
    row.style.display = isVisible ? "" : "none";
  });

  updateQueryParams({ search: value || null });
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
};

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
function initializeFromURL() {
  const params = getQueryParams();

  (() => {
    const searchQuery = params.get("search");
    if (!searchQuery) return;
    search.value = searchQuery;
    filterTable(searchQuery);
  })();

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


///////////////////////////
// Column Settings Sidebar
///////////////////////////
const sidebar = document.getElementById("column-sidebar")!;
const sidebarOverlay = document.getElementById("sidebar-overlay")!;
const columnSettingsBtn = document.getElementById("column-settings")!;
const sidebarCloseBtn = document.getElementById("sidebar-close")!;

const STORAGE_KEY = "column-visibility";

function openSidebar() {
  sidebar.classList.add("active");
  sidebarOverlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeSidebar() {
  sidebar.classList.remove("active");
  sidebarOverlay.classList.remove("active");
  document.body.style.overflow = "";
}

columnSettingsBtn.addEventListener("click", openSidebar);
sidebarCloseBtn.addEventListener("click", closeSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebar.classList.contains("active")) {
    closeSidebar();
  }
});

/////////////////////////////////////
// Column Visibility Management
/////////////////////////////////////

function getSavedColumnVisibility(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveColumnVisibility(visibility: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Ignore storage errors
  }
}

function applyColumnVisibility(visibility: Record<string, boolean>) {
  const headers = document.querySelectorAll("th[data-col]") as NodeListOf<HTMLTableCellElement>;
  const rows = document.querySelectorAll("tbody tr");
  
  const columnStates: { index: number; isVisible: boolean }[] = [];
  
  headers.forEach((header, index) => {
    const colName = header.getAttribute("data-col")!;
    const isVisible = visibility[colName] !== false;
    columnStates.push({ index, isVisible });
  });
  
  requestAnimationFrame(() => {
    columnStates.forEach(({ index, isVisible }) => {
      headers[index].classList.toggle("hidden-col", !isVisible);
      
      rows.forEach((row) => {
        const cell = row.children[index] as HTMLTableCellElement;
        if (cell) {
          cell.classList.toggle("hidden-col", !isVisible);
        }
      });
    });
  });
}

function updateCheckboxes(visibility: Record<string, boolean>) {
  const checkboxes = document.querySelectorAll(".column-toggle input[data-col]") as NodeListOf<HTMLInputElement>;
  
  checkboxes.forEach((checkbox) => {
    const colName = checkbox.getAttribute("data-col")!;
    const isVisible = visibility[colName] !== false;
    checkbox.checked = isVisible;
  });
}

function handleCheckboxChange(e: Event) {
  const checkbox = e.target as HTMLInputElement;
  const colName = checkbox.getAttribute("data-col")!;
  
  if (!checkbox.checked) {
    const visibility = getSavedColumnVisibility();
    const visibleCount = Object.values(visibility).filter(v => v !== false).length;
    const currentlyVisible = visibility[colName] !== false;
    
    if (currentlyVisible && visibleCount <= 1) {
      checkbox.checked = true;
      return;
    }
  }
  
  const visibility = getSavedColumnVisibility();
  visibility[colName] = checkbox.checked;
  
  saveColumnVisibility(visibility);
  applyColumnVisibility(visibility);
}

function initColumnVisibility() {
  const visibility = getSavedColumnVisibility();
  
  applyColumnVisibility(visibility);
  updateCheckboxes(visibility);
  
  const checkboxes = document.querySelectorAll(".column-toggle input[data-col]") as NodeListOf<HTMLInputElement>;
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", handleCheckboxChange);
  });
}

function resetColumnVisibility() {
  localStorage.removeItem(STORAGE_KEY);
  applyColumnVisibility({});
  updateCheckboxes({});
}

document.addEventListener("DOMContentLoaded", () => {
  initColumnVisibility();
  
  const resetBtn = document.getElementById("reset-columns");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetColumnVisibility);
  }
});
