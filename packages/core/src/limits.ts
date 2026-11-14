export type LimitEntry = {
  file: string;
  limit?: { context?: number; input?: number; output?: number };
};

// Output and input are carved out of the context window, so neither can exceed it.
// Only checked when both values are set and the context is positive.
export function limitErrors(entries: LimitEntry[]): string[] {
  return entries.flatMap(({ file, limit }) => {
    const context = limit?.context;
    if (context === undefined || context <= 0) return [];
    return (["output", "input"] as const).flatMap((field) => {
      const value = limit?.[field];
      if (value === undefined || value <= context) return [];
      return [`${file}: limit.${field} (${value}) is larger than limit.context (${context})`];
    });
  });
}
