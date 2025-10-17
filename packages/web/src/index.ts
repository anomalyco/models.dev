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
  scrollY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${y}px`;
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

///////////////////////////////
// Handle Provider Filter
///////////////////////////////
const providerFilterButton = document.getElementById("provider-filter")!;
const providerPopover = document.getElementById("provider-popover")!;
const providerSearch = document.getElementById(
  "provider-search"
)! as HTMLInputElement;
const providerResetButton = document.getElementById(
  "provider-reset"
)! as HTMLButtonElement;
const providerCheckboxes = document.querySelectorAll(
  ".provider-checkbox"
) as NodeListOf<HTMLInputElement>;
const providerItems = document.querySelectorAll(
  ".provider-item"
) as NodeListOf<HTMLElement>;
const providerCountSpan = document.getElementById("provider-count")!;

const allProviderValues = Array.from(providerCheckboxes).map((cb) => cb.value);
let selectedProviders = new Set<string>(allProviderValues);

///////////////////
// Handle Search
///////////////////
function filterTable(value: string) {
  const lowerCaseValues = value
    .toLowerCase()
    .split(",")
    .filter((str) => str.trim() !== "");
  const rows = document.querySelectorAll(
    "table tbody tr"
  ) as NodeListOf<HTMLTableRowElement>;

  rows.forEach((row) => {
    const providerId = row.cells[2].textContent?.trim() || "";
    const isProviderSelected = selectedProviders.has(providerId);

    if (!isProviderSelected) {
      row.style.display = "none";
      return;
    }

    if (lowerCaseValues.length === 0) {
      row.style.display = "";
      return;
    }

    const cellTexts = Array.from(row.cells).map((cell) =>
      cell.textContent!.toLowerCase()
    );
    const isVisible = lowerCaseValues.some((lowerCaseValue) =>
      cellTexts.some((text) => text.includes(lowerCaseValue))
    );
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

function updateProviderCount() {
  const totalProviders = providerCheckboxes.length;
  const selectedCount = selectedProviders.size;
  providerCountSpan.textContent = `${selectedCount}/${totalProviders}`;
  providerResetButton.disabled = selectedCount === totalProviders;
}

function filterByProviders() {
  filterTable(search.value);
  updateProviderCount();
  updateQueryParams({
    providers:
      selectedProviders.size === providerCheckboxes.length
        ? null
        : Array.from(selectedProviders).sort().join(","),
  });
}

function togglePopover() {
  const isVisible = providerPopover.style.display !== "none";
  providerPopover.style.display = isVisible ? "none" : "block";

  if (!isVisible) {
    const buttonRect = providerFilterButton.getBoundingClientRect();
    providerPopover.style.top = `${buttonRect.bottom + 4}px`;
    providerPopover.style.left = `${
      buttonRect.right - providerPopover.offsetWidth
    }px`;
  }
}

function closePopover() {
  providerPopover.style.display = "none";

  providerSearch.value = "";
  filterProviderList("");
}

function filterProviderList(searchValue: string) {
  const searchLower = searchValue.toLowerCase();
  providerItems.forEach((item) => {
    const providerName = item.getAttribute("data-provider-name") || "";
    if (providerName.includes(searchLower)) {
      item.style.display = "";
    } else {
      item.style.display = "none";
    }
  });
}

providerFilterButton.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopover();
});

document.addEventListener("click", (e) => {
  if (
    !providerPopover.contains(e.target as Node) &&
    !providerFilterButton.contains(e.target as Node)
  ) {
    closePopover();
  }
});

providerSearch.addEventListener("input", () => {
  filterProviderList(providerSearch.value);
});

providerResetButton.addEventListener("click", (e) => {
  e.stopPropagation();

  selectedProviders = new Set(allProviderValues);
  providerCheckboxes.forEach((cb) => {
    cb.checked = true;
  });

  providerSearch.value = "";
  filterProviderList("");

  filterByProviders();
});

providerItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();

    const checkbox = item.querySelector(
      ".provider-checkbox"
    ) as HTMLInputElement;
    const providerId = checkbox.value;
    const wasChecked = checkbox.checked;
    const allSelected = selectedProviders.size === providerCheckboxes.length;

    if (allSelected) {
      selectedProviders.clear();
      selectedProviders.add(providerId);
      providerCheckboxes.forEach((cb) => {
        cb.checked = cb.value === providerId;
      });
    } else if (wasChecked) {
      if (selectedProviders.size === 1) {
        selectedProviders = new Set(allProviderValues);
        providerCheckboxes.forEach((cb) => {
          cb.checked = true;
        });
      } else {
        selectedProviders.delete(providerId);
        checkbox.checked = false;
      }
    } else {
      selectedProviders.add(providerId);
      checkbox.checked = true;
    }

    filterByProviders();
  });
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
// Initialize State from URL
///////////////////////////////////
function initializeFromURL() {
  const params = getQueryParams();

  (() => {
    const providersParam = params.get("providers");
    if (providersParam) {
      const providerIds = providersParam.split(",");
      selectedProviders = new Set(providerIds);

      providerCheckboxes.forEach((cb) => {
        cb.checked = selectedProviders.has(cb.value);
      });
    }
    updateProviderCount();
  })();

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

  if (selectedProviders.size < providerCheckboxes.length) {
    filterByProviders();
  }
}

document.addEventListener("DOMContentLoaded", initializeFromURL);
window.addEventListener("popstate", initializeFromURL);
