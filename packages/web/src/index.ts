interface ApiCost {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  input_audio?: number;
  output_audio?: number;
}

interface ApiLimit {
  context: number;
  input?: number;
  output: number;
}

interface ApiModel {
  name: string;
  family?: string;
  status?: string;
  tool_call: boolean;
  reasoning: boolean;
  modalities: {
    input: string[];
    output: string[];
  };
  cost?: ApiCost;
  limit: ApiLimit;
  structured_output?: boolean;
  temperature: boolean;
  open_weights: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
}

interface ApiProvider {
  name: string;
  models: Record<string, ApiModel>;
}

type ApiResponse = Record<string, ApiProvider>;

const COLUMN_COUNT = 25;
const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;
const tableBody = document.getElementById("table-body")! as HTMLTableSectionElement;

const copyIcon = `
  <svg
    class="copy-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
    <path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
  </svg>
`;

const checkIcon = `
  <svg
    class="check-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="display: none;"
  >
    <polyline points="20,6 9,17 4,12"></polyline>
  </svg>
`;

const modalityIcons: Record<string, { label: string; svg: string }> = {
  text: {
    label: "Text",
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4,7 4,4 20,4 20,7"></polyline>
        <line x1="9" y1="20" x2="15" y2="20"></line>
        <line x1="12" y1="4" x2="12" y2="20"></line>
      </svg>
    `,
  },
  image: {
    label: "Image",
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
        <circle cx="9" cy="9" r="2"></circle>
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>
      </svg>
    `,
  },
  audio: {
    label: "Audio",
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      </svg>
    `,
  },
  video: {
    label: "Video",
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m22 8-6 4 6 4V8Z"></path>
        <rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect>
      </svg>
    `,
  },
  pdf: {
    label: "PDF",
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14,2 14,8 20,8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10,9 9,9 8,9"></polyline>
      </svg>
    `,
  },
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCost(cost?: number) {
  return cost === undefined ? "-" : `$${cost.toFixed(2)}`;
}

function renderModalityIcon(modality: string) {
  const icon = modalityIcons[modality];
  if (!icon) return "";

  return `<span class="modality-icon" data-tooltip="${icon.label}">${icon.svg}</span>`;
}

function renderModalities(modalities: string[]) {
  return `<div class="modalities">${modalities.map(renderModalityIcon).join("")}</div>`;
}

function renderProviderLogo(providerId: string) {
  return `<img class="provider-logo" src="/logos/${encodeURIComponent(providerId)}.svg" alt="" width="16" height="16" loading="lazy" decoding="async" />`;
}

function renderRow(
  providerId: string,
  providerName: string,
  modelId: string,
  model: ApiModel
) {
  const safeProviderId = escapeHtml(providerId);
  const safeProviderName = escapeHtml(providerName);
  const safeModelId = escapeHtml(modelId);
  const safeModelName = escapeHtml(model.name);
  const safeFamily = escapeHtml(model.family ?? "-");
  const safeKnowledge = escapeHtml(model.knowledge?.substring(0, 7) ?? "-");
  const safeReleaseDate = escapeHtml(model.release_date);
  const safeLastUpdated = escapeHtml(model.last_updated);

  return `
    <tr data-model-row="true">
      <td>
        <div class="provider-cell">
          ${renderProviderLogo(providerId)}
          <span>${safeProviderName}</span>
        </div>
      </td>
      <td>${safeModelName}</td>
      <td>${safeFamily}</td>
      <td>${safeProviderId}</td>
      <td>
        <div class="model-id-cell">
          <span class="model-id-text">${safeModelId}</span>
          <button class="copy-button" type="button" data-model-id="${safeModelId}" aria-label="Copy model ID">
            ${copyIcon}
            ${checkIcon}
          </button>
        </div>
      </td>
      <td>${model.tool_call ? "Yes" : "No"}</td>
      <td>${model.reasoning ? "Yes" : "No"}</td>
      <td>${renderModalities(model.modalities.input)}</td>
      <td>${renderModalities(model.modalities.output)}</td>
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
      <td>${safeKnowledge}</td>
      <td>${safeReleaseDate}</td>
      <td>${safeLastUpdated}</td>
    </tr>
  `;
}

function renderTableRows(providers: ApiResponse) {
  return Object.entries(providers)
    .sort(([, providerA], [, providerB]) =>
      providerA.name.localeCompare(providerB.name)
    )
    .flatMap(([providerId, provider]) =>
      Object.entries(provider.models)
        .filter(([, model]) => model.status !== "alpha")
        .sort(([, modelA], [, modelB]) => modelA.name.localeCompare(modelB.name))
        .map(([modelId, model]) =>
          renderRow(providerId, provider.name, modelId, model)
        )
    )
    .join("");
}

function setStatusRow(message: string, className = "loading-row") {
  tableBody.innerHTML = `<tr class="${className}"><td colspan="${COLUMN_COUNT}">${escapeHtml(message)}</td></tr>`;
}

/////////////////////////
// URL State Management
/////////////////////////
function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function updateQueryParams(
  updates: Record<string, string | null>,
  historyMode: "push" | "replace" = "push"
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

  if (newPath === `${window.location.pathname}${window.location.search}`) return;

  if (historyMode === "replace") {
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

////////////////////
// Handle Sorting
////////////////////
let currentSort = { column: -1, direction: "asc" as "asc" | "desc" };

function updateSortIndicators(column: number, direction: "asc" | "desc") {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((header, i) => {
    const indicator = header.querySelector(".sort-indicator")!;
    indicator.textContent = i === column ? (direction === "asc" ? "↑" : "↓") : "";
  });
}

function clearSortIndicators() {
  updateSortIndicators(-1, "asc");
}

function sortTable(
  column: number,
  direction: "asc" | "desc",
  syncUrl = true
) {
  const header = document.querySelectorAll("th.sortable")[column];
  const columnType = header?.getAttribute("data-type");
  if (!columnType) return;

  currentSort = { column, direction };
  if (syncUrl) {
    updateQueryParams(
      {
        sort: getColumnNameForURL(header),
        order: direction,
      },
      "push"
    );
  }

  const rows = Array.from(
    tableBody.querySelectorAll('tr[data-model-row="true"]')
  ) as HTMLTableRowElement[];

  rows.sort((a, b) => {
    const aValue = getCellValue(a.cells[column], columnType);
    const bValue = getCellValue(b.cells[column], columnType);

    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    const comparison =
      columnType === "number" || columnType === "modalities"
        ? (aValue as number) - (bValue as number)
        : (aValue as string).localeCompare(bValue as string);

    return direction === "asc" ? comparison : -comparison;
  });

  rows.forEach((row) => tableBody.appendChild(row));
  updateSortIndicators(column, direction);
}

function getCellValue(
  cell: HTMLTableCellElement,
  type: string
): string | number | undefined {
  if (type === "modalities") {
    return cell.querySelectorAll(".modality-icon").length;
  }

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
function filterTable(value: string, syncUrl = true) {
  const lowerCaseValues = value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const rows = tableBody.querySelectorAll(
    'tr[data-model-row="true"]'
  ) as NodeListOf<HTMLTableRowElement>;

  rows.forEach((row) => {
    const cellTexts = Array.from(row.cells).map((cell) =>
      cell.textContent!.toLowerCase()
    );
    const isVisible =
      lowerCaseValues.length === 0 ||
      lowerCaseValues.some((lowerCaseValue) =>
        cellTexts.some((text) => text.includes(lowerCaseValue))
      );
    row.style.display = isVisible ? "" : "none";
  });

  if (syncUrl) {
    updateQueryParams({ search: value || null }, "replace");
  }
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
tableBody.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest(".copy-button") as HTMLButtonElement | null;
  const modelId = button?.dataset.modelId;
  if (!button || !modelId) return;

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
});

///////////////////////////////////
// Initialize State from URL
///////////////////////////////////
let tableLoaded = false;

function initializeFromURL() {
  if (!tableLoaded) return;

  const params = getQueryParams();
  const searchQuery = params.get("search") ?? "";
  search.value = searchQuery;
  filterTable(searchQuery, false);

  const columnName = params.get("sort");
  if (!columnName) {
    currentSort = { column: -1, direction: "asc" };
    clearSortIndicators();
    return;
  }

  const columnIndex = getColumnIndexByUrlName(columnName);
  if (columnIndex === -1) return;

  const direction = (params.get("order") as "asc" | "desc") || "asc";
  sortTable(columnIndex, direction, false);
}

async function loadTable() {
  try {
    const response = await fetch("/api.json");
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const providers = (await response.json()) as ApiResponse;
    const rows = renderTableRows(providers);
    tableBody.innerHTML = rows || "";

    if (!rows) {
      setStatusRow("No models found.");
      return;
    }

    tableLoaded = true;
    initializeFromURL();
    window.addEventListener("popstate", initializeFromURL);
  } catch (error) {
    console.error("Failed to load model data:", error);
    setStatusRow("Failed to load models.", "loading-row error-row");
  }
}

function initializeApp() {
  search.value = getQueryParams().get("search") ?? "";
  void loadTable();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp();
}
