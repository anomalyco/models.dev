// GitHub Copilot: the pricing table in GitHub's docs
// (https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml).
// Authoritative for token, cache read and cache write prices and the
// long-context band. Every other field comes from authenticated endpoints
// and is hand-authored, so models without a file are only noted and files the
// table drops are kept for review. A public preview row may be filed as
// `<slug>-preview`.

import { z } from "zod";

import { fetchText } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const PRICING_ENDPOINT = "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";

const NOT_APPLICABLE = "Not applicable";
const Price = z.string().regex(/^\$\d+(?:\.\d+)?$/u);

const PricingRow = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  release_status: z.string().min(1),
  category: z.string().min(1),
  threshold: z.string().optional(),
  tier: z.string().optional(),
  input: Price,
  cached_input: Price,
  output: Price,
  cache_write: z.union([Price, z.literal(NOT_APPLICABLE)]).optional(),
  notes: z.string().optional(),
}).passthrough();
type PricingRow = z.infer<typeof PricingRow>;

const IGNORED_ROWS = new Set([
  // In [experimental.modes.fast] of claude-opus-4.8.
  "claude-opus-4.8-fast-mode-preview",
  // Retired models can stay in the table; don't rediscover them.
  // https://docs.github.com/en/copilot/reference/ai-models/supported-models#model-retirement-history
  // Sonnet 4.6 is still available to annual-plan subscribers and stays.
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "gemini-3.1-pro",
  "gpt-4.1",
  "gpt-5.2",
  "gpt-5.2-codex",
  "mai-code-1-flash",
  "raptor-mini",
]);

export const githubCopilot: SyncModule<unknown> = {
  id: "github-copilot",
  name: "GitHub Copilot",
  policy: {
    owns: [
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
    ],
    creates: "never",
    removals: "keep",
  },
  fetch: async () => Bun.YAML.parse(await fetchText(PRICING_ENDPOINT, { source: "Copilot pricing" })),
  observe(raw) {
    const models = Map.groupBy(z.array(PricingRow).parse(raw), (row) => slug(row.model));
    return [...models].filter(([id]) => !IGNORED_ROWS.has(id)).flatMap(([id, rows]) => {
      const observed = observe(id, rows);
      // A preview may be filed under `-preview`; it's only updated when that file exists.
      return rows[0]!.release_status === "Public preview" ? [observed, { ...observed, id: `${id}-preview`, updateOnly: true }] : [observed];
    });
  },
};

function slug(name: string) {
  return name.replace(/\[\^[^\]]*\]/gu, "").toLowerCase().replace(/[^a-z0-9.]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function price(value: string) {
  return value === NOT_APPLICABLE ? undefined : Number(value.slice(1));
}

function observe(id: string, rows: PricingRow[]): Observation {
  const defaults = rows.filter((row) => (row.tier ?? "Default") === "Default");
  const long = rows.filter((row) => row.tier === "Long context");
  const unknown = rows.find((row) => row.tier !== undefined && row.tier !== "Default" && row.tier !== "Long context");
  if (unknown !== undefined) throw new Error(`Unknown pricing tier for ${id}: ${unknown.tier}`);
  const base = defaults[0];
  if (base === undefined || defaults.length > 1) throw new Error(`Expected exactly one default pricing row for ${id}, found ${defaults.length}`);
  const bands = long.map((row) => ({ size: threshold(row.threshold, id), row })).sort((a, b) => a.size - b.size);
  const cache = (row: PricingRow) => {
    const write = row.cache_write === undefined ? undefined : price(row.cache_write);
    return { read: price(row.cached_input)!, ...(write === undefined ? {} : { write }) };
  };
  return {
    id,
    cost: {
      text: {
        input: {
          price: price(base.input)!,
          cache: { read: price(base.cached_input)!, write: (base.cache_write === undefined ? undefined : price(base.cache_write)) ?? null },
          overrides: bands.length === 0 ? null : bands.map(({ size, row }) => ({ when: { context: { gt: size } }, price: price(row.input)!, cache: cache(row) })),
        },
        output: {
          price: price(base.output)!,
          overrides: bands.length === 0 ? null : bands.map(({ size, row }) => ({ when: { context: { gt: size } }, price: price(row.output)! })),
        },
      },
    },
  };
}

function threshold(value: string | undefined, id: string) {
  const match = value?.match(/^>\s*(\d+(?:\.\d+)?)\s*([KM])$/u);
  if (!match) throw new Error(`Unparseable long-context threshold for ${id}: ${value}`);
  return Number(match[1]) * (match[2] === "K" ? 1_000 : 1_000_000);
}
