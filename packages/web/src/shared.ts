export interface TableRowFields {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  family?: string;
  toolCall: boolean;
  reasoning: boolean;
  input: string[];
  output: string[];
  inputCost?: number;
  outputCost?: number;
  reasoningCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  audioInputCost?: number;
  audioOutputCost?: number;
  contextLimit: number;
  inputLimit?: number;
  outputLimit: number;
  structuredOutput?: boolean;
  temperature: boolean;
  openWeights: boolean;
  knowledge?: string;
  releaseDate: string;
  lastUpdated: string;
}

const MODALITY_ICONS: Record<string, string> = {
  text: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,7 4,4 20,4 20,7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  image: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>`,
  audio: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="m19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  video: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"></path><rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect></svg>`,
  pdf: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14,2 14,8 20,8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10,9 9,9 8,9"></polyline></svg>`,
};

export function escapeHtml(value: string | number) {
  return String(value).replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

export function booleanText(value: boolean) {
  return value ? "Yes" : "No";
}

export function optionalBooleanText(value?: boolean) {
  return value === undefined ? "-" : booleanText(value);
}

export function formatCost(cost?: number) {
  return cost === undefined ? "-" : `$${cost.toFixed(2)}`;
}

export function formatNumber(value?: number) {
  return value === undefined ? "-" : value.toLocaleString();
}

export function knowledgeText(value?: string) {
  return value ? value.substring(0, 7) : "-";
}

export function weightsText(value: boolean) {
  return value ? "Open" : "Closed";
}

export function renderModalityIcon(modality: string) {
  const label =
    modality === "pdf"
      ? "PDF"
      : modality[0]!.toUpperCase() + modality.slice(1);
  const icon = MODALITY_ICONS[modality];
  if (!icon) return "";
  return `<span class="modality-icon" data-tooltip="${label}">${icon}</span>`;
}

export function renderModalities(modalities: string[]) {
  return `<div class="modalities">${modalities
    .map(renderModalityIcon)
    .join("")}</div>`;
}

export function renderCopyButton(modelId: string) {
  const escapedModelId = escapeHtml(modelId);
  return `<button type="button" class="copy-button" data-model-id="${escapedModelId}" aria-label="Copy model ID"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;"><polyline points="20,6 9,17 4,12"></polyline></svg></button>`;
}

export function renderRow(row: TableRowFields, index: number) {
  return `<tr data-index="${index}">
    <td><div class="provider-cell"><img src="/logos/${encodeURIComponent(
      row.providerId
    )}.svg" alt="" loading="lazy" decoding="async"><span>${escapeHtml(
    row.providerName
  )}</span></div></td>
    <td>${escapeHtml(row.modelName)}</td>
    <td>${escapeHtml(row.family ?? "-")}</td>
    <td>${escapeHtml(row.providerId)}</td>
    <td><div class="model-id-cell"><span class="model-id-text">${escapeHtml(
      row.modelId
    )}</span>${renderCopyButton(row.modelId)}</div></td>
    <td>${booleanText(row.toolCall)}</td>
    <td>${booleanText(row.reasoning)}</td>
    <td>${renderModalities(row.input)}</td>
    <td>${renderModalities(row.output)}</td>
    <td>${formatCost(row.inputCost)}</td>
    <td>${formatCost(row.outputCost)}</td>
    <td>${formatCost(row.reasoningCost)}</td>
    <td>${formatCost(row.cacheReadCost)}</td>
    <td>${formatCost(row.cacheWriteCost)}</td>
    <td>${formatCost(row.audioInputCost)}</td>
    <td>${formatCost(row.audioOutputCost)}</td>
    <td>${formatNumber(row.contextLimit)}</td>
    <td>${formatNumber(row.inputLimit)}</td>
    <td>${formatNumber(row.outputLimit)}</td>
    <td>${optionalBooleanText(row.structuredOutput)}</td>
    <td>${booleanText(row.temperature)}</td>
    <td>${weightsText(row.openWeights)}</td>
    <td>${knowledgeText(row.knowledge)}</td>
    <td>${escapeHtml(row.releaseDate)}</td>
    <td>${escapeHtml(row.lastUpdated)}</td>
  </tr>`;
}

export function scanWorstCaseRow(rows: TableRowFields[]): TableRowFields {
  const worst: TableRowFields = {
    providerId: "", providerName: "", modelId: "", modelName: "",
    toolCall: true, reasoning: true,
    input: [], output: [],
    contextLimit: 0, outputLimit: 0,
    structuredOutput: true, temperature: true, openWeights: false,
    releaseDate: "", lastUpdated: "",
  };

  for (const row of rows) {
    if (row.providerName.length > worst.providerName.length) worst.providerName = row.providerName;
    if (row.modelName.length > worst.modelName.length) worst.modelName = row.modelName;
    if ((row.family ?? "").length > (worst.family ?? "").length) worst.family = row.family;
    if (row.providerId.length > worst.providerId.length) worst.providerId = row.providerId;
    if (row.modelId.length > worst.modelId.length) worst.modelId = row.modelId;
    if ((row.knowledge ?? "").length > (worst.knowledge ?? "").length) worst.knowledge = row.knowledge;
    if (row.releaseDate.length > worst.releaseDate.length) worst.releaseDate = row.releaseDate;
    if (row.lastUpdated.length > worst.lastUpdated.length) worst.lastUpdated = row.lastUpdated;
    if (row.input.length > worst.input.length) worst.input = row.input;
    if (row.output.length > worst.output.length) worst.output = row.output;

    const costWider = (a: number | undefined, b: number | undefined) =>
      b !== undefined && (a === undefined || formatCost(b).length > formatCost(a).length);
    if (costWider(worst.inputCost, row.inputCost)) worst.inputCost = row.inputCost;
    if (costWider(worst.outputCost, row.outputCost)) worst.outputCost = row.outputCost;
    if (costWider(worst.reasoningCost, row.reasoningCost)) worst.reasoningCost = row.reasoningCost;
    if (costWider(worst.cacheReadCost, row.cacheReadCost)) worst.cacheReadCost = row.cacheReadCost;
    if (costWider(worst.cacheWriteCost, row.cacheWriteCost)) worst.cacheWriteCost = row.cacheWriteCost;
    if (costWider(worst.audioInputCost, row.audioInputCost)) worst.audioInputCost = row.audioInputCost;
    if (costWider(worst.audioOutputCost, row.audioOutputCost)) worst.audioOutputCost = row.audioOutputCost;

    const numWider = (a: number | undefined, b: number | undefined) =>
      b !== undefined && (a === undefined || formatNumber(b).length > formatNumber(a).length);
    if (numWider(worst.contextLimit as number | undefined, row.contextLimit)) worst.contextLimit = row.contextLimit;
    if (numWider(worst.inputLimit, row.inputLimit)) worst.inputLimit = row.inputLimit;
    if (numWider(worst.outputLimit as number | undefined, row.outputLimit)) worst.outputLimit = row.outputLimit;
  }

  return worst;
}
