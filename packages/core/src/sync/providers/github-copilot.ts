import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

const TABLES = "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot";
const PRICING_ENDPOINT = `${TABLES}/models-and-pricing.yml`;
// https://docs.github.com/en/copilot/reference/ai-models/supported-models#model-retirement-history
const RETIREMENTS_ENDPOINT = `${TABLES}/model-deprecation-history.yml`;

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

export const GitHubCopilotRetirementRow = z.object({
  name: z.string().min(1),
  retirement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
}).passthrough();

export type GitHubCopilotRetirementRow = z.infer<typeof GitHubCopilotRetirementRow>;

export interface GitHubCopilotPricingModel {
  slug: string;
  releaseStatus: string;
  rows: GitHubCopilotPricingRow[];
  /** The retirement table's date, when GitHub lists the model there. */
  retirementDate?: string;
  /** The retirement date has passed. */
  retired?: boolean;
}

const IGNORED_ROWS = new Set([
  // Goes in [experimental.modes.fast] under claude-opus-4.8
  "claude-opus-4.8-fast-mode-preview",
]);

// Retired, but GitHub keeps them for individual subscribers on annual plans (footnotes on the retirement table).
const ANNUAL_PLAN_MODELS = new Set(["claude-sonnet-4.6", "claude-opus-4.8"]);

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

/**
 * Adds the retirement table to the priced models. A model retired before `today` (YYYY-MM-DD, UTC) is marked retired,
 * except the ones GitHub keeps for annual plans; retired models missing from the pricing table are added without rows.
 */
export function parseGitHubCopilotSource(raw: unknown, today = new Date().toISOString().slice(0, 10)) {
  const source = z.object({ pricing: z.unknown(), retirements: z.array(GitHubCopilotRetirementRow) }).parse(raw);
  const models = new Map(parseGitHubCopilotPricing(source.pricing).map((model) => [model.slug, model]));
  for (const row of source.retirements) {
    const slug = githubCopilotModelSlug(row.name);
    if (ANNUAL_PLAN_MODELS.has(slug)) continue;
    const model = models.get(slug) ?? { slug, releaseStatus: "GA", rows: [] };
    model.retirementDate = row.retirement_date;
    model.retired = row.retirement_date <= today;
    models.set(slug, model);
  }
  return [...models.values()];
}

function candidateIDs(model: GitHubCopilotPricingModel) {
  return [
    model.slug,
    model.releaseStatus === "Public preview" ? `${model.slug}-preview` : undefined,
  ].filter((candidate) => candidate !== undefined);
}

export function buildGitHubCopilotModel(
  model: GitHubCopilotPricingModel,
  authored: ExistingModel,
): SyncedModel {
  // Only update token rates, leaving audio/reasoning rates and all other
  // fields untouched. A model that's no longer priced keeps its last prices.
  const cost = model.rows.length === 0 ? authored.cost : { ...authored.cost, ...buildGitHubCopilotCost(model) };
  const status = model.retirementDate === undefined ? authored.status : "deprecated";
  return { ...authored, cost, status } as SyncedModel;
}

export const githubCopilot = {
  id: "github-copilot",
  name: "GitHub Copilot",
  modelsDir: "providers/github-copilot/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return IGNORED_ROWS.has(model.slug) || model.retirementDate !== undefined ? undefined : model.slug;
  },
  retiredIDs(models) {
    return models.filter((model) => model.retired === true).flatMap(candidateIDs);
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
    const [pricing, retirements] = await Promise.all([PRICING_ENDPOINT, RETIREMENTS_ENDPOINT].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Copilot docs request failed for ${url}: ${response.status} ${response.statusText}`);
      }
      return Bun.YAML.parse(await response.text());
    }));
    return { pricing, retirements };
  },
  parseModels: (raw) => parseGitHubCopilotSource(raw),
  translateModel(model, context) {
    if (IGNORED_ROWS.has(model.slug) || model.retired === true) return undefined;
    const id = candidateIDs(model).find((candidate) => context.authored(candidate) !== undefined);
    const authored = id === undefined ? undefined : context.authored(id);
    if (id === undefined || authored === undefined) return undefined;
    return {
      id,
      model: buildGitHubCopilotModel(model, authored),
      header: "# Pricing: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing\n",
    };
  },
} satisfies SyncProvider<GitHubCopilotPricingModel>;
