import type { TableRow } from "./shared.js";

/**
 * Objective model scoring.
 *
 * Every input is a factual field already in the catalog (cost, context window,
 * output limit, capability flags, modality breadth, release date). Nothing is
 * benchmarked or hand-graded. We turn those raw fields into three transparent,
 * normalized 0-100 indices so the table can be ranked from different angles:
 *
 *   - capability : what the model can do (capability flags + modality breadth)
 *   - cost       : price efficiency (cheaper -> higher; free -> top)
 *   - context    : context window + output limit (log-scaled)
 *   - recency    : how recently it was released
 *
 * Each composite below is just a weighted blend of those four components. The
 * weights are the only opinion in the file and are intentionally kept here, in
 * one place, so they're easy to audit or change.
 */
const WEIGHTS = {
  // Well-rounded "best overall".
  overall: { capability: 0.4, cost: 0.3, context: 0.2, recency: 0.1 },
  // Cheap-yet-capable wins.
  value: { capability: 0.35, cost: 0.5, context: 0.1, recency: 0.05 },
  // What the model can do dominates; price is a minor tiebreaker.
  capability: { capability: 0.6, cost: 0.15, context: 0.2, recency: 0.05 },
} as const;

/** Rows before scores are attached. */
type ScorableRow = Omit<
  TableRow,
  "overallScore" | "valueScore" | "capabilityScore"
>;

const NEUTRAL = 50;

/**
 * Returns a function that maps a raw value to 0-100 via min-max over the
 * dataset. Non-finite inputs (or a flat dataset) collapse to a neutral 50 so a
 * missing field never silently wins or loses.
 */
function normalizer(values: number[]): (value: number) => number {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 0;
  const span = max - min;
  return (value: number) => {
    if (!Number.isFinite(value) || span === 0) return NEUTRAL;
    return ((value - min) / span) * 100;
  };
}

/** Capability flags + how many input/output modalities are supported. */
function capabilityRaw(row: ScorableRow): number {
  const flags =
    (row.toolCall ? 1 : 0) +
    (row.reasoning ? 1 : 0) +
    (row.structuredOutput ? 1 : 0) +
    (row.temperature ? 1 : 0);
  return flags + row.input.length + row.output.length;
}

/** Context window + output limit, log-scaled (they span orders of magnitude). */
function contextRaw(row: ScorableRow): number {
  return (
    Math.log10((row.contextLimit || 0) + 1) +
    0.5 * Math.log10((row.outputLimit || 0) + 1)
  );
}

/**
 * Blended price per 1M tokens (input + output). Returns NaN when no pricing is
 * published so the model lands on a neutral cost score rather than a free pass.
 */
function blendedCost(row: ScorableRow): number {
  const parts = [row.inputCost, row.outputCost].filter(
    (cost): cost is number => cost !== undefined,
  );
  if (parts.length === 0) return NaN;
  return parts.reduce((sum, cost) => sum + cost, 0);
}

/** Release date as an epoch (ms); newer is higher. NaN when unparseable. */
function recencyRaw(row: ScorableRow): number {
  return Date.parse(row.releaseDate);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Computes the three composite scores for every row and returns new rows with
 * `overallScore`, `valueScore` and `capabilityScore` attached. Normalization is
 * over the whole set, so scores are relative to the rest of the catalog.
 */
export function annotateScores(rows: ScorableRow[]): TableRow[] {
  const capNorm = normalizer(rows.map(capabilityRaw));
  const ctxNorm = normalizer(rows.map(contextRaw));
  const recNorm = normalizer(rows.map(recencyRaw));
  // Cost is log-scaled then inverted: lower price -> higher score.
  const costNorm = normalizer(
    rows.map((row) => {
      const cost = blendedCost(row);
      return Number.isNaN(cost) ? NaN : Math.log10(cost + 0.01);
    }),
  );

  return rows.map((row) => {
    const capability = capNorm(capabilityRaw(row));
    const context = ctxNorm(contextRaw(row));
    const recency = recNorm(recencyRaw(row));
    const cost = blendedCost(row);
    // Invert cost: cheapest model in the set scores highest. Unknown -> neutral.
    const costScore = Number.isNaN(cost)
      ? NEUTRAL
      : 100 - costNorm(Math.log10(cost + 0.01));

    const blend = (w: (typeof WEIGHTS)[keyof typeof WEIGHTS]) =>
      round(
        capability * w.capability +
          costScore * w.cost +
          context * w.context +
          recency * w.recency,
      );

    return {
      ...row,
      overallScore: blend(WEIGHTS.overall),
      valueScore: blend(WEIGHTS.value),
      capabilityScore: blend(WEIGHTS.capability),
    };
  });
}
