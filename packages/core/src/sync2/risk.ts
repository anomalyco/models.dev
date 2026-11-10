// Decides whether a sync result is safe to merge without review. The limits
// match packages/core/src/sync/auto-merge.ts and .github/sync-models/publish.sh.

import type { Change, Gap, Risk } from "./types.js";

export const LIMITS = {
  created: 10,
  deleted: 10,
  churn: 15,
};

// Providers whose reasoning controls come from a source reviewed well enough to merge unattended.
export const REVIEWED_REASONING = new Set([
  "aiand",
  "crossmodel",
  "edenai",
  "empiriolabs",
  "hyper",
  "kilo",
  "llmgateway",
  "llmgateway-providers",
  "merge-gateway",
  "nano-gpt",
  "openrouter",
  "venice",
  "vercel",
]);

export function classifyRisk(input: {
  provider: string;
  /** Model files the provider had before the sync. */
  before: number;
  changes: Change[];
  gaps: Gap[];
  /** The observations came from a file: written by an agent, or by hand in place of the source. */
  observedBy?: "agent" | "file";
}): Risk {
  const count = (kind: Change["kind"]) => input.changes.filter((change) => change.kind === kind).length;
  const created = count("create");
  const deleted = count("remove");
  const counts = {
    before: input.before,
    created,
    updated: count("update"),
    deleted,
    deprecated: count("deprecate"),
    priceChanges: input.changes.filter((change) => change.fields.some((field) => field.path.startsWith("cost."))).length,
    reasoningChanges: input.changes.filter((change) => change.reasoning).length,
    gaps: input.gaps.length,
  };

  const reasons: string[] = [];
  // An agent reads docs, so a person checks its evidence before anything merges.
  if (input.observedBy === "agent") reasons.push("agent-observed");
  if (input.observedBy === "file") reasons.push("observations from a file, not the source");
  if (created > LIMITS.created) reasons.push(`${created} models created (limit ${LIMITS.created})`);
  if (deleted > LIMITS.deleted) reasons.push(`${deleted} models deleted (limit ${LIMITS.deleted})`);
  if (created + deleted > LIMITS.churn) reasons.push(`${created + deleted} models created or deleted (limit ${LIMITS.churn})`);
  if (deleted > 0 && input.provider === "cloudflare-ai-gateway") {
    reasons.push("Cloudflare AI Gateway model deletions require manual review");
  }
  if (input.changes.length > 0 && input.before + created - deleted <= 0) reasons.push(`leaves ${input.provider} with no models`);
  if (deleted * 2 > input.before) reasons.push(`${deleted} of ${input.before} ${input.provider} models deleted (limit half)`);
  if (counts.reasoningChanges > 0 && !REVIEWED_REASONING.has(input.provider)) {
    for (const change of input.changes.filter((item) => item.reasoning)) {
      reasons.push(`${change.path} is a reasoning model that requires manual review`);
    }
  }

  return { safe: reasons.length === 0, reasons, counts };
}
