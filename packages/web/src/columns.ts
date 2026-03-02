export type ColumnType = "text" | "number" | "boolean" | "modalities";

export interface TableColumn {
  id: string;
  urlName: string;
  type: ColumnType;
  label: string;
  desc?: string;
}

export const TABLE_COLUMNS = [
  { id: "provider", urlName: "provider", type: "text", label: "Provider" },
  { id: "model", urlName: "model", type: "text", label: "Model" },
  { id: "family", urlName: "family", type: "text", label: "Family" },
  { id: "provider-id", urlName: "provider-id", type: "text", label: "Provider ID" },
  { id: "model-id", urlName: "model-id", type: "text", label: "Model ID" },
  { id: "tool-call", urlName: "tool-call", type: "boolean", label: "Tool Call" },
  { id: "reasoning", urlName: "reasoning", type: "boolean", label: "Reasoning" },
  { id: "input-modalities", urlName: "input", type: "modalities", label: "Input" },
  { id: "output-modalities", urlName: "output", type: "modalities", label: "Output" },
  { id: "input-cost", urlName: "input-cost", type: "number", label: "Input Cost", desc: "per 1M tokens" },
  { id: "output-cost", urlName: "output-cost", type: "number", label: "Output Cost", desc: "per 1M tokens" },
  { id: "reasoning-cost", urlName: "reasoning-cost", type: "number", label: "Reasoning Cost", desc: "per 1M tokens" },
  { id: "cache-read-cost", urlName: "cache-read-cost", type: "number", label: "Cache Read Cost", desc: "per 1M tokens" },
  { id: "cache-write-cost", urlName: "cache-write-cost", type: "number", label: "Cache Write Cost", desc: "per 1M tokens" },
  { id: "audio-input-cost", urlName: "audio-input-cost", type: "number", label: "Audio Input Cost", desc: "per 1M tokens" },
  { id: "audio-output-cost", urlName: "audio-output-cost", type: "number", label: "Audio Output Cost", desc: "per 1M tokens" },
  { id: "context-limit", urlName: "context-limit", type: "number", label: "Context Limit" },
  { id: "input-limit", urlName: "input-limit", type: "number", label: "Input Limit" },
  { id: "output-limit", urlName: "output-limit", type: "number", label: "Output Limit" },
  { id: "structured-output", urlName: "structured-output", type: "boolean", label: "Structured Output" },
  { id: "temperature", urlName: "temperature", type: "boolean", label: "Temperature" },
  { id: "weights", urlName: "weights", type: "text", label: "Weights" },
  { id: "knowledge", urlName: "knowledge", type: "text", label: "Knowledge" },
  { id: "release-date", urlName: "release-date", type: "text", label: "Release Date" },
  { id: "last-updated", urlName: "last-updated", type: "text", label: "Last Updated" },
] as const satisfies readonly TableColumn[];

export type TableColumnId = (typeof TABLE_COLUMNS)[number]["id"];
