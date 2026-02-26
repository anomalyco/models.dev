import type { Row } from "./data.js";

export type ColumnDef = {
  id: string;
  label: string;
  subLabel?: string;
  group: "identity" | "capabilities" | "modalities" | "cost" | "limits" | "metadata";
  dataType: "text" | "number" | "boolean" | "modalities" | "cost";
  sortable: boolean;
  getValue: (row: Row) => string | number | boolean | undefined;
  renderCell?: (row: Row) => HTMLElement | string;
};

export const ALL_COLUMNS: ColumnDef[] = [
  {
    id: "provider", label: "Provider", group: "identity", dataType: "text", sortable: true,
    getValue: (r) => r.providerName,
    renderCell: (r) => {
      const div = document.createElement("div");
      div.className = "provider-cell";
      const img = document.createElement("img");
      img.src = `/logos/${r.providerId}.svg`;
      img.alt = r.providerName;
      img.width = 16;
      img.height = 16;
      img.className = "provider-logo";
      img.onerror = () => { img.src = "/logos/default.svg"; img.onerror = null; };
      const span = document.createElement("span");
      span.textContent = r.providerName;
      div.append(img, span);
      return div;
    },
  },
  {
    id: "model", label: "Model", group: "identity", dataType: "text", sortable: true,
    getValue: (r) => r.name,
  },
  {
    id: "family", label: "Family", group: "identity", dataType: "text", sortable: true,
    getValue: (r) => r.family ?? "-",
  },
  {
    id: "provider-id", label: "Provider ID", group: "identity", dataType: "text", sortable: true,
    getValue: (r) => r.providerId,
  },
  {
    id: "model-id", label: "Model ID", group: "identity", dataType: "text", sortable: true,
    getValue: (r) => r.modelId,
    renderCell: (r) => makeModelIdCell(r.modelId),
  },
  {
    id: "tool-call", label: "Tool Call", group: "capabilities", dataType: "boolean", sortable: true,
    getValue: (r) => r.tool_call,
  },
  {
    id: "reasoning", label: "Reasoning", group: "capabilities", dataType: "boolean", sortable: true,
    getValue: (r) => r.reasoning,
  },
  {
    id: "input-modalities", label: "Input", group: "modalities", dataType: "modalities", sortable: true,
    getValue: (r) => r.modalities.input.length,
    renderCell: (r) => makeModalitiesCell(r.modalities.input),
  },
  {
    id: "output-modalities", label: "Output", group: "modalities", dataType: "modalities", sortable: true,
    getValue: (r) => r.modalities.output.length,
    renderCell: (r) => makeModalitiesCell(r.modalities.output),
  },
  {
    id: "input-cost", label: "Input Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.input,
  },
  {
    id: "output-cost", label: "Output Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.output,
  },
  {
    id: "reasoning-cost", label: "Reasoning Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.reasoning,
  },
  {
    id: "cache-read-cost", label: "Cache Read Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.cache_read,
  },
  {
    id: "cache-write-cost", label: "Cache Write Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.cache_write,
  },
  {
    id: "audio-input-cost", label: "Audio Input Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.input_audio,
  },
  {
    id: "audio-output-cost", label: "Audio Output Cost", subLabel: "per 1M tokens", group: "cost", dataType: "cost", sortable: true,
    getValue: (r) => r.cost?.output_audio,
  },
  {
    id: "context-limit", label: "Context Limit", group: "limits", dataType: "number", sortable: true,
    getValue: (r) => r.limit.context,
  },
  {
    id: "input-limit", label: "Input Limit", group: "limits", dataType: "number", sortable: true,
    getValue: (r) => r.limit.input,
  },
  {
    id: "output-limit", label: "Output Limit", group: "limits", dataType: "number", sortable: true,
    getValue: (r) => r.limit.output,
  },
  {
    id: "structured-output", label: "Structured Output", group: "capabilities", dataType: "boolean", sortable: true,
    getValue: (r) => r.structured_output,
  },
  {
    id: "temperature", label: "Temperature", group: "capabilities", dataType: "boolean", sortable: true,
    getValue: (r) => r.temperature,
  },
  {
    id: "weights", label: "Weights", group: "metadata", dataType: "text", sortable: true,
    getValue: (r) => r.open_weights ? "Open" : "Closed",
  },
  {
    id: "knowledge", label: "Knowledge", group: "metadata", dataType: "text", sortable: true,
    getValue: (r) => r.knowledge ? r.knowledge.substring(0, 7) : "-",
  },
  {
    id: "release-date", label: "Release Date", group: "metadata", dataType: "text", sortable: true,
    getValue: (r) => r.release_date ?? "-",
  },
  {
    id: "last-updated", label: "Last Updated", group: "metadata", dataType: "text", sortable: true,
    getValue: (r) => r.last_updated ?? "-",
  },
];

export const ALL_COLUMN_IDS = ALL_COLUMNS.map((c) => c.id);

export const DEFAULT_COLUMN_IDS = [
  "provider", "model", "provider-id", "model-id",
  "input-cost", "output-cost", "context-limit",
];

const COLUMN_MAP = new Map(ALL_COLUMNS.map((column) => [column.id, column]));

export function getColumn(id: string): ColumnDef | undefined {
  return COLUMN_MAP.get(id);
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

function makeModelIdCell(modelId: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "model-id-cell";
  const span = document.createElement("span");
  span.className = "model-id-text";
  span.textContent = modelId;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.setAttribute("aria-label", `Copy model ID ${modelId}`);

  // Copy icon
  const NS = "http://www.w3.org/2000/svg";
  const copyIcon = document.createElementNS(NS, "svg");
  copyIcon.classList.add("copy-icon");
  copyIcon.setAttribute("width", "14");
  copyIcon.setAttribute("height", "14");
  copyIcon.setAttribute("viewBox", "0 0 24 24");
  copyIcon.setAttribute("fill", "none");
  copyIcon.setAttribute("stroke", "currentColor");
  copyIcon.setAttribute("stroke-width", "2");
  copyIcon.setAttribute("stroke-linecap", "round");
  copyIcon.setAttribute("stroke-linejoin", "round");
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("width", "14"); rect.setAttribute("height", "14");
  rect.setAttribute("x", "8"); rect.setAttribute("y", "8");
  rect.setAttribute("rx", "2"); rect.setAttribute("ry", "2");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2");
  copyIcon.append(rect, path);

  // Check icon
  const checkIcon = document.createElementNS(NS, "svg");
  checkIcon.classList.add("check-icon");
  checkIcon.setAttribute("width", "14");
  checkIcon.setAttribute("height", "14");
  checkIcon.setAttribute("viewBox", "0 0 24 24");
  checkIcon.setAttribute("fill", "none");
  checkIcon.setAttribute("stroke", "currentColor");
  checkIcon.setAttribute("stroke-width", "2");
  checkIcon.setAttribute("stroke-linecap", "round");
  checkIcon.setAttribute("stroke-linejoin", "round");
  checkIcon.style.display = "none";
  const polyline = document.createElementNS(NS, "polyline");
  polyline.setAttribute("points", "20,6 9,17 4,12");
  checkIcon.append(polyline);

  button.append(copyIcon, checkIcon);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(modelId);
      copyIcon.style.display = "none";
      checkIcon.style.display = "block";
      setTimeout(() => {
        copyIcon.style.display = "block";
        checkIcon.style.display = "none";
      }, 1000);
    } catch {}
  });

  div.append(span, button);
  return div;
}

type SvgPathSpec = { tag: "polyline" | "line" | "rect" | "circle" | "path" | "polygon"; attrs: Record<string, string> };

const MODALITY_PATHS: Record<string, SvgPathSpec[]> = {
  text: [
    { tag: "polyline", attrs: { points: "4,7 4,4 20,4 20,7" } },
    { tag: "line", attrs: { x1: "9", y1: "20", x2: "15", y2: "20" } },
    { tag: "line", attrs: { x1: "12", y1: "4", x2: "12", y2: "20" } },
  ],
  image: [
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" } },
    { tag: "circle", attrs: { cx: "9", cy: "9", r: "2" } },
    { tag: "path", attrs: { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" } },
  ],
  audio: [
    { tag: "polygon", attrs: { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" } },
    { tag: "path", attrs: { d: "m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" } },
  ],
  video: [
    { tag: "path", attrs: { d: "m22 8-6 4 6 4V8Z" } },
    { tag: "rect", attrs: { width: "14", height: "12", x: "2", y: "6", rx: "2", ry: "2" } },
  ],
  pdf: [
    { tag: "path", attrs: { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } },
    { tag: "polyline", attrs: { points: "14,2 14,8 20,8" } },
    { tag: "line", attrs: { x1: "16", y1: "13", x2: "8", y2: "13" } },
    { tag: "line", attrs: { x1: "16", y1: "17", x2: "8", y2: "17" } },
  ],
};

function makeModalitiesCell(modalities: string[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "modalities";
  const NS = "http://www.w3.org/2000/svg";
  for (const m of modalities) {
    const paths = MODALITY_PATHS[m];
    if (!paths) continue;
    const span = document.createElement("span");
    span.className = "modality-icon";
    span.setAttribute("data-tooltip", m.charAt(0).toUpperCase() + m.slice(1));
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    for (const { tag, attrs } of paths) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    span.append(svg);
    div.append(span);
  }
  return div;
}
