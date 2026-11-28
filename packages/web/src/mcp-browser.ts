import {
  mcpDisplayName,
  mcpRegistries,
  mcpServerHref,
  mcpServerName,
  mcpTransports,
  safeHttpUrl,
  type McpCatalog,
  type McpServerRecord,
} from "./mcp-shared.js";

const PAGE_SIZE = 100;

let catalog: McpCatalog | undefined;
let catalogError: string | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

type SortKey = "name" | "version" | "updated";
type SortDirection = "asc" | "desc";

export function onMcpCatalog(listener: () => void) {
  listeners.add(listener);
  if (catalog || catalogError) listener();
}

export function loadMcpCatalog() {
  if (catalog || catalogError) return Promise.resolve();
  loading ??= fetch("/mcp.json")
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<McpCatalog>;
    })
    .then((parsed) => {
      if (!parsed || !Array.isArray(parsed.servers)) {
        throw new Error("Invalid MCP catalog");
      }
      catalog = parsed;
    })
    .catch((error: unknown) => {
      catalogError = error instanceof Error ? error.message : "Failed to load";
    })
    .finally(() => {
      for (const listener of listeners) listener();
    });
  return loading;
}

export function installMcpBrowser() {
  if (document.querySelector("[data-mcp-directory], [data-mcp-detail]")) {
    void loadMcpCatalog();
  }
  const directory = document.querySelector<HTMLElement>("[data-mcp-directory]");
  if (directory) installDirectory(directory);
  const detail = document.querySelector<HTMLElement>("[data-mcp-detail]");
  if (detail) installDetail(detail);
}

function installDirectory(root: HTMLElement) {
  const filter = root.querySelector<HTMLInputElement>("#mcp-filter");
  const tbody = root.querySelector<HTMLTableSectionElement>("#mcp-rows");
  const pager = root.querySelector<HTMLElement>("#mcp-pager");
  const count = root.querySelector<HTMLElement>("#mcp-count");
  const synced = root.querySelector<HTMLElement>("#mcp-synced");
  if (!filter || !tbody || !pager || !count) return;

  const params = new URLSearchParams(window.location.search);
  filter.value = params.get("q") ?? "";
  let page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  let sortKey: SortKey = "name";
  let sortDirection: SortDirection = "asc";
  let filterTimer = 0;

  const draw = () => {
    if (catalogError) {
      count.textContent = "—";
      tbody.replaceChildren(messageRow(catalogError));
      pager.replaceChildren();
      return;
    }
    if (!catalog) {
      count.textContent = "…";
      tbody.replaceChildren(messageRow("Loading MCP servers…"));
      return;
    }

    if (synced) {
      const when = catalog.syncedAt?.slice(0, 10);
      synced.textContent = when
        ? `Snapshot of the official MCP registry (${when}). Refresh with bun run mcp:sync.`
        : "Snapshot of the official MCP registry. Refresh with bun run mcp:sync.";
    }

    const query = normalize(filter.value);
    const terms = query.split(/\s+/).filter(Boolean);
    let rows = catalog.servers;
    if (terms.length > 0) {
      rows = rows.filter((server) => scoreServer(server, terms) > 0);
    }
    rows = rows.slice().sort((a, b) => compareServers(a, b, sortKey, sortDirection));

    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = rows.slice(start, start + PAGE_SIZE);
    count.textContent = formatNumber(rows.length);

    const fragment = document.createDocumentFragment();
    if (visible.length === 0) {
      fragment.append(messageRow("No servers match this filter."));
    } else {
      for (const server of visible) fragment.append(serverRow(server));
    }
    tbody.replaceChildren(fragment);
    renderPager(pager, page, pages, rows.length, start, visible.length, (next) => {
      page = next;
      writeDirectoryUrl(filter.value, page);
      draw();
      root.scrollIntoView({ block: "start" });
    });
  };

  filter.addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      page = 1;
      writeDirectoryUrl(filter.value, page);
      draw();
    }, 120);
  });

  for (const header of root.querySelectorAll<HTMLTableCellElement>("th[data-mcp-sort]")) {
    header.querySelector("button")?.addEventListener("click", () => {
      const key = header.dataset.mcpSort as SortKey;
      if (sortKey === key) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDirection = key === "updated" ? "desc" : "asc";
      }
      for (const sortable of root.querySelectorAll<HTMLTableCellElement>("th[data-mcp-sort]")) {
        sortable.removeAttribute("aria-sort");
        const indicator = sortable.querySelector(".sort-indicator");
        if (indicator) indicator.textContent = "";
      }
      header.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending");
      const indicator = header.querySelector(".sort-indicator");
      if (indicator) indicator.textContent = sortDirection === "asc" ? "↑" : "↓";
      page = 1;
      writeDirectoryUrl(filter.value, page);
      draw();
    });
  }

  onMcpCatalog(draw);
}

function installDetail(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>("#mcp-detail-status");
  const mount = root.querySelector<HTMLElement>("#mcp-detail");
  if (!status || !mount) return;

  const render = () => {
    if (catalogError) {
      status.hidden = false;
      status.textContent = catalogError;
      return;
    }
    if (!catalog) return;

    const name = mcpServerName(window.location.pathname);
    const server = name
      ? catalog.servers.find((item) => item.name === name)
      : undefined;
    status.hidden = true;
    if (!server) {
      status.hidden = false;
      status.textContent = "This MCP server is not in the catalog.";
      mount.replaceChildren();
      return;
    }
    document.title = `${mcpDisplayName(server)} | Models.dev`;
    mount.replaceChildren(detailView(server));
  };

  onMcpCatalog(render);
}

function serverRow(server: McpServerRecord) {
  const row = document.createElement("tr");
  const name = document.createElement("th");
  name.scope = "row";
  const link = document.createElement("a");
  link.className = "primary-link";
  link.href = mcpServerHref(server.name);
  link.textContent = mcpDisplayName(server);
  name.append(link);
  const id = document.createElement("span");
  id.className = "subtle mono";
  id.textContent = server.name;
  name.append(id);
  row.append(name);

  const description = document.createElement("td");
  description.className = "mcp-description";
  description.textContent = server.description || "—";
  row.append(description);

  row.append(cell(server.version || "—"));
  row.append(cell(mcpTransports(server).join(", ") || "—"));
  row.append(cell(mcpRegistries(server).join(", ") || "—"));
  const updated = document.createElement("td");
  updated.textContent = server.updatedAt?.slice(0, 10) || "—";
  if (server.status === "deprecated") updated.textContent += " · deprecated";
  row.append(updated);
  return row;
}

function detailView(server: McpServerRecord) {
  const fragment = document.createDocumentFragment();
  const header = document.createElement("section");
  header.className = "detail-header";

  const crumbs = document.createElement("div");
  crumbs.className = "breadcrumbs";
  const back = document.createElement("a");
  back.href = "/mcp";
  back.textContent = "MCP";
  crumbs.append(back);
  header.append(crumbs);

  const title = document.createElement("h2");
  title.textContent = mcpDisplayName(server);
  header.append(title);

  if (server.description) {
    const description = document.createElement("p");
    description.textContent = server.description;
    header.append(description);
  }
  if (server.statusMessage) {
    const note = document.createElement("p");
    note.textContent = server.statusMessage;
    header.append(note);
  }

  const code = document.createElement("div");
  code.className = "code-line";
  const name = document.createElement("code");
  name.textContent = server.name;
  code.append(name, copyButton(server.name));
  header.append(code);
  fragment.append(header);

  const facts = document.createElement("dl");
  facts.className = "fact-grid";
  appendFact(facts, "Version", server.version || "—");
  appendFact(facts, "Status", server.status ?? "active");
  appendFact(facts, "Published", server.publishedAt?.slice(0, 10) || "—");
  appendFact(facts, "Updated", server.updatedAt?.slice(0, 10) || "—");
  appendLinkFact(facts, "Website", safeHttpUrl(server.website), "Website");
  appendLinkFact(facts, "Repository", safeHttpUrl(server.repository), "Repository");
  const registryUrl = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version || "latest")}`;
  appendLinkFact(facts, "Registry", registryUrl, "Registry entry");
  fragment.append(facts);

  const packages = server.packages ?? [];
  if (packages.length > 0) {
    fragment.append(
      tableSection(
        "Packages",
        packages.length,
        ["Registry", "Identifier", "Version", "Runtime", "Transport"],
        packages.map((item) => [
          item.registryType,
          item.identifier,
          item.version || "—",
          item.runtimeHint || "—",
          item.transport || "—",
        ]),
      ),
    );
  }

  const remotes = server.remotes ?? [];
  if (remotes.length > 0) {
    fragment.append(
      tableSection(
        "Remotes",
        remotes.length,
        ["Transport", "URL"],
        remotes.map((remote) => [remote.type, safeHttpUrl(remote.url) || remote.url]),
        [false, true],
      ),
    );
  }

  return fragment;
}

function tableSection(
  title: string,
  count: number,
  headings: string[],
  rows: string[][],
  links: boolean[] = [],
) {
  const section = document.createElement("section");
  section.className = "table-section";
  const heading = document.createElement("div");
  heading.className = "section-heading";
  const label = document.createElement("h3");
  label.textContent = title;
  const total = document.createElement("span");
  total.textContent = formatNumber(count);
  heading.append(label, total);
  section.append(heading);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of headings) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = text;
    headRow.append(cell);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const values of rows) {
    const row = document.createElement("tr");
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      const href = links[index] ? safeHttpUrl(value) : undefined;
      if (href) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = value;
        cell.append(anchor);
      } else if (index === 1 && title === "Packages") {
        cell.className = "mono";
        cell.textContent = value;
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    });
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function appendFact(list: HTMLDListElement, label: string, value: string) {
  const item = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  item.append(term, detail);
  list.append(item);
}

function appendLinkFact(
  list: HTMLDListElement,
  label: string,
  href: string | undefined,
  text: string,
) {
  const item = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  if (!href) {
    detail.textContent = "—";
  } else {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = text;
    detail.append(anchor);
  }
  item.append(term, detail);
  list.append(item);
}

function copyButton(value: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.dataset.copyValue = value;
  button.setAttribute("aria-label", `Copy ${value}`);
  button.title = `Copy ${value}`;
  button.innerHTML = `<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;"><polyline points="20,6 9,17 4,12"></polyline></svg>`;
  return button;
}

function renderPager(
  pager: HTMLElement,
  page: number,
  pages: number,
  total: number,
  start: number,
  visible: number,
  go: (page: number) => void,
) {
  pager.replaceChildren();
  const summary = document.createElement("p");
  summary.textContent =
    total === 0
      ? "0 servers"
      : `${formatNumber(start + 1)}–${formatNumber(start + visible)} of ${formatNumber(total)}`;
  const previous = pagerButton("Previous", page <= 1, () => go(page - 1));
  const next = pagerButton("Next", page >= pages, () => go(page + 1));
  const controls = document.createElement("div");
  controls.className = "mcp-pager-controls";
  controls.append(previous, next);
  pager.append(summary, controls);
}

function pagerButton(label: string, disabled: boolean, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function messageRow(text: string) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.textContent = text;
  row.append(cell);
  return row;
}

function cell(text: string) {
  const node = document.createElement("td");
  node.textContent = text;
  return node;
}

function writeDirectoryUrl(query: string, page: number) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  const next = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, "", next);
}

function compareServers(
  a: McpServerRecord,
  b: McpServerRecord,
  key: SortKey,
  direction: SortDirection,
) {
  const left = sortValue(a, key);
  const right = sortValue(b, key);
  const comparison = left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return direction === "asc" ? comparison : -comparison;
}

function sortValue(server: McpServerRecord, key: SortKey) {
  if (key === "version") return server.version;
  if (key === "updated") return server.updatedAt ?? "";
  return mcpDisplayName(server);
}

function scoreServer(server: McpServerRecord, terms: string[]) {
  const fields = [
    server.title ?? "",
    server.name,
    server.description,
    ...(server.packages ?? []).map((item) => item.identifier),
  ];
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      best = Math.max(best, scoreField(normalize(field), term));
    }
    if (best <= 0) return 0;
    score += best;
  }
  const title = normalize(mcpDisplayName(server));
  const id = normalize(server.name);
  const query = terms.join(" ");
  if (title === query || id === query) score += 120;
  else if (title.startsWith(query)) score += 44;
  return score;
}

function scoreField(field: string, term: string) {
  if (!field) return 0;
  if (field === term) return 120;
  if (field.startsWith(term)) return 100;
  if (field.split(" ").some((word) => word.startsWith(term))) return 82;
  const index = field.indexOf(term);
  if (index !== -1) return 64 - Math.min(index, 24);
  return 0;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}
