import { z } from "zod";

import type { SyncProvider, SyncedModel } from "../index.js";


const DOCS = "https://dev.meta.ai/docs";

// `families` holds each model family's own docs page (e.g. muse-spark.md), which now carries its availability table.
const MetaResponse = z.object({ models: z.string(), pricing: z.string(), families: z.array(z.string()).default([]) });
const Price = z.number().finite().nonnegative();
const TokenCost = z.object({ input: Price, output: Price, cache_read: Price });
const MetaModel = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  context: z.number().int().positive().safe(),
  cost: TokenCost.extend({
    tiers: z.array(TokenCost.extend({
      tier: z.object({ type: z.literal("context"), size: z.number().int().positive().safe() }),
    })).length(1).optional(),
  }),
});

export type MetaModel = z.infer<typeof MetaModel>;

type Mode = "standard" | "contributor";

const AVAILABILITY = ["Model API (pay-as-you-go)", "Muse Code"];
const PRICE_COLUMNS: Record<Mode, string> = {
  standard: "Standard mode (per 1M tokens)",
  contributor: "Contributor mode (per 1M tokens)",
};

// The "Model API (pay-as-you-go)" column's values for available models.
const API_MODES = new Map<string, Mode>([
  ["Standard mode", "standard"],
  ["Available (Standard mode only)", "standard"],
  ["Contributor mode", "contributor"],
]);

function cells(line: string) {
  return line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
}

// Returns the rows of every table whose header satisfies `matches`.
function tables(markdown: string, matches: (header: string[]) => boolean) {
  const lines = markdown.split("\n");
  const found: { header: string[]; rows: string[][] }[] = [];
  for (const [index, line] of lines.entries()) {
    const header = cells(line);
    if (!line.trim().startsWith("|") || !matches(header)) continue;
    const separator = cells(lines[index + 1] ?? "");
    if (separator.length !== header.length || separator.some((cell) => !/^:?-+:?$/.test(cell))) {
      throw new Error("Meta docs have an invalid table separator");
    }
    const rows: string[][] = [];
    for (const row of lines.slice(index + 2)) {
      if (!row.trim().startsWith("|")) break;
      const values = cells(row);
      if (values.length !== header.length) throw new Error("Meta docs have an invalid table row");
      rows.push(values);
    }
    if (rows.length === 0) throw new Error("Meta docs table is empty");
    found.push({ header, rows });
  }
  return found;
}

function same(header: string[], expected: string[]) {
  return JSON.stringify(header) === JSON.stringify(expected);
}

function sections(markdown: string, level: "##" | "###") {
  return markdown.split(new RegExp(`^${level} `, "m")).slice(1);
}

function sectionID(section: string) {
  const heading = section.split("\n")[0]?.trim() ?? "";
  const explicit = heading.match(/\{#([a-z0-9-]+)\}$/)?.[1];
  if (explicit !== undefined) return explicit;
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Model families document their API IDs in an availability table such as
// `| Version | Model API (pay-as-you-go) | Muse Code |`.
function familyModels(section: string) {
  const found = tables(section, (header) => header.length === 3 && same(header.slice(1), AVAILABILITY));
  if (found.length > 1) throw new Error(`Meta docs have multiple ${sectionID(section)} availability tables`);
  return (found[0]?.rows ?? []).flatMap(([variant, api]) => {
    if (api === "Not available") return [];
    const id = variant!.match(/\(`([^`]+)`\)$/)?.[1];
    const mode = API_MODES.get(api!);
    if (id === undefined || mode === undefined || id.endsWith("-contributor") !== (mode === "contributor")) {
      throw new Error("Meta docs have an unsupported model availability row");
    }
    return [{ id, mode }];
  });
}

// Prose ("a 1,048,576-token context window") or a family page's at-a-glance row ("| **Context window** | 1,048,576 tokens |").
function familyContext(section: string) {
  const windows = new Set(
    [
      ...section.matchAll(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)-token context window/g),
      ...section.matchAll(/^\|\s*\*\*Context window\*\*\s*\|\s*(\d{1,3}(?:,\d{3})+|\d+) tokens\s*\|/gm),
    ].map((match) => Number(match[1]!.replaceAll(",", ""))),
  );
  if (windows.size !== 1) throw new Error(`Meta docs need exactly one ${sectionID(section)} context window`);
  return [...windows][0]!;
}

// Muse Ember's table has one column per input-size tier instead of one per mode:
// `| Usage | Up to 200K input tokens (per 1M tokens) | Over 200K input tokens (per 1M tokens) |`.
const TIER_COLUMN = /^(Up to|Over) (\d+)K input tokens \(per 1M tokens\)$/;

function tierColumns(header: string[]) {
  const [usage, short, long, ...rest] = header;
  const below = short?.match(TIER_COLUMN);
  const above = long?.match(TIER_COLUMN);
  if (usage !== "Usage" || rest.length > 0 || below?.[1] !== "Up to" || above?.[1] !== "Over") return undefined;
  if (below[2] !== above[2]) throw new Error("Meta docs have mismatched long-context price tiers");
  return Number(below[2]) * 1_000;
}

function tableCost(table: { header: string[]; rows: string[][] }, column: number, label: string) {
  const prices = new Map<string, number>();
  for (const row of table.rows) {
    const usage = row[0]!;
    const price = row[column]!;
    if (!/^\$\d+(?:\.\d+)?$/.test(price) || prices.has(usage)) {
      throw new Error(`Meta docs have invalid or duplicate ${label} pricing`);
    }
    prices.set(usage, Number(price.slice(1)));
  }
  return {
    input: prices.get("Input"),
    output: prices.get("Output"),
    cache_read: prices.get("Cached input"),
  };
}

function familyCost(pricing: string, family: string, mode: Mode) {
  const matches = sections(pricing, "###").filter((section) => sectionID(section) === family);
  if (matches.length !== 1) throw new Error(`Meta docs need exactly one pricing section for ${family}`);
  // Meta has reordered the mode columns before, so match them by name.
  const columns = Object.values(PRICE_COLUMNS).sort();
  const found = tables(
    matches[0]!,
    (header) => tierColumns(header) !== undefined || (header[0] === "Usage" && same(header.slice(1).sort(), columns)),
  );
  if (found.length !== 1) throw new Error(`Meta docs need exactly one ${family} token price table`);
  const table = found[0]!;
  const size = tierColumns(table.header);
  if (size === undefined) return tableCost(table, table.header.indexOf(PRICE_COLUMNS[mode]), `${family} ${mode} mode`);
  // A tiered table has no mode columns; Meta documents it for Standard-mode models only.
  if (mode !== "standard") throw new Error(`Meta docs have tiered pricing for ${family} ${mode} mode`);
  // Requests over the threshold are billed at the long-context rates in full.
  return {
    ...tableCost(table, 1, family),
    tiers: [{ ...tableCost(table, 2, `${family} long-context`), tier: { type: "context", size } }],
  };
}

export function parseMetaModels(raw: unknown): MetaModel[] {
  const response = MetaResponse.parse(raw);
  const ids = new Set<string>();
  // A family page is one section titled by its "# " heading.
  const families = response.families.map((page) => page.replace(/^\s*# /, ""));
  const models = [...sections(response.models, "##"), ...families].flatMap((section) => {
    const documented = familyModels(section);
    if (documented.length === 0) return [];
    const family = sectionID(section);
    const context = familyContext(section);
    return documented.map(({ id, mode }) => {
      if (ids.has(id)) throw new Error(`Meta docs have a duplicate model: ${id}`);
      ids.add(id);
      const parsed = MetaModel.safeParse({ id, context, cost: familyCost(response.pricing, family, mode) });
      if (!parsed.success) {
        parsed.error.cause = { provider: "meta", model: id };
        throw parsed.error;
      }
      return parsed.data;
    });
  });
  if (models.length === 0) throw new Error("Meta docs are missing token-priced model availability tables");
  return models;
}

// Model families whose overview section in models.md links to their own page (`## Muse Spark` → docs/muse-spark).
export function familyPages(models: string) {
  return sections(models, "##").map(sectionID).filter((id) => models.includes(`${DOCS}/${id})`));
}

export async function fetchMetaModels(fetcher: typeof fetch = fetch) {
  const get = async (page: string) => {
    const response = await fetcher(`${DOCS}/${page}.md`);
    if (!response.ok) throw new Error(`Meta docs request failed: ${response.status} ${response.statusText}`);
    return response.text();
  };
  const [models, pricing] = await Promise.all([get("models"), get("pricing-rate-limits")]);
  const families = await Promise.all(familyPages(models).map(get));
  return { models, pricing, families };
}

export const meta = {
  id: "meta",
  name: "Meta",
  modelsDir: "providers/meta/models",
  skipCreates: true,
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Meta's public docs list models requiring hand-authored metadata: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  fetchModels: fetchMetaModels,
  parseModels: parseMetaModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    // Only the documented token rates and context window are authoritative.
    // Keep output limits, modalities, reasoning controls, dates, and base_model.
    const limit = context.existing(model.id)?.limit?.context === model.context
      ? authored.limit
      : { ...authored.limit, context: model.context };
    return {
      id: model.id,
      // Tiers are part of the documented price, so flat-priced families clear stale ones.
      model: { ...authored, limit, cost: { ...authored.cost, ...model.cost, tiers: model.cost.tiers } } as SyncedModel,
    };
  },
} satisfies SyncProvider<MetaModel>;
