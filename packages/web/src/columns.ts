import type { ColumnDef } from "@tanstack/table-core";
import type { Row } from "./data";

export type ColumnMeta = {
  dataType: "text" | "number" | "boolean" | "modalities" | "cost";
  headerLabel: string;
  headerSubLabel?: string;
};

// ── Cell helpers (safe DOM construction, no innerHTML) ────────────────────────

function makeBooleanCell(value: boolean | undefined): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value === undefined ? "-" : value ? "Yes" : "No";
  return span;
}

function makeCostCell(value: number | undefined): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value === undefined ? "-" : `$${value.toFixed(2)}`;
  return span;
}

// SVG paths for each modality — built via createElementNS so no innerHTML needed
type SvgPathSpec = {
  tag: "polyline" | "line" | "rect" | "circle" | "path" | "polygon";
  attrs: Record<string, string>;
};

const MODALITY_PATHS: Record<string, SvgPathSpec[]> = {
  text: [
    { tag: "polyline", attrs: { points: "4,7 4,4 20,4 20,7" } },
    { tag: "line", attrs: { x1: "9", y1: "20", x2: "15", y2: "20" } },
    { tag: "line", attrs: { x1: "12", y1: "4", x2: "12", y2: "20" } },
  ],
  image: [
    {
      tag: "rect",
      attrs: { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" },
    },
    { tag: "circle", attrs: { cx: "9", cy: "9", r: "2" } },
    {
      tag: "path",
      attrs: { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" },
    },
  ],
  audio: [
    {
      tag: "polygon",
      attrs: { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" },
    },
    {
      tag: "path",
      attrs: {
        d: "m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07",
      },
    },
  ],
  video: [
    { tag: "path", attrs: { d: "m22 8-6 4 6 4V8Z" } },
    {
      tag: "rect",
      attrs: { width: "14", height: "12", x: "2", y: "6", rx: "2", ry: "2" },
    },
  ],
  pdf: [
    {
      tag: "path",
      attrs: {
        d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      },
    },
    { tag: "polyline", attrs: { points: "14,2 14,8 20,8" } },
    { tag: "line", attrs: { x1: "16", y1: "13", x2: "8", y2: "13" } },
    { tag: "line", attrs: { x1: "16", y1: "17", x2: "8", y2: "17" } },
  ],
};

function buildModalityIcon(modality: string): SVGSVGElement | null {
  const paths = MODALITY_PATHS[modality];
  if (!paths) return null;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  for (const { tag, attrs } of paths) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

function makeModalitiesCell(modalities: string[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "modalities";
  for (const m of modalities) {
    const svg = buildModalityIcon(m);
    if (!svg) continue;
    const span = document.createElement("span");
    span.className = "modality-icon";
    span.setAttribute("data-tooltip", m.charAt(0).toUpperCase() + m.slice(1));
    span.append(svg);
    div.append(span);
  }
  return div;
}

function makeCopyIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("copy-icon");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("width", "14");
  rect.setAttribute("height", "14");
  rect.setAttribute("x", "8");
  rect.setAttribute("y", "8");
  rect.setAttribute("rx", "2");
  rect.setAttribute("ry", "2");
  const path = document.createElementNS(NS, "path");
  path.setAttribute(
    "d",
    "m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
  );
  svg.append(rect, path);
  return svg;
}

function makeCheckIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("check-icon");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.display = "none";
  const polyline = document.createElementNS(NS, "polyline");
  polyline.setAttribute("points", "20,6 9,17 4,12");
  svg.append(polyline);
  return svg;
}

function makeModelIdCell(modelId: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "model-id-cell";

  const span = document.createElement("span");
  span.className = "model-id-text";
  span.textContent = modelId;

  const button = document.createElement("button");
  button.className = "copy-button";
  const copyIcon = makeCopyIcon();
  const checkIcon = makeCheckIcon();
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
    } catch {
      // clipboard unavailable
    }
  });

  div.append(span, button);
  return div;
}

function makeProviderCell(
  providerId: string,
  providerName: string
): HTMLElement {
  const div = document.createElement("div");
  div.className = "provider-cell";

  const img = document.createElement("img");
  img.src = `/logos/${providerId}.svg`;
  img.alt = providerName;
  img.width = 16;
  img.height = 16;
  img.className = "provider-logo";

  const span = document.createElement("span");
  span.textContent = providerName;

  div.append(img, span);
  return div;
}

function makeNumberCell(value: number | undefined): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value == null ? "-" : value.toLocaleString();
  return span;
}

// ── Column definitions ────────────────────────────────────────────────────────

export const columnDefs: ColumnDef<Row, any>[] = [
  {
    id: "provider",
    header: "Provider",
    accessorFn: (row) => row.providerName,
    size: 150,
    meta: { dataType: "text", headerLabel: "Provider" } satisfies ColumnMeta,
    cell: (info) =>
      makeProviderCell(info.row.original.providerId, info.getValue()),
  },
  {
    id: "model",
    header: "Model",
    accessorFn: (row) => row.name,
    size: 200,
    meta: { dataType: "text", headerLabel: "Model" } satisfies ColumnMeta,
  },
  {
    id: "family",
    header: "Family",
    accessorFn: (row) => row.family ?? "-",
    size: 120,
    meta: { dataType: "text", headerLabel: "Family" } satisfies ColumnMeta,
  },
  {
    id: "provider-id",
    header: "Provider ID",
    accessorFn: (row) => row.providerId,
    size: 120,
    meta: { dataType: "text", headerLabel: "Provider ID" } satisfies ColumnMeta,
  },
  {
    id: "model-id",
    header: "Model ID",
    accessorFn: (row) => row.modelId,
    size: 220,
    meta: { dataType: "text", headerLabel: "Model ID" } satisfies ColumnMeta,
    cell: (info) => makeModelIdCell(info.getValue()),
  },
  {
    id: "tool-call",
    header: "Tool Call",
    accessorFn: (row) => row.tool_call,
    size: 90,
    sortingFn: "basic",
    meta: {
      dataType: "boolean",
      headerLabel: "Tool Call",
    } satisfies ColumnMeta,
    cell: (info) => makeBooleanCell(info.getValue()),
  },
  {
    id: "reasoning",
    header: "Reasoning",
    accessorFn: (row) => row.reasoning,
    size: 90,
    sortingFn: "basic",
    meta: {
      dataType: "boolean",
      headerLabel: "Reasoning",
    } satisfies ColumnMeta,
    cell: (info) => makeBooleanCell(info.getValue()),
  },
  {
    id: "input-modalities",
    header: "Input",
    accessorFn: (row) => row.modalities.input.length,
    size: 100,
    meta: {
      dataType: "modalities",
      headerLabel: "Input",
    } satisfies ColumnMeta,
    cell: (info) => makeModalitiesCell(info.row.original.modalities.input),
  },
  {
    id: "output-modalities",
    header: "Output",
    accessorFn: (row) => row.modalities.output.length,
    size: 100,
    meta: {
      dataType: "modalities",
      headerLabel: "Output",
    } satisfies ColumnMeta,
    cell: (info) => makeModalitiesCell(info.row.original.modalities.output),
  },
  {
    id: "input-cost",
    header: "Input Cost",
    accessorFn: (row) => row.cost?.input,
    size: 110,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Input Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "output-cost",
    header: "Output Cost",
    accessorFn: (row) => row.cost?.output,
    size: 115,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Output Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "reasoning-cost",
    header: "Reasoning Cost",
    accessorFn: (row) => row.cost?.reasoning,
    size: 130,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Reasoning Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "cache-read-cost",
    header: "Cache Read Cost",
    accessorFn: (row) => row.cost?.cache_read,
    size: 130,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Cache Read Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "cache-write-cost",
    header: "Cache Write Cost",
    accessorFn: (row) => row.cost?.cache_write,
    size: 135,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Cache Write Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "audio-input-cost",
    header: "Audio Input Cost",
    accessorFn: (row) => row.cost?.input_audio,
    size: 135,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Audio Input Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "audio-output-cost",
    header: "Audio Output Cost",
    accessorFn: (row) => row.cost?.output_audio,
    size: 140,
    sortUndefined: "last",
    meta: {
      dataType: "cost",
      headerLabel: "Audio Output Cost",
      headerSubLabel: "per 1M tokens",
    } satisfies ColumnMeta,
    cell: (info) => makeCostCell(info.getValue()),
  },
  {
    id: "context-limit",
    header: "Context Limit",
    accessorFn: (row) => row.limit.context,
    size: 115,
    meta: {
      dataType: "number",
      headerLabel: "Context Limit",
    } satisfies ColumnMeta,
    cell: (info) => makeNumberCell(info.getValue()),
  },
  {
    id: "input-limit",
    header: "Input Limit",
    accessorFn: (row) => row.limit.input,
    size: 100,
    sortUndefined: "last",
    meta: {
      dataType: "number",
      headerLabel: "Input Limit",
    } satisfies ColumnMeta,
    cell: (info) => makeNumberCell(info.getValue()),
  },
  {
    id: "output-limit",
    header: "Output Limit",
    accessorFn: (row) => row.limit.output,
    size: 110,
    meta: {
      dataType: "number",
      headerLabel: "Output Limit",
    } satisfies ColumnMeta,
    cell: (info) => makeNumberCell(info.getValue()),
  },
  {
    id: "structured-output",
    header: "Structured Output",
    accessorFn: (row) => row.structured_output,
    size: 145,
    meta: {
      dataType: "boolean",
      headerLabel: "Structured Output",
    } satisfies ColumnMeta,
    cell: (info) => {
      const v = info.getValue();
      const span = document.createElement("span");
      span.textContent = v === undefined ? "-" : v ? "Yes" : "No";
      return span;
    },
  },
  {
    id: "temperature",
    header: "Temperature",
    accessorFn: (row) => row.temperature,
    size: 110,
    meta: {
      dataType: "boolean",
      headerLabel: "Temperature",
    } satisfies ColumnMeta,
    cell: (info) => makeBooleanCell(info.getValue()),
  },
  {
    id: "weights",
    header: "Weights",
    accessorFn: (row) => (row.open_weights ? "Open" : "Closed"),
    size: 90,
    meta: { dataType: "text", headerLabel: "Weights" } satisfies ColumnMeta,
  },
  {
    id: "knowledge",
    header: "Knowledge",
    accessorFn: (row) => (row.knowledge ? row.knowledge.substring(0, 7) : "-"),
    size: 105,
    meta: { dataType: "text", headerLabel: "Knowledge" } satisfies ColumnMeta,
  },
  {
    id: "release-date",
    header: "Release Date",
    accessorFn: (row) => row.release_date ?? "-",
    size: 115,
    meta: {
      dataType: "text",
      headerLabel: "Release Date",
    } satisfies ColumnMeta,
  },
  {
    id: "last-updated",
    header: "Last Updated",
    accessorFn: (row) => row.last_updated ?? "-",
    size: 115,
    meta: {
      dataType: "text",
      headerLabel: "Last Updated",
    } satisfies ColumnMeta,
  },
];
