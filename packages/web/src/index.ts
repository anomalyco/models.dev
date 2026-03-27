const modal = document.getElementById("modal") as HTMLDialogElement;
const modalClose = document.getElementById("close")!;
const help = document.getElementById("help")!;
const search = document.getElementById("search")! as HTMLInputElement;
const filterToggle = document.getElementById("filter-toggle")!;
const filterBar = document.getElementById("filter-bar")!;
const filterCountEl = document.getElementById("filter-count")!;
const filterBadge = document.getElementById("filter-badge")!;
const clearFiltersBtn = document.getElementById("clear-filters")!;
const scrollSentinel = document.getElementById("scroll-sentinel")!;
const scrollSentinelTop = document.getElementById("scroll-sentinel-top")!;
const ghostContainer = document.getElementById("ghost-container")!;
const tbody = document.querySelector("table tbody")!;

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
  return (headerEl as HTMLElement).dataset.column || "";
}

function getColumnIndexByUrlName(name: string): number {
  const headers = document.querySelectorAll("th.sortable");
  return Array.from(headers).findIndex(
    (header) => (header as HTMLElement).dataset.column === name
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

/////////////////////////////////////////
// Infinite Scroll & Pagination State
/////////////////////////////////////////
const BATCH_SIZE = 100;
const MAX_FULL_ROWS = 500;
let allRows: HTMLTableRowElement[] = [];
let filteredRows: HTMLTableRowElement[] = [];
let fullRowStart = 0; // index in filteredRows where full rows begin
let fullRowEnd = 0;   // index in filteredRows where full rows end (exclusive)

////////////////////
// Handle Sorting
////////////////////
let currentSort = { column: -1, direction: "asc" };
let sortSource: "search" | "header" | "none" = "none";

function sortFilteredRows(column: number, direction: "asc" | "desc") {
  const header = document.querySelectorAll("th.sortable")[column];
  const columnType = header.getAttribute("data-type");
  if (!columnType) return;

  currentSort = { column, direction };
  updateQueryParams({
    sort: getColumnNameForURL(header),
    order: direction,
  });

  filteredRows.sort((a, b) => {
    const aValue = getCellValue(a.cells[column], columnType);
    const bValue = getCellValue(b.cells[column], columnType);

    if (aValue === undefined && bValue === undefined) return 0;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;

    let comparison = 0;
    if (columnType === "number" || columnType === "modalities") {
      comparison = (aValue as number) - (bValue as number);
    } else {
      comparison = (aValue as string).localeCompare(bValue as string);
    }

    return direction === "asc" ? comparison : -comparison;
  });

  // Update sort indicators
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((h, i) => {
    const indicator = h.querySelector(".sort-indicator")!;
    indicator.textContent = i === column ? (direction === "asc" ? "↑" : "↓") : "";
  });

  // Re-render from scratch with new sort order
  fullRowStart = 0;
  fullRowEnd = 0;
  renderView(true);
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
    sortSource = "header";
    sortFilteredRows(column, direction);
  });
});

///////////////////////////
// Filter State & Types
///////////////////////////
interface FilterState {
  text: string;
  reasoning: boolean | null;
  tool_call: boolean | null;
  open_weights: boolean | null;
  structured_output: boolean | null;
  inputModalities: Set<string>;
  outputModalities: Set<string>;
  inputCostMax: number | null;
  inputCostMin: number | null;
  outputCostMax: number | null;
  outputCostMin: number | null;
  contextLimitMin: number | null;
  contextLimitMax: number | null;
  outputLimitMin: number | null;
  outputLimitMax: number | null;
  provider: string;
  family: string;
  hideDeprecated: boolean;
  hideBeta: boolean;
}

function createDefaultFilterState(): FilterState {
  return {
    text: "",
    reasoning: null,
    tool_call: null,
    open_weights: null,
    structured_output: null,
    inputModalities: new Set(),
    outputModalities: new Set(),
    inputCostMax: null,
    inputCostMin: null,
    outputCostMax: null,
    outputCostMin: null,
    contextLimitMin: null,
    contextLimitMax: null,
    outputLimitMin: null,
    outputLimitMax: null,
    provider: "",
    family: "",
    hideDeprecated: false,
    hideBeta: false,
  };
}

///////////////////////////
// Smart Search Keywords
///////////////////////////
interface SmartKeyword {
  phrase: string;
  apply: (state: FilterState) => void;
  chipFilter?: string;
  sortAction?: { column: string; direction: "asc" | "desc" };
}

const SMART_KEYWORDS: SmartKeyword[] = [
  { phrase: "function calling", apply: (s) => { s.tool_call = true; }, chipFilter: "tool_call" },
  { phrase: "structured output", apply: (s) => { s.structured_output = true; }, chipFilter: "structured_output" },
  { phrase: "open source", apply: (s) => { s.open_weights = true; }, chipFilter: "open_weights" },
  { phrase: "open-source", apply: (s) => { s.open_weights = true; }, chipFilter: "open_weights" },
  { phrase: "open weights", apply: (s) => { s.open_weights = true; }, chipFilter: "open_weights" },
  { phrase: "open-weights", apply: (s) => { s.open_weights = true; }, chipFilter: "open_weights" },
  { phrase: "json mode", apply: (s) => { s.structured_output = true; }, chipFilter: "structured_output" },
  { phrase: "tool call", apply: (s) => { s.tool_call = true; }, chipFilter: "tool_call" },
  { phrase: "tool calling", apply: (s) => { s.tool_call = true; }, chipFilter: "tool_call" },
  { phrase: "image input", apply: (s) => { s.inputModalities.add("image"); }, chipFilter: "input-image" },
  { phrase: "audio input", apply: (s) => { s.inputModalities.add("audio"); }, chipFilter: "input-audio" },
  { phrase: "video input", apply: (s) => { s.inputModalities.add("video"); }, chipFilter: "input-video" },
  { phrase: "image output", apply: (s) => { s.outputModalities.add("image"); }, chipFilter: "output-image" },
  { phrase: "image generation", apply: (s) => { s.outputModalities.add("image"); }, chipFilter: "output-image" },
  { phrase: "audio output", apply: (s) => { s.outputModalities.add("audio"); }, chipFilter: "output-audio" },
  { phrase: "video output", apply: (s) => { s.outputModalities.add("video"); }, chipFilter: "output-video" },
  { phrase: "long context", apply: (s) => { s.contextLimitMin = 100000; } },
  { phrase: "large context", apply: (s) => { s.contextLimitMin = 100000; } },
  { phrase: "hide deprecated", apply: (s) => { s.hideDeprecated = true; }, chipFilter: "hide-deprecated" },
  { phrase: "hide beta", apply: (s) => { s.hideBeta = true; }, chipFilter: "hide-beta" },
  { phrase: "reasoning", apply: (s) => { s.reasoning = true; }, chipFilter: "reasoning" },
  { phrase: "thinking", apply: (s) => { s.reasoning = true; }, chipFilter: "reasoning" },
  { phrase: "thinks", apply: (s) => { s.reasoning = true; }, chipFilter: "reasoning" },
  { phrase: "reason", apply: (s) => { s.reasoning = true; }, chipFilter: "reasoning" },
  { phrase: "tools", apply: (s) => { s.tool_call = true; }, chipFilter: "tool_call" },
  { phrase: "tool", apply: (s) => { s.tool_call = true; }, chipFilter: "tool_call" },
  { phrase: "structured", apply: (s) => { s.structured_output = true; }, chipFilter: "structured_output" },
  { phrase: "json", apply: (s) => { s.structured_output = true; }, chipFilter: "structured_output" },
  { phrase: "oss", apply: (s) => { s.open_weights = true; }, chipFilter: "open_weights" },
  { phrase: "vision", apply: (s) => { s.inputModalities.add("image"); }, chipFilter: "input-image" },
  { phrase: "multimodal", apply: (s) => { s.inputModalities.add("image"); }, chipFilter: "input-image" },
  { phrase: "image", apply: (s) => { s.inputModalities.add("image"); }, chipFilter: "input-image" },
  { phrase: "audio", apply: (s) => { s.inputModalities.add("audio"); }, chipFilter: "input-audio" },
  { phrase: "voice", apply: (s) => { s.inputModalities.add("audio"); }, chipFilter: "input-audio" },
  { phrase: "video", apply: (s) => { s.inputModalities.add("video"); }, chipFilter: "input-video" },
  { phrase: "pdf", apply: (s) => { s.inputModalities.add("pdf"); }, chipFilter: "input-pdf" },
  { phrase: "tts", apply: (s) => { s.outputModalities.add("audio"); }, chipFilter: "output-audio" },
  { phrase: "speech", apply: (s) => { s.outputModalities.add("audio"); }, chipFilter: "output-audio" },
  { phrase: "free", apply: (s) => { s.inputCostMax = 0; s.outputCostMax = 0; } },
];

const SORTED_KEYWORDS = [...SMART_KEYWORDS].sort((a, b) => b.phrase.length - a.phrase.length);
const NOISE_WORDS = new Set(["models", "model", "with", "and", "that", "the", "for", "can", "has", "have", "are", "is", "a", "an", "on", "of", "to", "or"]);

///////////////////////////
// Smart Search Parser
///////////////////////////
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

const SORT_ALIASES: Record<string, string> = {
  "input": "input-cost",
  "output": "output-cost",
  "cache-r": "cache-read-cost",
  "cache-w": "cache-write-cost",
  "audio-in": "audio-input-cost",
  "audio-out": "audio-output-cost",
  "context": "context-limit",
  "update": "last-updated",
  "release": "release-date",
  "reasoning": "reasoning-cost",
};

function parseNumericFilter(value: string): { op: "<" | ">"; num: number } | null {
  const m = value.match(/^([<>])(\d+(?:\.\d+)?)(k|m)?$/i);
  if (!m) return null;
  let num = parseFloat(m[2]);
  if (m[3]?.toLowerCase() === "k") num *= 1000;
  if (m[3]?.toLowerCase() === "m") num *= 1000000;
  return { op: m[1] as "<" | ">", num };
}

interface ParseResult {
  state: FilterState;
  matchedChips: Set<string>;
  sortActions: Array<{ column: string; direction: "asc" | "desc" }>;
}

function parseSmartSearch(query: string): ParseResult {
  const state = createDefaultFilterState();
  let remaining = query.toLowerCase().trim();
  const matchedChips = new Set<string>();
  const sortActions: Array<{ column: string; direction: "asc" | "desc" }> = [];

  if (!remaining) {
    return { state, matchedChips, sortActions };
  }

  // 1. Extract keyword filters (prefix:value)
  const keywordRegex = /(?:^|\s)(in|out|ctx|outlimit|provider|p|family|f|status|sort):(\S+)/gi;
  let kwMatch;
  while ((kwMatch = keywordRegex.exec(remaining)) !== null) {
    const prefix = kwMatch[1].toLowerCase();
    const value = kwMatch[2].toLowerCase();

    switch (prefix) {
      case "in": {
        if (MODALITIES.has(value)) {
          state.inputModalities.add(value);
          matchedChips.add(`input-${value}`);
        } else {
          const parsed = parseNumericFilter(value);
          if (parsed) {
            if (parsed.op === "<") state.inputCostMax = parsed.num;
            else state.inputCostMin = parsed.num;
          }
        }
        break;
      }
      case "out": {
        if (MODALITIES.has(value)) {
          state.outputModalities.add(value);
          matchedChips.add(`output-${value}`);
        } else {
          const parsed = parseNumericFilter(value);
          if (parsed) {
            if (parsed.op === "<") state.outputCostMax = parsed.num;
            else state.outputCostMin = parsed.num;
          }
        }
        break;
      }
      case "ctx": {
        const parsed = parseNumericFilter(value);
        if (parsed) {
          if (parsed.op === ">") state.contextLimitMin = parsed.num;
          else state.contextLimitMax = parsed.num;
        }
        break;
      }
      case "outlimit": {
        const parsed = parseNumericFilter(value);
        if (parsed) {
          if (parsed.op === ">") state.outputLimitMin = parsed.num;
          else state.outputLimitMax = parsed.num;
        }
        break;
      }
      case "provider": case "p":
        state.provider = value;
        break;
      case "family": case "f":
        state.family = value;
        break;
      case "status":
        if (value === "deprecated") state.hideDeprecated = true;
        else if (value === "beta") state.hideBeta = true;
        break;
      case "sort": {
        let dir: "asc" | "desc" = "asc";
        let col = value;
        if (col.startsWith("-")) { dir = "desc"; col = col.slice(1); }
        sortActions.push({ column: SORT_ALIASES[col] || col, direction: dir });
        break;
      }
    }
  }
  // Remove matched keyword filters from remaining
  remaining = remaining.replace(keywordRegex, " ").trim();

  // 2. Natural-language keyword matching
  for (const kw of SORTED_KEYWORDS) {
    const regex = new RegExp(`\\b${escapeRegex(kw.phrase)}\\b`, "i");
    if (regex.test(remaining)) {
      kw.apply(state);
      if (kw.chipFilter) matchedChips.add(kw.chipFilter);
      if (kw.sortAction) sortActions.push(kw.sortAction);
      remaining = remaining.replace(regex, " ").trim();
    }
  }

  // 3. Remaining words become AND text terms
  const words = remaining.split(/\s+/).filter(Boolean);
  const unmatchedWords: string[] = [];
  for (const word of words) {
    if (NOISE_WORDS.has(word)) continue;
    unmatchedWords.push(word);
  }

  state.text = unmatchedWords.join(" ");
  return { state, matchedChips, sortActions };
}

///////////////////////////
// Filter Engine
///////////////////////////
function applyFiltersToArray(state: FilterState): HTMLTableRowElement[] {
  return allRows.filter((row) => {
    const d = row.dataset;

    if (state.reasoning !== null && (d.reasoning === "1") !== state.reasoning) return false;
    if (state.tool_call !== null && (d.toolCall === "1") !== state.tool_call) return false;
    if (state.open_weights !== null && (d.openWeights === "1") !== state.open_weights) return false;
    if (state.structured_output !== null) {
      if (d.structuredOutput !== "" && (d.structuredOutput === "1") !== state.structured_output) return false;
    }

    if (state.inputModalities.size > 0) {
      const rowMods = d.inputModalities?.split(",") ?? [];
      for (const mod of state.inputModalities) {
        if (!rowMods.includes(mod)) return false;
      }
    }

    if (state.outputModalities.size > 0) {
      const rowMods = d.outputModalities?.split(",") ?? [];
      for (const mod of state.outputModalities) {
        if (!rowMods.includes(mod)) return false;
      }
    }

    if (state.inputCostMax !== null) {
      const cost = d.inputCost ? parseFloat(d.inputCost) : null;
      if (cost === null || cost > state.inputCostMax) return false;
    }
    if (state.inputCostMin !== null) {
      const cost = d.inputCost ? parseFloat(d.inputCost) : null;
      if (cost === null || cost < state.inputCostMin) return false;
    }
    if (state.outputCostMax !== null) {
      const cost = d.outputCost ? parseFloat(d.outputCost) : null;
      if (cost === null || cost > state.outputCostMax) return false;
    }
    if (state.outputCostMin !== null) {
      const cost = d.outputCost ? parseFloat(d.outputCost) : null;
      if (cost === null || cost < state.outputCostMin) return false;
    }
    if (state.contextLimitMin !== null) {
      const limit = d.contextLimit ? parseFloat(d.contextLimit) : 0;
      if (limit < state.contextLimitMin) return false;
    }
    if (state.contextLimitMax !== null) {
      const limit = d.contextLimit ? parseFloat(d.contextLimit) : 0;
      if (limit > state.contextLimitMax) return false;
    }
    if (state.outputLimitMin !== null) {
      const limit = d.outputLimit ? parseFloat(d.outputLimit) : 0;
      if (limit < state.outputLimitMin) return false;
    }
    if (state.outputLimitMax !== null) {
      const limit = d.outputLimit ? parseFloat(d.outputLimit) : 0;
      if (limit > state.outputLimitMax) return false;
    }

    if (state.provider) {
      if (!(d.provider?.includes(state.provider) || d.providerId?.includes(state.provider))) return false;
    }

    if (state.family) {
      if (!d.family?.includes(state.family)) return false;
    }

    if (state.hideDeprecated && d.status === "deprecated") return false;
    if (state.hideBeta && d.status === "beta") return false;

    // AND logic: every word must match in at least one cell
    if (state.text) {
      const terms = state.text.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const cellTexts = Array.from(row.cells).map(c => c.textContent!.toLowerCase());
        if (!terms.every(term => cellTexts.some(text => text.includes(term)))) return false;
      }
    }

    return true;
  });
}

///////////////////////////
// Chip State Management
///////////////////////////
let chipState = createDefaultFilterState();
let lastParseResult: ParseResult = { state: createDefaultFilterState(), matchedChips: new Set(), sortActions: [] };

const CHIP_TOGGLE_MAP: Record<string, (state: FilterState) => boolean> = {
  "reasoning": (s) => { s.reasoning = s.reasoning === null ? true : null; return s.reasoning !== null; },
  "tool_call": (s) => { s.tool_call = s.tool_call === null ? true : null; return s.tool_call !== null; },
  "open_weights": (s) => { s.open_weights = s.open_weights === null ? true : null; return s.open_weights !== null; },
  "structured_output": (s) => { s.structured_output = s.structured_output === null ? true : null; return s.structured_output !== null; },
  "input-text": (s) => { return toggleSet(s.inputModalities, "text"); },
  "input-image": (s) => { return toggleSet(s.inputModalities, "image"); },
  "input-audio": (s) => { return toggleSet(s.inputModalities, "audio"); },
  "input-video": (s) => { return toggleSet(s.inputModalities, "video"); },
  "input-pdf": (s) => { return toggleSet(s.inputModalities, "pdf"); },
  "output-text": (s) => { return toggleSet(s.outputModalities, "text"); },
  "output-image": (s) => { return toggleSet(s.outputModalities, "image"); },
  "output-audio": (s) => { return toggleSet(s.outputModalities, "audio"); },
  "output-video": (s) => { return toggleSet(s.outputModalities, "video"); },
  "hide-deprecated": (s) => { s.hideDeprecated = !s.hideDeprecated; return s.hideDeprecated; },
  "hide-beta": (s) => { s.hideBeta = !s.hideBeta; return s.hideBeta; },
};

function toggleSet(set: Set<string>, value: string): boolean {
  if (set.has(value)) { set.delete(value); return false; }
  set.add(value);
  return true;
}

///////////////////////////
// Merge States
///////////////////////////
function computeFinalState(): FilterState {
  const final = createDefaultFilterState();
  const smart = lastParseResult.state;

  final.text = smart.text;
  final.reasoning = smart.reasoning;
  final.tool_call = smart.tool_call;
  final.open_weights = smart.open_weights;
  final.structured_output = smart.structured_output;
  for (const m of smart.inputModalities) final.inputModalities.add(m);
  for (const m of smart.outputModalities) final.outputModalities.add(m);
  final.inputCostMax = smart.inputCostMax;
  final.inputCostMin = smart.inputCostMin;
  final.outputCostMax = smart.outputCostMax;
  final.outputCostMin = smart.outputCostMin;
  final.contextLimitMin = smart.contextLimitMin;
  final.contextLimitMax = smart.contextLimitMax;
  final.outputLimitMin = smart.outputLimitMin;
  final.outputLimitMax = smart.outputLimitMax;
  final.provider = smart.provider;
  final.family = smart.family;
  final.hideDeprecated = smart.hideDeprecated;
  final.hideBeta = smart.hideBeta;

  if (chipState.reasoning !== null) final.reasoning = chipState.reasoning;
  if (chipState.tool_call !== null) final.tool_call = chipState.tool_call;
  if (chipState.open_weights !== null) final.open_weights = chipState.open_weights;
  if (chipState.structured_output !== null) final.structured_output = chipState.structured_output;
  for (const m of chipState.inputModalities) final.inputModalities.add(m);
  for (const m of chipState.outputModalities) final.outputModalities.add(m);
  if (chipState.hideDeprecated) final.hideDeprecated = true;
  if (chipState.hideBeta) final.hideBeta = true;

  return final;
}

///////////////////////////
// UI Sync
///////////////////////////
function syncChipUI(finalState: FilterState) {
  const chips = document.querySelectorAll(".filter-chip") as NodeListOf<HTMLButtonElement>;
  chips.forEach((chip) => {
    const filter = chip.dataset.filter!;
    let isActive = false;
    const isSmartMatched = lastParseResult.matchedChips.has(filter);

    switch (filter) {
      case "reasoning": isActive = finalState.reasoning === true; break;
      case "tool_call": isActive = finalState.tool_call === true; break;
      case "open_weights": isActive = finalState.open_weights === true; break;
      case "structured_output": isActive = finalState.structured_output === true; break;
      case "input-text": isActive = finalState.inputModalities.has("text"); break;
      case "input-image": isActive = finalState.inputModalities.has("image"); break;
      case "input-audio": isActive = finalState.inputModalities.has("audio"); break;
      case "input-video": isActive = finalState.inputModalities.has("video"); break;
      case "input-pdf": isActive = finalState.inputModalities.has("pdf"); break;
      case "output-text": isActive = finalState.outputModalities.has("text"); break;
      case "output-image": isActive = finalState.outputModalities.has("image"); break;
      case "output-audio": isActive = finalState.outputModalities.has("audio"); break;
      case "output-video": isActive = finalState.outputModalities.has("video"); break;
      case "hide-deprecated": isActive = finalState.hideDeprecated; break;
      case "hide-beta": isActive = finalState.hideBeta; break;
    }

    chip.classList.toggle("active", isActive);
    chip.classList.toggle("smart-matched", isSmartMatched && isActive);
  });
}

function countActiveFilters(state: FilterState): number {
  let count = 0;
  if (state.reasoning !== null) count++;
  if (state.tool_call !== null) count++;
  if (state.open_weights !== null) count++;
  if (state.structured_output !== null) count++;
  count += state.inputModalities.size;
  count += state.outputModalities.size;
  if (state.inputCostMax !== null) count++;
  if (state.inputCostMin !== null) count++;
  if (state.outputCostMax !== null) count++;
  if (state.outputCostMin !== null) count++;
  if (state.contextLimitMin !== null) count++;
  if (state.contextLimitMax !== null) count++;
  if (state.outputLimitMin !== null) count++;
  if (state.outputLimitMax !== null) count++;
  if (state.provider) count++;
  if (state.family) count++;
  if (state.hideDeprecated) count++;
  if (state.hideBeta) count++;
  return count;
}

function updateFilterUI(state: FilterState) {
  const activeCount = countActiveFilters(state);
  const hasFilters = activeCount > 0 || state.text;

  if (hasFilters) {
    filterCountEl.textContent = `${filteredRows.length.toLocaleString()} of ${allRows.length.toLocaleString()} models`;
    filterCountEl.hidden = false;
    clearFiltersBtn.hidden = false;
  } else {
    filterCountEl.hidden = true;
    clearFiltersBtn.hidden = true;
  }

  if (activeCount > 0) {
    filterBadge.textContent = String(activeCount);
    filterBadge.hidden = false;
  } else {
    filterBadge.hidden = true;
  }
}

///////////////////////////
// URL Persistence
///////////////////////////
function filterStateToURLParams(state: FilterState): Record<string, string | null> {
  return {
    search: search.value || null,
    reasoning: state.reasoning === true ? "1" : null,
    tool_call: state.tool_call === true ? "1" : null,
    open_weights: state.open_weights === true ? "1" : null,
    structured_output: state.structured_output === true ? "1" : null,
    input: state.inputModalities.size > 0 ? Array.from(state.inputModalities).join(",") : null,
    output: state.outputModalities.size > 0 ? Array.from(state.outputModalities).join(",") : null,
    max_input_cost: state.inputCostMax !== null ? String(state.inputCostMax) : null,
    min_input_cost: state.inputCostMin !== null ? String(state.inputCostMin) : null,
    max_output_cost: state.outputCostMax !== null ? String(state.outputCostMax) : null,
    min_output_cost: state.outputCostMin !== null ? String(state.outputCostMin) : null,
    min_context: state.contextLimitMin !== null ? String(state.contextLimitMin) : null,
    max_context: state.contextLimitMax !== null ? String(state.contextLimitMax) : null,
    min_output_limit: state.outputLimitMin !== null ? String(state.outputLimitMin) : null,
    max_output_limit: state.outputLimitMax !== null ? String(state.outputLimitMax) : null,
    provider: state.provider || null,
    family: state.family || null,
    hide_deprecated: state.hideDeprecated ? "1" : null,
    hide_beta: state.hideBeta ? "1" : null,
  };
}

function urlParamsToChipState(params: URLSearchParams): FilterState {
  const state = createDefaultFilterState();
  if (params.get("reasoning") === "1") state.reasoning = true;
  if (params.get("tool_call") === "1") state.tool_call = true;
  if (params.get("open_weights") === "1") state.open_weights = true;
  if (params.get("structured_output") === "1") state.structured_output = true;
  const inputMods = params.get("input");
  if (inputMods) inputMods.split(",").forEach(m => state.inputModalities.add(m));
  const outputMods = params.get("output");
  if (outputMods) outputMods.split(",").forEach(m => state.outputModalities.add(m));
  const maxIn = params.get("max_input_cost");
  if (maxIn) state.inputCostMax = parseFloat(maxIn);
  const minIn = params.get("min_input_cost");
  if (minIn) state.inputCostMin = parseFloat(minIn);
  const maxOut = params.get("max_output_cost");
  if (maxOut) state.outputCostMax = parseFloat(maxOut);
  const minOut = params.get("min_output_cost");
  if (minOut) state.outputCostMin = parseFloat(minOut);
  const minCtx = params.get("min_context");
  if (minCtx) state.contextLimitMin = parseFloat(minCtx);
  const maxCtx = params.get("max_context");
  if (maxCtx) state.contextLimitMax = parseFloat(maxCtx);
  const minOl = params.get("min_output_limit");
  if (minOl) state.outputLimitMin = parseFloat(minOl);
  const maxOl = params.get("max_output_limit");
  if (maxOl) state.outputLimitMax = parseFloat(maxOl);
  state.provider = params.get("provider") ?? "";
  state.family = params.get("family") ?? "";
  state.hideDeprecated = params.get("hide_deprecated") === "1";
  state.hideBeta = params.get("hide_beta") === "1";
  return state;
}

/////////////////////////////////////
// Render Engine (Infinite Scroll)
// Sliding window: at most MAX_FULL_ROWS full rows in DOM.
// Everything outside [fullRowStart, fullRowEnd) is a ghost row.
/////////////////////////////////////

// Feature-detect hidden="until-found" support
const supportsHiddenUntilFound = (() => {
  const el = document.createElement("div");
  el.setAttribute("hidden", "until-found");
  return el.hidden !== true; // if supported, .hidden returns false
})();

function navigateToGhost(targetIdx: number) {
  if (targetIdx >= fullRowStart && targetIdx < fullRowEnd) return;

  const halfWindow = Math.floor(MAX_FULL_ROWS / 2);
  fullRowStart = Math.max(0, targetIdx - halfWindow);
  fullRowEnd = Math.min(fullRowStart + MAX_FULL_ROWS, filteredRows.length);
  if (fullRowEnd - fullRowStart < MAX_FULL_ROWS) {
    fullRowStart = Math.max(0, fullRowEnd - MAX_FULL_ROWS);
  }

  renderView();

  const fullRow = filteredRows[targetIdx];
  if (fullRow.parentElement) {
    fullRow.scrollIntoView({ block: "center" });
  }
}

function createGhostEntry(i: number): HTMLDivElement {
  const row = filteredRows[i];
  const ghost = document.createElement("div");
  ghost.className = "ghost-entry";
  ghost.dataset.ghostIndex = String(i);
  const d = row.dataset;
  ghost.textContent = `${d.provider} ${d.model} ${d.family || ""} ${d.providerId} ${d.modelId}`;

  if (supportsHiddenUntilFound) {
    ghost.setAttribute("hidden", "until-found");
    ghost.addEventListener("beforematch", () => {
      // Re-hide immediately so it doesn't flash visible
      ghost.setAttribute("hidden", "until-found");
      navigateToGhost(parseInt(ghost.dataset.ghostIndex!));
    });
  }

  return ghost;
}

// Fallback: detect Ctrl+F landing on a ghost via selectionchange
if (!supportsHiddenUntilFound) {
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.getRangeAt(0).startContainer;
    const ghost = (node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : node as Element
    )?.closest(".ghost-entry") as HTMLElement | null;
    if (ghost && ghost.dataset.ghostIndex) {
      navigateToGhost(parseInt(ghost.dataset.ghostIndex));
    }
  });
}

// Deferred ghost building — populate ghost container in idle time
const rIC = typeof requestIdleCallback === "function"
  ? requestIdleCallback
  : (cb: () => void) => setTimeout(cb, 1) as unknown as number;
const cIC = typeof cancelIdleCallback === "function"
  ? cancelIdleCallback
  : (id: number) => clearTimeout(id);

let ghostBuildId = 0;
const GHOST_BATCH = 500;

function scheduleGhostBuild() {
  // Cancel any in-progress ghost build
  if (ghostBuildId) cIC(ghostBuildId);
  ghostContainer.textContent = "";

  // Collect indices that need ghost entries
  const indices: number[] = [];
  for (let i = 0; i < filteredRows.length; i++) {
    if (i >= fullRowStart && i < fullRowEnd) continue;
    indices.push(i);
  }

  let offset = 0;
  function buildBatch() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(offset + GHOST_BATCH, indices.length);
    for (let j = offset; j < end; j++) {
      fragment.appendChild(createGhostEntry(indices[j]));
    }
    ghostContainer.appendChild(fragment);
    offset = end;
    if (offset < indices.length) {
      ghostBuildId = rIC(buildBatch);
    } else {
      ghostBuildId = 0;
    }
  }

  if (indices.length > 0) {
    ghostBuildId = rIC(buildBatch);
  }
}

// Full rebuild of tbody from current window state, ghosts deferred
function renderView(reset = false) {
  if (reset) {
    fullRowEnd = Math.min(fullRowStart + BATCH_SIZE, filteredRows.length);
  }

  // Clamp window to MAX_FULL_ROWS
  if (fullRowEnd - fullRowStart > MAX_FULL_ROWS) {
    fullRowStart = fullRowEnd - MAX_FULL_ROWS;
  }

  // Clear tbody — only full rows live here
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (let i = fullRowStart; i < fullRowEnd; i++) {
    tbody.appendChild(filteredRows[i]);
  }

  // Build ghosts in idle time
  scheduleGhostBuild();
}

// Extend window downward (infinite scroll)
function extendWindow() {
  if (fullRowEnd >= filteredRows.length) return;

  const newEnd = Math.min(fullRowEnd + BATCH_SIZE, filteredRows.length);

  // Append new full rows to tbody
  for (let i = fullRowEnd; i < newEnd; i++) {
    tbody.appendChild(filteredRows[i]);
  }

  fullRowEnd = newEnd;

  // Trim front if window exceeds MAX_FULL_ROWS
  if (fullRowEnd - fullRowStart > MAX_FULL_ROWS) {
    const newStart = fullRowEnd - MAX_FULL_ROWS;
    for (let i = fullRowStart; i < newStart; i++) {
      tbody.removeChild(tbody.firstChild!);
    }
    fullRowStart = newStart;
  }

  // Rebuild ghosts in idle time
  scheduleGhostBuild();
}


// Extend window upward (scroll up recovery)
function extendWindowUp() {
  if (fullRowStart <= 0) return;

  const newStart = Math.max(0, fullRowStart - BATCH_SIZE);

  // Prepend rows to the top of tbody
  const firstChild = tbody.firstChild;
  for (let i = newStart; i < fullRowStart; i++) {
    tbody.insertBefore(filteredRows[i], firstChild);
  }

  fullRowStart = newStart;

  // Trim back if window exceeds MAX_FULL_ROWS
  if (fullRowEnd - fullRowStart > MAX_FULL_ROWS) {
    const newEnd = fullRowStart + MAX_FULL_ROWS;
    for (let i = fullRowEnd - 1; i >= newEnd; i--) {
      tbody.removeChild(tbody.lastChild!);
    }
    fullRowEnd = newEnd;
  }

  // Rebuild ghosts in idle time
  scheduleGhostBuild();
}

// IntersectionObserver for infinite scroll (bottom)
const scrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && fullRowEnd < filteredRows.length) {
    extendWindow();
  }
}, { rootMargin: "400px" });

scrollObserver.observe(scrollSentinel);

// IntersectionObserver for scroll-up recovery (top)
const scrollObserverTop = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && fullRowStart > 0) {
    extendWindowUp();
  }
}, { rootMargin: "400px" });

scrollObserverTop.observe(scrollSentinelTop);

///////////////////////////
// Main Apply Function
///////////////////////////
function applyAll() {
  const final = computeFinalState();
  filteredRows = applyFiltersToArray(final);

  // Apply sort actions from smart search
  if (lastParseResult.sortActions.length > 0) {
    for (const action of lastParseResult.sortActions) {
      const colIdx = getColumnIndexByUrlName(action.column);
      if (colIdx !== -1) {
        currentSort = { column: colIdx, direction: action.direction };
        sortSource = "search";
        const headers = document.querySelectorAll("th.sortable");
        headers.forEach((h, i) => {
          const indicator = h.querySelector(".sort-indicator")!;
          indicator.textContent = i === colIdx ? (action.direction === "asc" ? "↑" : "↓") : "";
        });
      }
    }
  } else if (sortSource === "search") {
    // Search sort keyword was removed — reset sort
    currentSort = { column: -1, direction: "asc" };
    sortSource = "none";
    document.querySelectorAll("th.sortable .sort-indicator").forEach((el) => {
      el.textContent = "";
    });
    updateQueryParams({ sort: null, order: null });
  }

  // Re-apply current sort if active
  if (currentSort.column !== -1) {
    const header = document.querySelectorAll("th.sortable")[currentSort.column];
    const columnType = header?.getAttribute("data-type");
    if (columnType) {
      filteredRows.sort((a, b) => {
        const aVal = getCellValue(a.cells[currentSort.column], columnType);
        const bVal = getCellValue(b.cells[currentSort.column], columnType);
        if (aVal === undefined && bVal === undefined) return 0;
        if (aVal === undefined) return 1;
        if (bVal === undefined) return -1;
        let cmp = 0;
        if (columnType === "number" || columnType === "modalities") {
          cmp = (aVal as number) - (bVal as number);
        } else {
          cmp = (aVal as string).localeCompare(bVal as string);
        }
        return currentSort.direction === "asc" ? cmp : -cmp;
      });
    }
  }

  fullRowStart = 0;
  fullRowEnd = 0;
  renderView(true);

  syncChipUI(final);
  updateFilterUI(final);
  updateQueryParams(filterStateToURLParams(final));
}

///////////////////////////
// Filter Bar Toggle
///////////////////////////
function showFilterBar() {
  filterBar.hidden = false;
  filterToggle.setAttribute("aria-expanded", "true");
  document.body.classList.add("filters-visible");
  const height = filterBar.offsetHeight;
  document.documentElement.style.setProperty("--filter-bar-height", `${height}px`);
}

function hideFilterBar() {
  filterBar.hidden = true;
  filterToggle.setAttribute("aria-expanded", "false");
  document.body.classList.remove("filters-visible");
}

filterToggle.addEventListener("click", () => {
  if (filterBar.hidden) {
    showFilterBar();
  } else {
    hideFilterBar();
  }
});

///////////////////////////
// Chip Click Handlers
///////////////////////////
document.querySelectorAll(".filter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const filter = (chip as HTMLElement).dataset.filter!;
    const toggleFn = CHIP_TOGGLE_MAP[filter];
    if (toggleFn) {
      toggleFn(chipState);
      applyAll();
    }
  });
});

///////////////////////////
// Clear All Filters
///////////////////////////
clearFiltersBtn.addEventListener("click", () => {
  chipState = createDefaultFilterState();
  search.value = "";
  lastParseResult = { state: createDefaultFilterState(), matchedChips: new Set(), sortActions: [] };
  applyAll();
});

///////////////////////////
// Search Input Handler
///////////////////////////
search.addEventListener("input", () => {
  lastParseResult = parseSmartSearch(search.value);

  if (lastParseResult.matchedChips.size > 0 && filterBar.hidden) {
    showFilterBar();
  }

  applyAll();
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
    chipState = createDefaultFilterState();
    lastParseResult = { state: createDefaultFilterState(), matchedChips: new Set(), sortActions: [] };
    applyAll();
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
// Initialize
///////////////////////////////////
function initialize() {
  const table = document.querySelector("table")!;

  // Grab refs to all rows, then clear tbody in one shot (avoids per-row reflow)
  allRows = Array.from(tbody.querySelectorAll("tr")) as HTMLTableRowElement[];
  tbody.textContent = "";

  // Initialize from URL
  const params = getQueryParams();

  const searchQuery = params.get("search");
  if (searchQuery) {
    search.value = searchQuery;
    lastParseResult = parseSmartSearch(searchQuery);
  }

  chipState = urlParamsToChipState(params);

  const hasChipFilters = countActiveFilters(chipState) > 0;
  const hasSmartFilters = lastParseResult.matchedChips.size > 0;
  if (hasChipFilters || hasSmartFilters) {
    showFilterBar();
  }

  // Apply all filters and render first batch
  applyAll();

  // Restore sort
  const columnName = params.get("sort");
  if (columnName) {
    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex !== -1) {
      const direction = (params.get("order") as "asc" | "desc") || "asc";
      sortFilteredRows(columnIndex, direction);
    }
  }

  // Reveal table now that only the first batch is in the DOM
  table.classList.remove("not-ready");
}

// Run on load
initialize();

window.addEventListener("popstate", () => {
  const params = getQueryParams();
  const searchQuery = params.get("search");
  search.value = searchQuery || "";
  if (searchQuery) {
    lastParseResult = parseSmartSearch(searchQuery);
  } else {
    lastParseResult = { state: createDefaultFilterState(), matchedChips: new Set(), sortActions: [] };
  }
  chipState = urlParamsToChipState(params);
  applyAll();

  const columnName = params.get("sort");
  if (columnName) {
    const columnIndex = getColumnIndexByUrlName(columnName);
    if (columnIndex !== -1) {
      const direction = (params.get("order") as "asc" | "desc") || "asc";
      sortFilteredRows(columnIndex, direction);
    }
  }
});
