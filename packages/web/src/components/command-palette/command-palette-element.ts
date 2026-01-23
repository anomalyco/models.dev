export interface CommandPaletteAction {
  id: string;
  title: string;
  section?: string;
  keywords?: string;
  hotkey?: string;
  icon?: string;
  iconUrl?: string;
  parent?: string;
  children?: Array<string | CommandPaletteAction>;
  external?: boolean;
  handler?: () => void | { keepOpen: boolean };
}

type OpenOptions = { parent?: string };

type ChangeDetail = { search: string; actions: CommandPaletteAction[] };

type SelectedDetail = {
  search: string;
  action: CommandPaletteAction | undefined;
};

function wordBasedScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  if (!haystack) return null;

  // Check if the search term appears as a substring
  const index = haystack.indexOf(needle);
  if (index === -1) return null;

  let score = 100; // Base score for match

  // Bonus for exact word boundary matches
  const beforeChar = index > 0 ? haystack[index - 1] : "";
  const afterChar =
    index + needle.length < haystack.length
      ? haystack[index + needle.length]
      : "";

  // Higher score if match is at word boundary
  if (
    index === 0 ||
    beforeChar === " " ||
    beforeChar === "-" ||
    beforeChar === "_" ||
    beforeChar === "/"
  ) {
    score += 50;
  }

  if (
    index + needle.length === haystack.length ||
    afterChar === " " ||
    afterChar === "-" ||
    afterChar === "_" ||
    afterChar === "/"
  ) {
    score += 30;
  }

  // Prefer earlier matches
  score += Math.max(0, 50 - index);

  return score;
}

type HotkeyCombo = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

function normalizeKey(raw: string): string {
  const key = raw.toLowerCase();
  if (key === " ") return "space";
  if (key === "esc") return "escape";
  return key;
}

function normalizeCombo(combo: HotkeyCombo): string {
  return [
    combo.meta ? "meta" : "",
    combo.ctrl ? "ctrl" : "",
    combo.alt ? "alt" : "",
    combo.shift ? "shift" : "",
    combo.key,
  ]
    .filter(Boolean)
    .join("+");
}

function parseHotkeyCombo(text: string): HotkeyCombo | null {
  const tokens = text
    .toLowerCase()
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (const token of tokens) {
    if (token === "cmd" || token === "command" || token === "meta") {
      meta = true;
      continue;
    }
    if (token === "ctrl" || token === "control") {
      ctrl = true;
      continue;
    }
    if (token === "alt" || token === "option") {
      alt = true;
      continue;
    }
    if (token === "shift") {
      shift = true;
      continue;
    }

    key = token;
  }

  if (!key) return null;

  // Normalize a few common names
  if (key === "esc") key = "escape";
  if (key === "space") key = "space";

  return { key, meta, ctrl, alt, shift };
}

function eventToCombo(event: KeyboardEvent): HotkeyCombo {
  return {
    key: normalizeKey(event.key),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

function svgIcon(name: string): string {
  // Minimal inline icon set (lucide-like). Add more mappings as needed.
  switch (name) {
    case "providers":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-warehouse-icon lucide-warehouse"><path d="M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11"/><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z"/><path d="M6 13h12"/><path d="M6 17h12"/></svg>`;
    case "models_boxes":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-boxes-icon lucide-boxes"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>`;
    case "search":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-package-search-icon lucide-package-search"><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M20.27 17.27 22 19"/></svg>`;
    case "search_clear":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search-x-icon lucide-search-x"><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
    case "sort_clear":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-funnel-x-icon lucide-funnel-x"><path d="M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473"/><path d="m16.5 3.5 5 5"/><path d="m21.5 3.5-5 5"/></svg>`;
    case "search_reset":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-rotate-ccw-icon lucide-rotate-ccw"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
    case "clear":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-x-icon lucide-circle-x"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`;
    case "sort":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-down-icon lucide-arrow-up-down"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></svg>`;
    case "arrow_forward":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right-icon lucide-arrow-right"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;
    case "sort_arrow_upward":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-narrow-wide-icon lucide-arrow-up-narrow-wide"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`;
    case "sort_arrow_downward":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-down-wide-narrow-icon lucide-arrow-down-wide-narrow"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`;
    case "sort_calendar_asc":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-arrow-up-icon lucide-calendar-arrow-up"><path d="m14 18 4-4 4 4"/><path d="M16 2v4"/><path d="M18 22v-8"/><path d="M21 11.343V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9"/><path d="M3 10h18"/><path d="M8 2v4"/></svg>`;
    case "sort_calendar_desc":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-arrow-down-icon lucide-calendar-arrow-down"><path d="m14 18 4 4 4-4"/><path d="M16 2v4"/><path d="M18 14v8"/><path d="M21 11.354V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.343"/><path d="M3 10h18"/><path d="M8 2v4"/></svg>`;
    case "help":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-circle-question-mark-icon lucide-message-circle-question-mark"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;
    case "external_link":
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-arrow-out-up-right-icon lucide-square-arrow-out-up-right"><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>`;
    case "github_logo":
      return `<svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"></path></svg>`;
    default:
      return "";
  }
}

const paletteStyles = `
  <style>
    :host {
      --command-palette-width: 640px;
      --command-palette-top: 10vh;
      --command-palette-backdrop-filter: none;
      --command-palette-font-family: inherit;
      --command-palette-font-size: 16px;
      --command-palette-actions-height: 300px;
      --command-palette-z-index: 1000;

      font-family: var(--command-palette-font-family, inherit);
      font-size: var(--command-palette-font-size, 16px);
      color: var(--command-palette-text, rgb(60, 65, 73));
    }

    .overlay {
      position: fixed;
      inset: 0;
      display: none;
      z-index: var(--command-palette-z-index);
      background: var(--command-palette-backdrop, rgba(255, 255, 255, 0.5));
      -webkit-backdrop-filter: var(--command-palette-backdrop-filter);
      backdrop-filter: var(--command-palette-backdrop-filter);
    }

    .overlay[data-visible="true"] {
      display: block;
    }

    .modal {
      position: absolute;
      top: var(--command-palette-top);
      left: 50%;
      transform: translateX(-50%);
      width: min(calc(100vw - 2rem), var(--command-palette-width));
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      background: var(--command-palette-modal-bg, rgba(255, 255, 255, 0.95));
      color: var(--command-palette-text, rgb(60, 65, 73));
      box-shadow: var(
        --command-palette-shadow,
        rgb(0 0 0 / 50%) 0px 16px 70px
      );
      border-radius: 12px;
      overflow: hidden;
      border: var(--command-palette-border, 1px solid rgba(0, 0, 0, 0.08));
      font-family: inherit;
    }

    .header {
      flex-shrink: 0;
      border-bottom: var(--command-palette-border);
    }

    .breadcrumbs {
      display: flex;
      gap: 0.5rem;
      padding: 0.75rem 1rem 0;
      flex-wrap: wrap;
    }

    .breadcrumb {
      border: 0;
      background: var(--command-palette-secondary-bg);
      color: var(--command-palette-secondary-text);
      border-radius: 999px;
      padding: 0.25rem 0.6rem;
      font-size: 0.8125rem;
      cursor: pointer;
      font-family: inherit;
    }

    .breadcrumb:focus,
    .breadcrumb:hover,
    .breadcrumb[data-active="true"] {
      outline: 2px solid var(--command-palette-accent-color);
      outline-offset: 2px;
    }

    .inputWrap {
      display: flex;
      border-top: 0;
    }

    .search {
      width: 100%;
      padding: 0.95rem 1rem;
      border: 0;
      background: transparent;
      outline: none;
      font-size: 1.05rem;
      font-family: inherit;
      color: var(--command-palette-text, rgb(60, 65, 73));
      caret-color: var(--command-palette-accent-color, #FD9527);
    }

    .search::placeholder {
      color: var(--command-palette-placeholder, #8e8e8e);
    }

    .body {
      flex: 1 1 auto;
      overflow: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--command-palette-scrollbar-thumb, rgba(0, 0, 0, 0.25))
        var(--command-palette-scrollbar-track, transparent);
    }

    .body::-webkit-scrollbar {
      width: 10px;
    }

    .body::-webkit-scrollbar-track {
      background: var(--command-palette-scrollbar-track, transparent);
    }

    .body::-webkit-scrollbar-thumb {
      background-color: var(--command-palette-scrollbar-thumb, rgba(0, 0, 0, 0.25));
      border-radius: 999px;
      border: 2px solid var(--command-palette-scrollbar-track, transparent);
    }

    .body::-webkit-scrollbar-thumb:hover {
      background-color: var(
        --command-palette-scrollbar-thumb-hover,
        rgba(0, 0, 0, 0.35)
      );
    }

    .groupHeader {
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--command-palette-group-text, rgb(144, 149, 157));
    }

    .row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      cursor: pointer;
      border-left: 2px solid transparent;
      user-select: none;
    }

    .row:hover {
      background: var(--command-palette-selected-bg, rgb(248, 249, 251));
      color: var(--command-palette-selected-text, currentColor);
    }

    .row:hover .icon {
      color: currentColor;
    }

    .row[data-selected="true"] {
      background: var(--command-palette-selected-bg, rgb(248, 249, 251));
      color: var(--command-palette-selected-text, currentColor);
      border-left-color: var(--command-palette-accent-color, #FD9527);
    }

    .icon {
      display: grid;
      place-items: center;
      width: 20px;
      height: 20px;
      color: var(--command-palette-secondary-text, rgb(107, 111, 118));
      flex: 0 0 auto;
    }

    .icon img {
      width: 18px;
      height: 18px;
      object-fit: contain;
      display: block;
      filter: var(--command-palette-icon-filter, none);
      opacity: var(--command-palette-icon-opacity, 1);
    }

    .row[data-selected="true"] .icon {
      color: currentColor;
    }

    .title {
      flex: 1 1 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.95rem;
    }

    .hotkey {
      display: flex;
      gap: 0.25rem;
      color: var(--command-palette-secondary-text, rgb(107, 111, 118));
      font-size: 0.75rem;
      flex: 0 0 auto;
    }

    .hotkey kbd {
      background: var(--command-palette-secondary-bg, rgb(239, 241, 244));
      border-radius: 6px;
      padding: 0.12rem 0.3rem;
      font-family: inherit;
    }

    .chevron {
      color: var(--command-palette-secondary-text, rgb(107, 111, 118));
      flex: 0 0 auto;
      display: flex;
      align-items: center;
    }

    .footer {
      flex-shrink: 0;
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
      padding: 0.6rem 1rem;
      border-top: var(--command-palette-border);
      background: var(--command-palette-footer-bg, rgba(242, 242, 242, 0.4));
      color: var(--command-palette-secondary-text, rgb(107, 111, 118));
      font-size: 0.75rem;
    }

    .footer kbd {
      background: var(--command-palette-secondary-bg, rgb(239, 241, 244));
      border-radius: 4px;
      padding: 0.15rem 0.35rem;
      font-family: inherit;
      font-size: 0.7rem;
      border: 1px solid var(--command-palette-accent-color, #FD9527);
    }

    @media (max-width: 45rem) {
      .footer {
        display: none;
      }
    }
  </style>
`;

const paletteHtml = `
  <div class="overlay" part="overlay" data-visible="false" aria-hidden="true">
    <div class="modal" part="modal" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="header" part="header">
        <div class="breadcrumbs" part="breadcrumbs"></div>
        <div class="inputWrap" part="input-wrapper">
          <input class="search" part="input" type="text" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div class="body" part="actions-list"></div>
      <div class="footer" part="footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
        <span><kbd>enter</kbd> to select</span>
        <span><kbd>esc</kbd> to close</span>
        <span><kbd>backspace</kbd> to parent</span>
      </div>
    </div>
  </div>
`;

const template = document.createElement("template");
template.innerHTML = paletteStyles + paletteHtml;

export class CommandPaletteElement extends HTMLElement {
  private _root = this.attachShadow({ mode: "open" });
  private _overlay!: HTMLDivElement;
  private _breadcrumbsEl!: HTMLDivElement;
  private _input!: HTMLInputElement;
  private _list!: HTMLDivElement;

  private _data: CommandPaletteAction[] = [];
  private _flat: CommandPaletteAction[] = [];
  private _byId = new Map<string, CommandPaletteAction>();
  private _hotkeys = new Map<string, CommandPaletteAction>();
  private _searchText = new Map<string, string>();

  private _visible = false;
  private _search = "";
  private _currentRoot?: string;
  private _selectedIndex = -1;
  private _matches: CommandPaletteAction[] = [];

  private _placeholder = "Type a command or search...";

  constructor() {
    super();
    this._root.appendChild(template.content.cloneNode(true));
  }

  connectedCallback() {
    this._overlay = this._root.querySelector(".overlay") as HTMLDivElement;
    this._breadcrumbsEl = this._root.querySelector(
      ".breadcrumbs",
    ) as HTMLDivElement;
    this._input = this._root.querySelector(".search") as HTMLInputElement;
    this._list = this._root.querySelector(".body") as HTMLDivElement;

    this._input.placeholder = this._placeholder;

    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });

    this._input.addEventListener("input", () => {
      this._search = this._input.value;
      this._recomputeMatches();
      this._render();
      this.dispatchEvent(
        new CustomEvent<ChangeDetail>("change", {
          detail: { search: this._search, actions: this._matches },
          bubbles: true,
          composed: true,
        }),
      );
    });

    this._input.addEventListener("keydown", (e) => {
      // Prevent browser search shortcuts when typing inside.
      if (this._isOpenHotkey(e)) e.preventDefault();
    });

    window.addEventListener("keydown", this._onKeyDown, { capture: true });

    this._recomputeMatches();
    this._render();
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKeyDown, {
      capture: true,
    } as any);
  }

  get data(): CommandPaletteAction[] {
    return this._data;
  }

  set data(value: CommandPaletteAction[]) {
    this._data = Array.isArray(value) ? value : [];
    this._indexData();
    this._recomputeMatches();
    this._render();
  }

  get placeholder(): string {
    return this._placeholder;
  }

  set placeholder(value: string) {
    this._placeholder = value || "";
    if (this._input) this._input.placeholder = this._placeholder;
  }

  open(options: OpenOptions = {}) {
    this._visible = true;
    this._currentRoot = options.parent;
    this._input.value = "";
    this._search = "";
    this._recomputeMatches();
    this._render();
    queueMicrotask(() => this._input.focus());
  }

  close() {
    this._visible = false;
    this._render();
  }

  private _isOpenHotkey(e: KeyboardEvent): boolean {
    const key = normalizeKey(e.key);
    if (key !== "k") return false;
    if (e.metaKey && !e.ctrlKey) return true;
    if (e.ctrlKey && !e.metaKey) return true;
    return false;
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (this._visible) {
      // Palette-specific navigation
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "Tab") {
        e.preventDefault();
        this._selectedIndex = clampIndex(
          this._selectedIndex + 1,
          this._matches.length,
        );
        this._renderSelectionOnly();
        return;
      }

      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        this._selectedIndex = clampIndex(
          this._selectedIndex - 1,
          this._matches.length,
        );
        this._renderSelectionOnly();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        this._activateSelected();
        return;
      }

      if (e.key === "Backspace" && this._search.length === 0) {
        if (this._currentRoot) {
          e.preventDefault();
          this._goBack();
          return;
        }
      }

      return;
    }

    // Global open hotkey
    if (this._isOpenHotkey(e)) {
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      this.open();
      return;
    }

    // Optional: action hotkeys when palette is closed
    if (isEditableTarget(e.target)) return;
    const comboKey = normalizeCombo(eventToCombo(e));
    const action = this._hotkeys.get(comboKey);
    if (!action) return;

    e.preventDefault();
    this._runAction(action);
  };

  private _indexData() {
    // Build a flat array and parent mapping, supporting both flat and tree structures.
    this._byId.clear();
    this._hotkeys.clear();
    this._searchText.clear();

    const flatten = (
      items: CommandPaletteAction[],
      parent?: string,
    ): CommandPaletteAction[] => {
      const children: CommandPaletteAction[] = [];
      const mapped = items.map((item) => {
        const m: CommandPaletteAction = {
          ...item,
          parent: item.parent || parent,
        };
        const hasObjectChildren =
          Array.isArray(m.children) &&
          m.children.some((c) => typeof c !== "string");

        if (
          Array.isArray(m.children) &&
          m.children.length &&
          hasObjectChildren
        ) {
          const objectChildren = m.children.filter(
            (c): c is CommandPaletteAction => typeof c !== "string",
          );
          children.push(...objectChildren);
          m.children = objectChildren.map((c) => c.id);
          objectChildren.forEach((c) => {
            c.parent = c.parent || m.id;
          });
        } else if (Array.isArray(m.children)) {
          // leave string children as-is
        } else {
          m.children = [];
        }

        return m;
      });

      return mapped.concat(children.length ? flatten(children, parent) : []);
    };

    this._flat = flatten(this._data);

    for (const action of this._flat) {
      this._byId.set(action.id, action);

      this._searchText.set(
        action.id,
        `${action.title} ${action.section ?? ""} ${action.keywords ?? ""} ${action.id}`
          .toLowerCase()
          .trim(),
      );

      if (action.hotkey) {
        const combos = action.hotkey
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        for (const combo of combos) {
          const parsed = parseHotkeyCombo(combo);
          if (!parsed) continue;
          this._hotkeys.set(normalizeCombo(parsed), action);
        }
      }
    }
  }

  private get _breadcrumbs(): Array<{ id?: string; label: string }> {
    const crumbs: Array<{ id?: string; label: string }> = [
      { id: undefined, label: "models.dev" },
    ];
    let current = this._currentRoot
      ? this._byId.get(this._currentRoot)
      : undefined;
    const chain: CommandPaletteAction[] = [];

    while (current) {
      chain.push(current);
      current = current.parent ? this._byId.get(current.parent) : undefined;
    }

    chain.reverse();
    for (const item of chain) {
      crumbs.push({ id: item.id, label: item.title });
    }

    return crumbs;
  }

  private _goBack() {
    if (!this._currentRoot) return;
    const current = this._byId.get(this._currentRoot);
    this._currentRoot = current?.parent;
    this._recomputeMatches();
    this._render();
    queueMicrotask(() => this._input.focus());
  }

  private _recomputeMatches() {
    const term = this._search.trim();
    const search = term.toLowerCase();

    // Always filter within the currently-visible menu.
    // This keeps submenu-only actions (like Sort children) hidden unless you're inside that submenu.
    const candidates = this._flat.filter(
      (a) => (a.parent || undefined) === this._currentRoot,
    );

    if (!search) {
      this._matches = candidates;
      this._selectedIndex = candidates.length ? 0 : -1;
      return;
    }

    const scored: Array<{ action: CommandPaletteAction; score: number }> = [];
    for (const action of candidates) {
      const haystack = this._searchText.get(action.id) ?? "";
      const score = wordBasedScore(haystack, search);
      if (score === null) continue;
      scored.push({ action, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const includeSearchByModelTerm = !this._currentRoot;
    if (includeSearchByModelTerm) {
      const searchByModelTerm: CommandPaletteAction = {
        id: `search-model-term:${search}`,
        title: `Search models for “${term}”`,
        section: "Actions",
        icon: "search",
        keywords: "search models model term filter",
        handler: () => {
          const searchInput = document.getElementById(
            "search",
          ) as HTMLInputElement | null;
          if (!searchInput) return;
          searchInput.value = term;
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        },
      };

      this._matches = [searchByModelTerm, ...scored.map((s) => s.action)];
    } else {
      this._matches = scored.map((s) => s.action);
    }
    this._selectedIndex = this._matches.length ? 0 : -1;
  }

  private _render() {
    this._overlay.dataset.visible = this._visible ? "true" : "false";
    this._overlay.setAttribute("aria-hidden", this._visible ? "false" : "true");

    if (!this._visible) {
      return;
    }

    // Update placeholder based on current context
    if (this._currentRoot) {
      const path = this._breadcrumbs
        .slice(1) // Skip "Home"
        .map((crumb) => crumb.label.toLowerCase())
        .join(" > ");
      if (path) {
        this._input.placeholder = `Search ${path}`;
      } else {
        this._input.placeholder = this._placeholder;
      }
    } else {
      this._input.placeholder = this._placeholder;
    }

    // Breadcrumbs
    this._breadcrumbsEl.textContent = "";
    const lastIndex = this._breadcrumbs.length - 1;
    for (let i = 0; i < this._breadcrumbs.length; i++) {
      const crumb = this._breadcrumbs[i];
      const btn = document.createElement("button");
      btn.className = "breadcrumb";
      btn.type = "button";
      btn.textContent = crumb.label;
      btn.dataset.active = i === lastIndex ? "true" : "false";
      btn.addEventListener("click", () => {
        this._currentRoot = crumb.id;
        this._input.value = "";
        this._search = "";
        this._recomputeMatches();
        this._render();
        queueMicrotask(() => this._input.focus());
      });
      this._breadcrumbsEl.appendChild(btn);
    }

    // List
    this._list.textContent = "";

    // Group by section
    const groups = new Map<string, CommandPaletteAction[]>();
    const sectionOrder: string[] = [];
    for (const action of this._matches) {
      const section = action.section || "";
      if (!groups.has(section)) {
        groups.set(section, []);
        sectionOrder.push(section);
      }
      groups.get(section)!.push(action);
    }

    let rowIndex = 0;
    for (const section of sectionOrder) {
      if (section) {
        const header = document.createElement("div");
        header.className = "groupHeader";
        header.textContent = section;
        this._list.appendChild(header);
      }

      const items = groups.get(section)!;
      for (const action of items) {
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.index = String(rowIndex);
        row.dataset.selected =
          rowIndex === this._selectedIndex ? "true" : "false";

        const thisRowIndex = rowIndex;

        // Icon
        const iconWrap = document.createElement("span");
        iconWrap.className = "icon";
        if (action.iconUrl) {
          const img = document.createElement("img");
          img.src = action.iconUrl;
          img.alt = action.section ? `${action.section} logo` : "";
          img.loading = "lazy";
          img.decoding = "async";
          iconWrap.appendChild(img);
        } else if (action.icon) {
          // Check if icon is an SVG string
          if (action.icon.includes("<svg")) {
            iconWrap.innerHTML = action.icon;
          } else {
            // Otherwise treat as icon name
            const svg = svgIcon(action.icon);
            if (svg) iconWrap.innerHTML = svg;
          }
        }

        // Title
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = action.title;

        // Hotkey
        const hotkey = document.createElement("span");
        hotkey.className = "hotkey";
        if (action.hotkey) {
          const parts = action.hotkey
            .split(",")[0]
            .split("+")
            .map((p) => p.trim())
            .filter(Boolean);
          for (const part of parts) {
            const kbd = document.createElement("kbd");
            kbd.textContent = part;
            hotkey.appendChild(kbd);
          }
        }

        // Chevron for submenus or external link indicator
        const chevron = document.createElement("span");
        chevron.className = "chevron";
        const hasChildren =
          Array.isArray(action.children) && action.children.length > 0;
        const isExternal = action.external === true;
        if (hasChildren) {
          chevron.innerHTML = svgIcon("arrow_forward");
        } else if (isExternal) {
          chevron.innerHTML = svgIcon("external_link");
        }

        row.appendChild(iconWrap);
        row.appendChild(title);
        if (hotkey.childNodes.length) row.appendChild(hotkey);
        if (hasChildren || isExternal) row.appendChild(chevron);

        row.addEventListener("mousemove", () => {
          this._selectedIndex = thisRowIndex;
          this._renderSelectionOnly();
        });

        row.addEventListener("click", () => {
          this._selectedIndex = thisRowIndex;
          this._activateSelected();
        });

        this._list.appendChild(row);
        rowIndex += 1;
      }
    }

    this._scrollSelectedIntoView();
  }

  private _renderSelectionOnly() {
    if (!this._visible) return;
    const rows = this._list.querySelectorAll(".row");
    rows.forEach((row) => {
      const idx = Number((row as HTMLElement).dataset.index);
      (row as HTMLElement).dataset.selected =
        idx === this._selectedIndex ? "true" : "false";
    });
    this._scrollSelectedIntoView();
  }

  private _scrollSelectedIntoView() {
    if (this._selectedIndex < 0) return;

    // If first item is selected, scroll to top so provider header is visible
    if (this._selectedIndex === 0) {
      this._list.scrollTop = 0;
      return;
    }

    const selectedRow = this._list.querySelector(
      `.row[data-index="${this._selectedIndex}"]`,
    ) as HTMLElement | null;
    if (!selectedRow) return;
    selectedRow.scrollIntoView({ block: "nearest" });
  }

  private _activateSelected() {
    if (this._selectedIndex < 0) return;
    const action = this._matches[this._selectedIndex];
    if (!action) return;
    this._runAction(action);
  }

  private _runAction(action: CommandPaletteAction) {
    const hasChildren =
      Array.isArray(action.children) && action.children.length > 0;
    if (hasChildren) {
      this.open({ parent: action.id });
      return;
    }

    const result = action.handler?.();

    this.dispatchEvent(
      new CustomEvent<SelectedDetail>("selected", {
        detail: { search: this._search, action },
        bubbles: true,
        composed: true,
      }),
    );

    if (
      result &&
      typeof result === "object" &&
      "keepOpen" in result &&
      result.keepOpen
    ) {
      this.open({ parent: this._currentRoot });
      return;
    }

    this.close();
  }
}

if (!customElements.get("command-palette")) {
  customElements.define("command-palette", CommandPaletteElement);
}
