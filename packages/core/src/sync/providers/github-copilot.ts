import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const PRICING_ENDPOINT = "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";

const NOT_APPLICABLE = "Not applicable";

const Price = z.string().regex(/^\$\d+(?:\.\d+)?$/u);

export const GitHubCopilotPricingRow = z.object({
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

export type GitHubCopilotPricingRow = z.infer<typeof GitHubCopilotPricingRow>;

export interface GitHubCopilotPricingModel {
  slug: string;
  releaseStatus: string;
  rows: GitHubCopilotPricingRow[];
}

// Map names in pricing YAML to actual filenames in repo
const FILE_ALIASES: Record<string, string> = {
  "mai-code-1-flash": "mai-code-1-flash-picker",
};

const IGNORED_ROWS = new Set([
  // Goes in [experimental.modes.fast] under claude-opus-4.8
  "claude-opus-4.8-fast-mode-preview",
  // Retired models can remain in the pricing table; do not rediscover them.
  // https://docs.github.com/en/copilot/reference/ai-models/supported-models#model-retirement-history
  // Sonnet 4.6 is still available to annual-plan subscribers and stays eligible.
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "gemini-3.1-pro",
  "gpt-4.1",
  "gpt-5.2",
  "gpt-5.2-codex",
  "raptor-mini",
]);

export function githubCopilotModelSlug(name: string) {
  return name
    .replace(/\[\^[^\]]*\]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function price(value: string) {
  return value === NOT_APPLICABLE ? undefined : Number(value.slice(1));
}

function rowCost(row: GitHubCopilotPricingRow) {
  return {
    input: price(row.input),
    output: price(row.output),
    cache_read: price(row.cached_input),
    cache_write: row.cache_write === undefined ? undefined : price(row.cache_write),
  };
}

function longContextThresholdSize(threshold: string | undefined, slug: string) {
  const match = threshold?.match(/^>\s*(\d+(?:\.\d+)?)\s*([KM])$/u);
  if (!match) throw new Error(`Unparseable long-context threshold for ${slug}: ${threshold}`);
  return Number(match[1]) * (match[2] === "K" ? 1_000 : 1_000_000);
}

export function buildGitHubCopilotCost(model: GitHubCopilotPricingModel) {
  const defaults: GitHubCopilotPricingRow[] = [];
  const longContext: GitHubCopilotPricingRow[] = [];
  for (const row of model.rows) {
    const tier = row.tier ?? "Default";
    if (tier === "Default") defaults.push(row);
    else if (tier === "Long context") longContext.push(row);
    else throw new Error(`Unknown pricing tier for ${model.slug}: ${row.tier}`);
  }
  const base = defaults[0];
  if (base === undefined || defaults.length > 1) {
    throw new Error(`Expected exactly one default pricing row for ${model.slug}, found ${defaults.length}`);
  }

  const tiers = longContext
    .map((row) => ({
      tier: { type: "context" as const, size: longContextThresholdSize(row.threshold, model.slug) },
      ...rowCost(row),
    }))
    .sort((a, b) => a.tier.size - b.tier.size);

  return { ...rowCost(base), tiers: tiers.length > 0 ? tiers : undefined };
}

export function parseGitHubCopilotPricing(raw: unknown) {
  const rows = z.array(GitHubCopilotPricingRow).parse(raw);
  const models = new Map<string, GitHubCopilotPricingModel>();
  for (const row of rows) {
    const slug = githubCopilotModelSlug(row.model);
    const model = models.get(slug) ?? { slug, releaseStatus: row.release_status, rows: [] };
    model.rows.push(row);
    models.set(slug, model);
  }
  return [...models.values()];
}

export function buildGitHubCopilotModel(
  model: GitHubCopilotPricingModel,
  authored: ExistingModel,
): SyncedModel {
  // Only update token rates, leaving audio/reasoning rates and all other
  // fields untouched.
  const cost = { ...authored.cost, ...buildGitHubCopilotCost(model) };
  return { ...authored, cost } as SyncedModel;
}

export const githubCopilot = {
  id: "github-copilot",
  name: "GitHub Copilot",
  modelsDir: "providers/github-copilot/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return IGNORED_ROWS.has(model.slug) ? undefined : model.slug;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Copilot pricing table models have no local catalog file: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Copilot models are missing from the docs pricing table and were retained: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(PRICING_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Copilot pricing request failed: ${response.status} ${response.statusText}`);
    }
    return Bun.YAML.parse(await response.text());
  },
  parseModels: parseGitHubCopilotPricing,
  translateModel(model, context) {
    if (IGNORED_ROWS.has(model.slug)) return undefined;
    const candidates = [
      model.slug,
      FILE_ALIASES[model.slug],
      model.releaseStatus === "Public preview" ? `${model.slug}-preview` : undefined,
    ].filter((candidate) => candidate !== undefined);
    const id = candidates.find((candidate) => context.authored(candidate) !== undefined);
    const authored = id === undefined ? undefined : context.authored(id);
    if (id === undefined || authored === undefined) return undefined;
    return {
      id,
      model: buildGitHubCopilotModel(model, authored),
      header: "# Pricing: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing\n",
    };
  },
} satisfies SyncProvider<GitHubCopilotPricingModel>;
