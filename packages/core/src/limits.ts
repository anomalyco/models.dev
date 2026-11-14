export type LimitEntry = {
  file: string;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { output?: readonly string[] };
};

// Output and input are carved out of the context window, so neither can exceed it.
// Only checked when both values are set and the context is positive, and only for
// models that output text: speech, image, video and embedding models report audio,
// image or vector limits that are independent of the text window.
export function limitErrors(entries: LimitEntry[]): string[] {
  return entries.flatMap(({ file, limit, modalities }) => {
    const context = limit?.context;
    if (context === undefined || context <= 0) return [];
    if (modalities?.output !== undefined && !modalities.output.includes("text")) return [];
    return (["output", "input"] as const).flatMap((field) => {
      const value = limit?.[field];
      if (value === undefined || value <= context) return [];
      return [`${file}: limit.${field} (${value}) is larger than limit.context (${context})`];
    });
  });
}
