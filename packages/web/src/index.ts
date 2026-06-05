type SortDirection = "asc" | "desc";

const modal = document.getElementById("modal") as HTMLDialogElement | null;
const modalClose = document.getElementById("close");
const help = document.getElementById("help");
const search = document.getElementById("search") as HTMLInputElement | null;
const tables = Array.from(
  document.querySelectorAll<HTMLTableElement>("table[data-enhanced-table]"),
);

let scrollYBeforeModal = 0;

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

/////////////////////////
// Help Dialog
/////////////////////////
help?.addEventListener("click", () => {
  if (!modal) return;
  scrollYBeforeModal = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${scrollYBeforeModal}px`;
  modal.showModal();
});

function closeDialog() {
  if (!modal) return;
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, scrollYBeforeModal);
}

modalClose?.addEventListener("click", closeDialog);
modal?.addEventListener("cancel", closeDialog);
modal?.addEventListener("click", (event) => {
  if (event.target === modal) closeDialog();
});

////////////////////
// Search
////////////////////
function filterRows() {
  if (!search) return;

  const terms = search.value
    .toLowerCase()
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

  for (const table of tables) {
    const rows = Array.from(table.tBodies[0]?.rows ?? []);
    let visibleCount = 0;

    for (const row of rows) {
      if (row.classList.contains("empty-row")) continue;

      const searchText =
        row.getAttribute("data-search")?.toLowerCase() ??
        row.textContent?.toLowerCase() ??
        "";
      const visible =
        terms.length === 0 ||
        terms.some((term) => searchText.includes(term));

      row.hidden = !visible;
      if (visible) visibleCount++;
    }

    table
      .closest(".table-section")
      ?.toggleAttribute("data-empty", visibleCount === 0);
  }
}

search?.addEventListener("input", () => {
  updateQueryParams({ search: search.value || null });
  filterRows();
});

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && (key === "k" || key === "f")) {
    event.preventDefault();
    search?.focus();
    search?.select();
  }
});

search?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    search.value = "";
    search.dispatchEvent(new Event("input"));
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

function initializeFromURL() {
  if (!search) return;
  search.value = getQueryParams().get("search") ?? "";
  filterRows();
}

initializeFromURL();
window.addEventListener("popstate", initializeFromURL);
