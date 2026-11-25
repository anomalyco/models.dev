import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// DeepSeek: GET https://api.deepseek.com/models (DEEPSEEK_API_KEY) for limits, and the pricing page as Markdown for
// prices. Files bill reasoning at the output price and hold the peak-hours 2x multiplier themselves, so off-peak
// prices are the base and the sync refuses to run if a peak price isn't twice its off-peak price.
const MODELS_ENDPOINT = "https://api.deepseek.com/models";
const PRICING_ENDPOINT = "https://api-docs.deepseek.com/quick_start/pricing.md";

const DeepSeekModel = z.object({
  id: z.string().min(1),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
}).passthrough();

export interface DeepSeekPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export interface DeepSeekEntry {
  id: string;
  limit?: { context: number; output: number };
  price?: DeepSeekPrice;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const PRICE_ROWS = {
  cacheRead: "1M INPUT TOKENS / (CACHE HIT)",
  input: "1M INPUT TOKENS / (CACHE MISS)",
  output: "1M OUTPUT TOKENS",
} as const;

/**
 * Off-peak prices per model from the pricing page's model table, and the legacy names its footnotes say are still
 * accepted. Throws when the table changes shape or a peak price isn't twice the off-peak one.
 */
export function parseDeepSeekPricing(markdown: string) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^\|\s*MODEL\s*\|/.test(line));
  if (start === -1) throw new Error("DeepSeek pricing: no model table");
  const header = cells(lines[start]!);
  if (!/^\|[\s|:-]+\|$/.test(lines[start + 1]?.trim() ?? "")) throw new Error("DeepSeek pricing: no separator row");
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    if (row.length !== header.length) throw new Error(`DeepSeek pricing: a row has ${row.length} cells, the header ${header.length}`);
    rows.push(row);
  }
  if (header.slice(0, 3).some((label) => label !== "MODEL")) throw new Error("DeepSeek pricing: unexpected label columns");
  const columns = header.slice(3).map((cell) => {
    const match = /^([a-z0-9][a-z0-9.-]*)(?:\((\d+)\))?$/.exec(cell);
    if (match === null) throw new Error(`DeepSeek pricing: unexpected model column ${JSON.stringify(cell)}`);
    return { id: match[1]!, note: match[2] };
  });
  if (columns.length === 0) throw new Error("DeepSeek pricing: no model columns");
  const value = (label: string, band: "OFF-PEAK" | "PEAK", column: number) => {
    const matches = rows.filter((row) => row[0]!.startsWith("PRICING") && row[1] === label && row[2] === band);
    if (matches.length !== 1) throw new Error(`DeepSeek pricing: expected one ${label} ${band} row, found ${matches.length}`);
    const match = /^\$(\d+(?:\.\d+)?)$/.exec(matches[0]![3 + column]!);
    if (match === null) throw new Error(`DeepSeek pricing: ${columns[column]!.id} ${label} ${band} isn't a dollar price`);
    return Number(match[1]);
  };
  const prices = new Map<string, DeepSeekPrice>();
  columns.forEach((column, index) => {
    const price = {} as DeepSeekPrice;
    for (const [field, label] of Object.entries(PRICE_ROWS) as [keyof DeepSeekPrice, string][]) {
      const offPeak = value(label, "OFF-PEAK", index);
      const peak = value(label, "PEAK", index);
      if (Math.abs(peak - offPeak * 2) > 1e-9) {
        throw new Error(`DeepSeek pricing: ${column.id} ${label} peak $${peak} isn't twice off-peak $${offPeak}`);
      }
      price[field] = offPeak;
    }
    prices.set(column.id, price);
  });
  // "(1) Use `deepseek-flash` as the model name. The legacy names `a` and `b` are still accepted, ..."
  const aliases = new Map<string, string>();
  for (const column of columns) {
    if (column.note === undefined) continue;
    const note = lines.find((line) => line.startsWith(`(${column.note})`));
    const legacy = note === undefined ? undefined : /legacy names? (.*?) (?:is|are) still accepted/.exec(note)?.[1];
    for (const [, alias] of legacy?.matchAll(/`([a-z0-9][a-z0-9.-]*)`/g) ?? []) aliases.set(alias!, column.id);
  }
  return { prices, aliases };
}

/** Entries for every listed model, plus legacy names that take their target's prices and limits. */
export function deepseekEntries(models: z.infer<typeof DeepSeekModel>[], markdown: string): DeepSeekEntry[] {
  const { prices, aliases } = parseDeepSeekPricing(markdown);
  const entries: DeepSeekEntry[] = models.map((model) => ({
    id: model.id,
    limit: { context: model.context_window, output: model.max_output_tokens },
    ...(prices.has(model.id) ? { price: prices.get(model.id)! } : {}),
  }));
  for (const [alias, target] of aliases) {
    const entry = entries.find((item) => item.id === target);
    if (entry !== undefined && !entries.some((item) => item.id === alias)) entries.push({ ...entry, id: alias });
  }
  return entries;
}

// Prices and limits only. Effort levels, toggles, APIs and the peak multiplier stay hand-written.
export function buildDeepSeekModel(entry: DeepSeekEntry, authored: ExistingModel): SyncedModel {
  const cost = entry.price === undefined
    ? authored.cost
    : {
      ...authored.cost,
      input: entry.price.input,
      output: entry.price.output,
      cache_read: entry.price.cacheRead,
      ...(authored.cost?.reasoning === undefined ? {} : { reasoning: entry.price.output }),
    };
  const limit = entry.limit === undefined ? authored.limit : { ...authored.limit, ...entry.limit };
  return { ...authored, ...(cost === undefined ? {} : { cost }), ...(limit === undefined ? {} : { limit }) } as SyncedModel;
}

export const deepseek = {
  id: "deepseek",
  name: "DeepSeek",
  modelsDir: "providers/deepseek/models",
  // New models need release dates, APIs and tool choices written by hand, so they're reported instead of created.
  skipCreates: true,
  deleteMissing: false,
  sourceID(entry) {
    return entry.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} DeepSeek models have no local file: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [`${paths.length} local DeepSeek models are no longer listed and were retained: ${paths.map((item) => `\`${item}\``).join(", ")}`];
  },
  async fetchModels() {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("DeepSeek sync requires DEEPSEEK_API_KEY");
    const [models, pricing] = await Promise.all([
      fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } }),
      fetch(PRICING_ENDPOINT),
    ]);
    if (!models.ok) throw new Error(`DeepSeek models request failed: ${models.status} ${models.statusText}`);
    if (!pricing.ok) throw new Error(`DeepSeek pricing request failed: ${pricing.status} ${pricing.statusText}`);
    return { models: await models.json(), pricing: await pricing.text() };
  },
  parseModels(raw) {
    const { models, pricing } = raw as { models: unknown; pricing: string };
    const list = z.object({ data: z.array(DeepSeekModel).nonempty() }).passthrough().parse(models).data;
    return deepseekEntries(list, pricing);
  },
  translateModel(entry, context) {
    const authored = context.authored(entry.id);
    if (authored === undefined) return undefined;
    return { id: entry.id, model: buildDeepSeekModel(entry, authored) };
  },
} satisfies SyncProvider<DeepSeekEntry>;
