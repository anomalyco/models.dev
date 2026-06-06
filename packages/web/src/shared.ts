export interface TableLink {
  label: string;
  url: string;
  title?: string;
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

export function booleanText(value?: boolean) {
  if (value === undefined) return "-";
  return value ? "Yes" : "No";
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

export function weightsText(value?: boolean) {
  if (value === undefined) return "-";
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

export function renderModalities(modalities?: string[]) {
  if (!modalities || modalities.length === 0) return "-";
  return `<div class="modalities">${modalities
    .map(renderModalityIcon)
    .join("")}</div>`;
}

export function costSummary(input?: number, output?: number) {
  if (input === undefined && output === undefined) return "-";
  return `${formatCost(input)} / ${formatCost(output)}`;
}

export function capabilitySummary(capabilities: Array<[string, boolean | undefined]>) {
  const active = capabilities
    .filter(([, value]) => value === true)
    .map(([label]) => label);

  return active.length > 0 ? active.join(", ") : "-";
}

export function sortDate(value?: string) {
  return value ?? "";
}

export function sortNumber(value?: number) {
  return value === undefined ? "" : String(value);
}
