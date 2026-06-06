type SortDirection = "asc" | "desc";

interface SearchIndexItem {
  type: "model" | "provider" | "lab";
  title: string;
  id: string;
  href: string;
  logo: string;
  tokens: string[];
  lab?: string;
  modelCount?: number;
  providerCount?: number;
  context?: number;
  releaseDate?: string;
  inputCost?: number;
  outputCost?: number;
  npm?: string;
  api?: string;
  updated?: string;
}

interface SearchResult {
  item: SearchIndexItem;
  score: number;
}

const helpModal = document.getElementById("modal") as HTMLDialogElement | null;
const modalClose = document.getElementById("close");
const help = document.getElementById("help");
const mobileMenu = document.getElementById(
  "mobile-menu",
) as HTMLDialogElement | null;
const mobileMenuTrigger = document.getElementById("mobile-menu-trigger");
const mobileMenuClose = document.getElementById("mobile-menu-close");
const mobileSearchTrigger = document.getElementById("mobile-search-trigger");
const mobileHelpTrigger = document.getElementById("mobile-help-trigger");
const searchModal = document.getElementById(
  "search-modal",
) as HTMLDialogElement | null;
const searchTrigger = document.getElementById("search-trigger");
const searchInput = document.getElementById(
  "search-input",
) as HTMLInputElement | null;
const searchResults = document.getElementById("search-results");
const searchCount = document.getElementById("search-count");
const searchEmpty = document.getElementById("search-empty");
const tables = Array.from(
  document.querySelectorAll<HTMLTableElement>("table[data-enhanced-table]"),
);

let scrollYBeforeModal = 0;
let lastFocusedElement: HTMLElement | null = null;
let activeSearchIndex = 0;
let rankedSearchResults: SearchResult[] = [];

const searchItems = parseSearchIndex();
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/////////////////////////
// Help Dialog
/////////////////////////
function openHelpDialog() {
  if (!helpModal) return;
  if (searchModal?.open) closeSearchModal();
  if (mobileMenu?.open) closeMobileMenu(false);

  scrollYBeforeModal = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${scrollYBeforeModal}px`;
  helpModal.showModal();
}

help?.addEventListener("click", openHelpDialog);

function closeDialog() {
  if (!helpModal) return;
  helpModal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, scrollYBeforeModal);
}

modalClose?.addEventListener("click", closeDialog);
helpModal?.addEventListener("cancel", closeDialog);
helpModal?.addEventListener("click", (event) => {
  if (event.target === helpModal) closeDialog();
});

////////////////////
// Search
////////////////////
function parseSearchIndex() {
  const index = document.getElementById("search-index")?.textContent;
  if (!index) return [];

  try {
    const parsed = JSON.parse(index);
    return Array.isArray(parsed) ? (parsed as SearchIndexItem[]) : [];
  } catch {
    return [];
  }
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchFields(item: SearchIndexItem) {
  return [item.title, item.id, ...item.tokens].filter(Boolean);
}

function fuzzySequenceScore(haystack: string, needle: string) {
  let score = 0;
  let previousIndex = -1;
  let searchFrom = 0;

  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom);
    if (index === -1) return 0;

    if (index === 0 || haystack[index - 1] === " ") {
      score += 8;
    } else if (index === previousIndex + 1) {
      score += 6;
    } else {
      score += 2;
    }

    previousIndex = index;
    searchFrom = index + 1;
  }

  return score + Math.max(0, 12 - haystack.length / 8);
}

function scoreTerm(field: string, term: string) {
  const normalized = normalizeSearchText(field);
  if (!normalized) return 0;
  if (normalized === term) return 120;
  if (normalized.startsWith(term)) return 100;
  if (normalized.split(" ").some((word) => word.startsWith(term))) return 82;

  const index = normalized.indexOf(term);
  if (index !== -1) return 64 - Math.min(index, 24);

  return fuzzySequenceScore(normalized, term);
}

function scoreSearchItem(item: SearchIndexItem, query: string) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;

  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of searchFields(item)) {
      best = Math.max(best, scoreTerm(field, term));
    }
    if (best <= 0) return 0;
    score += best;
  }

  const normalizedTitle = normalizeSearchText(item.title);
  const normalizedId = normalizeSearchText(item.id);
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedTitle === normalizedQuery || normalizedId === normalizedQuery) {
    score += 120;
  } else if (normalizedTitle.startsWith(normalizedQuery)) {
    score += 44;
  } else if (normalizedId.startsWith(normalizedQuery)) {
    score += 36;
  }

  if (item.type === "model") score += 8;
  return score;
}

function rankSearchItems(query: string) {
  const normalizedQuery = normalizeSearchText(query);
  const results = searchItems
    .map((item) => ({ item, score: scoreSearchItem(item, normalizedQuery) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateComparison = compareSearchDates(
        searchSortDate(a.item),
        searchSortDate(b.item),
      );
      if (dateComparison !== 0) return dateComparison;
      return a.item.title.localeCompare(b.item.title, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  return normalizedQuery ? results.slice(0, 40) : results.slice(0, 18);
}

function compareSearchDates(a?: string, b?: string) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b.localeCompare(a);
}

function searchSortDate(item: SearchIndexItem) {
  return item.releaseDate ?? item.updated;
}

function formatCompactNumber(value?: number) {
  if (value === undefined) return undefined;
  return compactNumberFormatter.format(value);
}

function formatCost(input?: number, output?: number) {
  if (input === undefined && output === undefined) return undefined;
  const inputText = input === undefined ? "-" : `$${input.toFixed(2)}`;
  const outputText = output === undefined ? "-" : `$${output.toFixed(2)}`;
  return `${inputText} / ${outputText}`;
}

function appendHighlightedText(
  element: HTMLElement,
  text: string,
  query: string,
) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    element.textContent = text;
    return;
  }

  const lowerText = text.toLowerCase();
  const ranges = terms
    .map((term) => {
      const index = lowerText.indexOf(term);
      return index === -1 ? undefined : [index, index + term.length] as const;
    })
    .filter((range): range is readonly [number, number] => range !== undefined)
    .sort((a, b) => a[0] - b[0]);

  if (ranges.length === 0) {
    element.textContent = text;
    return;
  }

  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) {
      element.append(document.createTextNode(text.slice(cursor, start)));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    element.append(mark);
    cursor = end;
  }
  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

function resultMeta(item: SearchIndexItem) {
  if (item.type === "model") {
    return [
      item.lab,
      item.providerCount === undefined
        ? undefined
        : `${item.providerCount} providers`,
      item.context === undefined
        ? undefined
        : `${formatCompactNumber(item.context)} context`,
      formatCost(item.inputCost, item.outputCost),
      item.updated,
    ].filter((value): value is string => Boolean(value));
  }

  if (item.type === "provider") {
    return [
      item.modelCount === undefined ? undefined : `${item.modelCount} models`,
      item.npm,
      item.api,
    ].filter((value): value is string => Boolean(value));
  }

  return [
    item.modelCount === undefined ? undefined : `${item.modelCount} models`,
    item.providerCount === undefined
      ? undefined
      : `${item.providerCount} providers`,
    item.updated,
  ].filter((value): value is string => Boolean(value));
}

function resultSubtitle(item: SearchIndexItem) {
  if (item.type === "model") return item.id;
  if (item.type === "provider") return item.id;
  return item.id;
}

function createSearchResult(result: SearchResult, index: number, query: string) {
  const { item } = result;
  const link = document.createElement("a");
  link.className = `search-result search-result-${item.type}`;
  link.href = item.href;
  link.id = `search-result-${index}`;
  link.setAttribute("role", "option");
  link.setAttribute("aria-selected", index === activeSearchIndex ? "true" : "false");
  link.dataset.searchIndex = String(index);
  if (index === activeSearchIndex) link.classList.add("is-active");

  const icon = document.createElement("span");
  icon.className = "search-result-icon";
  const logo = document.createElement("img");
  logo.src = item.logo;
  logo.alt = "";
  logo.loading = "lazy";
  icon.append(logo);
  link.append(icon);

  const body = document.createElement("span");
  body.className = "search-result-body";

  const top = document.createElement("span");
  top.className = "search-result-top";

  const title = document.createElement("span");
  title.className = "search-result-title";
  appendHighlightedText(title, item.title, query);
  top.append(title);

  const kind = document.createElement("span");
  kind.className = "search-result-kind";
  kind.textContent = item.type;
  top.append(kind);
  body.append(top);

  const subtitle = document.createElement("span");
  subtitle.className = "search-result-subtitle mono";
  appendHighlightedText(subtitle, resultSubtitle(item), query);
  body.append(subtitle);

  const meta = document.createElement("span");
  meta.className = "search-result-meta";
  for (const value of resultMeta(item)) {
    const chip = document.createElement("span");
    chip.textContent = value;
    meta.append(chip);
  }
  body.append(meta);

  link.append(body);
  return link;
}

function updateActiveSearchResult() {
  if (!searchResults || !searchInput) return;

  const resultNodes = Array.from(
    searchResults.querySelectorAll<HTMLElement>(".search-result"),
  );

  for (const [index, result] of resultNodes.entries()) {
    const active = index === activeSearchIndex;
    result.classList.toggle("is-active", active);
    result.setAttribute("aria-selected", active ? "true" : "false");
    if (active) {
      searchInput.setAttribute("aria-activedescendant", result.id);
      result.scrollIntoView({ block: "nearest" });
    }
  }
}

function setActiveSearchIndex(index: number) {
  if (rankedSearchResults.length === 0) return;
  activeSearchIndex =
    (index + rankedSearchResults.length) % rankedSearchResults.length;
  updateActiveSearchResult();
}

function renderSearchResults() {
  if (!searchInput || !searchResults || !searchCount || !searchEmpty) return;

  const query = searchInput.value;
  rankedSearchResults = rankSearchItems(query);
  activeSearchIndex = rankedSearchResults.length > 0 ? 0 : -1;
  searchResults.replaceChildren();

  const fragment = document.createDocumentFragment();
  rankedSearchResults.forEach((result, index) => {
    fragment.append(createSearchResult(result, index, query));
  });
  searchResults.append(fragment);

  const normalizedQuery = normalizeSearchText(query);
  searchCount.textContent = normalizedQuery
    ? `${rankedSearchResults.length} result${rankedSearchResults.length === 1 ? "" : "s"}`
    : "Recently updated models, providers, and labs";
  searchEmpty.hidden = rankedSearchResults.length > 0;

  if (rankedSearchResults.length > 0) {
    searchInput.setAttribute("aria-activedescendant", "search-result-0");
  } else {
    searchInput.removeAttribute("aria-activedescendant");
  }
}

function openSearchModal() {
  if (!searchModal || !searchInput) return;
  if (helpModal?.open) closeDialog();
  if (mobileMenu?.open) closeMobileMenu(false);

  lastFocusedElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  if (!searchModal.open) searchModal.showModal();
  renderSearchResults();
  requestAnimationFrame(() => {
    searchInput.focus();
    searchInput.select();
  });
}

function closeSearchModal() {
  if (!searchModal) return;
  if (searchModal.open) searchModal.close();
  searchInput?.removeAttribute("aria-activedescendant");
  lastFocusedElement?.focus();
}

function closestSearchResult(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".search-result[data-search-index]");
}

searchTrigger?.addEventListener("click", openSearchModal);
mobileSearchTrigger?.addEventListener("click", openSearchModal);

/////////////////////
// Mobile Menu
/////////////////////
function openMobileMenu() {
  if (!mobileMenu || !mobileMenuTrigger) return;
  if (searchModal?.open) closeSearchModal();
  if (helpModal?.open) closeDialog();

  mobileMenu.showModal();
  mobileMenuTrigger.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    mobileMenu
      .querySelector<HTMLElement>(".mobile-menu-list a, .mobile-menu-list button")
      ?.focus();
  });
}

function closeMobileMenu(restoreFocus = true) {
  if (!mobileMenu || !mobileMenuTrigger) return;
  if (mobileMenu.open) mobileMenu.close();
  mobileMenuTrigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) mobileMenuTrigger.focus();
}

mobileMenuTrigger?.addEventListener("click", openMobileMenu);
mobileMenuClose?.addEventListener("click", () => closeMobileMenu());
mobileHelpTrigger?.addEventListener("click", openHelpDialog);

mobileMenu?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeMobileMenu();
});

mobileMenu?.addEventListener("click", (event) => {
  if (event.target === mobileMenu) closeMobileMenu();
});

searchModal?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSearchModal();
});

searchModal?.addEventListener("click", (event) => {
  if (event.target === searchModal) closeSearchModal();
});

searchResults?.addEventListener("mousemove", (event) => {
  const result = closestSearchResult(event.target);
  if (!result?.dataset.searchIndex) return;
  setActiveSearchIndex(Number(result.dataset.searchIndex));
});

searchResults?.addEventListener("click", (event) => {
  if (closestSearchResult(event.target)) {
    searchInput?.removeAttribute("aria-activedescendant");
  }
});

searchInput?.addEventListener("input", renderSearchResults);

searchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearchModal();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveSearchIndex(activeSearchIndex + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSearchIndex(activeSearchIndex - 1);
    return;
  }

  if (event.key === "Enter") {
    const result = rankedSearchResults[activeSearchIndex];
    if (!result) return;
    event.preventDefault();
    window.location.href = result.item.href;
  }
});

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && (key === "k" || key === "f")) {
    event.preventDefault();
    openSearchModal();
  }
});

////////////////////
// Sorting
////////////////////
function getCellSortValue(row: HTMLTableRowElement, index: number) {
  const cell = row.cells[index];
  return cell?.getAttribute("data-sort") ?? cell?.textContent?.trim() ?? "";
}

function compareValues(a: string, b: string, type: string | null) {
  if (a === "" && b === "") return 0;
  if (a === "") return 1;
  if (b === "") return -1;

  if (type === "number") {
    return Number(a) - Number(b);
  }

  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortTable(
  table: HTMLTableElement,
  column: number,
  direction: SortDirection,
) {
  const tbody = table.tBodies[0];
  const header = table.tHead?.rows[0]?.cells[column];
  if (!tbody || !header) return;

  const type = header.getAttribute("data-type");
  const rows = Array.from(tbody.rows).filter(
    (row) => !row.classList.contains("empty-row"),
  );

  rows.sort((rowA, rowB) => {
    const comparison = compareValues(
      getCellSortValue(rowA, column),
      getCellSortValue(rowB, column),
      type,
    );
    return direction === "asc" ? comparison : -comparison;
  });

  for (const row of rows) {
    tbody.appendChild(row);
  }

  for (const sortable of table.querySelectorAll("th.sortable")) {
    sortable.removeAttribute("aria-sort");
    const indicator = sortable.querySelector(".sort-indicator");
    if (indicator) indicator.textContent = "";
  }

  header.setAttribute(
    "aria-sort",
    direction === "asc" ? "ascending" : "descending",
  );
  const indicator = header.querySelector(".sort-indicator");
  if (indicator) indicator.textContent = direction === "asc" ? "↑" : "↓";
}

for (const table of tables) {
  const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("th"));
  headers.forEach((header, column) => {
    if (!header.classList.contains("sortable")) return;

    header.addEventListener("click", () => {
      const current = header.getAttribute("aria-sort");
      const direction: SortDirection =
        current === "ascending" ? "desc" : "asc";
      sortTable(table, column, direction);
    });
  });
}

////////////////////
// Copy Buttons
////////////////////
const copyTimers = new WeakMap<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();
const pointerCopyTimes = new WeakMap<HTMLButtonElement, number>();

function writeClipboardWithSelection(value: string) {
  let copied = false;
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", value);
    event.preventDefault();
    copied = true;
  };
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  window.focus();
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  document.addEventListener("copy", onCopy);

  try {
    return document.execCommand("copy") || copied;
  } finally {
    document.removeEventListener("copy", onCopy);
    textarea.remove();
  }
}

async function writeClipboard(value: string) {
  if (writeClipboardWithSelection(value)) return true;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function selectCopySource(button: HTMLButtonElement) {
  const source = button
    .closest(".code-line, td")
    ?.querySelector<HTMLElement>("code, .copy-source, span");
  const selection = window.getSelection();
  if (!source || !selection) return false;

  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

async function copyValue(button: HTMLButtonElement, value: string) {
  const originalLabel =
    button.dataset.copyLabel ??
    button.getAttribute("aria-label") ??
    button.title ??
    "Copy";
  button.dataset.copyLabel = originalLabel;

  const copyIcon = button.querySelector<HTMLElement>(".copy-icon");
  const checkIcon = button.querySelector<HTMLElement>(".check-icon");
  const copied = await writeClipboard(value);
  const selected = copied ? false : selectCopySource(button);

  window.clearTimeout(copyTimers.get(button));
  button.classList.toggle("copied", copied);
  button.classList.toggle("selected", selected);
  button.classList.toggle("copy-failed", !copied && !selected);

  const feedback = copied ? "Copied" : selected ? "Selected" : "Copy failed";
  button.setAttribute("aria-label", feedback);
  button.title = feedback;

  if (copyIcon && checkIcon) {
    copyIcon.style.display = copied ? "none" : "block";
    checkIcon.style.display = copied ? "block" : "none";
  }

  copyTimers.set(
    button,
    setTimeout(() => {
      button.classList.remove("copied", "selected", "copy-failed");
      button.setAttribute("aria-label", originalLabel);
      button.title = originalLabel;
      if (copyIcon && checkIcon) {
        copyIcon.style.display = "block";
        checkIcon.style.display = "none";
      }
    }, 1200),
  );
}

function copyFromEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return undefined;
  const button = target.closest<HTMLButtonElement>(
    ".copy-button[data-copy-value]",
  );
  const value = button?.dataset.copyValue;
  if (!button || !value) return undefined;
  return { button, value };
}

document.addEventListener("pointerdown", (event) => {
  const copy = copyFromEventTarget(event.target);
  if (!copy) return;
  pointerCopyTimes.set(copy.button, Date.now());
  void copyValue(copy.button, copy.value);
});

document.addEventListener("click", (event) => {
  const copy = copyFromEventTarget(event.target);
  if (!copy) return;

  const pointerCopyTime = pointerCopyTimes.get(copy.button);
  if (pointerCopyTime && Date.now() - pointerCopyTime < 500) return;

  void copyValue(copy.button, copy.value);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!(event.target instanceof Element)) return;
  const copy = copyFromEventTarget(event.target);
  if (!copy) return;
  event.preventDefault();
  void copyValue(copy.button, copy.value);
});
