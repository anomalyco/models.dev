// DeepSeek: https://api.deepseek.com/models (DEEPSEEK_API_KEY) and the pricing
// page as Markdown, https://api-docs.deepseek.com/quick_start/pricing.md.
// Authoritative: context and output limits, image input, effort levels and
// the default effort (from /models), and off-peak token and cache-hit prices
// (from the pricing table). Files bill reasoning at the output price and hold
// the peak-hours multiplier (2x) themselves, so the sync refuses to run when a
// peak price isn't twice its off-peak price. The legacy names the pricing page
// says are still accepted take their target's values but are never created.
// New models are added by hand (release dates, APIs and tool choices aren't
// listed). A model /models stops listing is marked deprecated.

import { z } from "zod";

import { bearer, fetchJSON, fetchText, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

const MODELS_ENDPOINT = "https://api.deepseek.com/models";
const PRICING_ENDPOINT = "https://api-docs.deepseek.com/quick_start/pricing.md";

const DeepSeekModel = z.object({
  id: z.string().min(1),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  effort: z.object({
    supported_levels: z.array(z.string()).nonempty(),
    default_level: z.string(),
  }).passthrough().optional(),
}).passthrough();
type DeepSeekModel = z.infer<typeof DeepSeekModel>;

const DeepSeekRaw = z.object({
  models: z.object({ object: z.literal("list"), data: z.array(DeepSeekModel).nonempty() }).passthrough(),
  pricing: z.string(),
});

export interface DeepSeekPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const deepseek: SyncModule<unknown> = {
  id: "deepseek",
  name: "DeepSeek",
  policy: {
    owns: [
      "limit.context",
      "limit.output",
      { path: "modalities.input", merge: "kinds", only: ["image", "audio", "video"] },
      "capabilities.reasoning.effort",
      "capabilities.reasoning.default",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.output.price",
      "cost.text.output.reasoning",
    ],
    creates: "gap",
    removals: "deprecate",
    // New module: a person checks its first runs before they merge. Remove once its output is trusted.
    review: "new sync module",
  },
  async fetch() {
    const key = requireEnv("DeepSeek", "DEEPSEEK_API_KEY");
    const [models, pricing] = await Promise.all([
      fetchJSON(MODELS_ENDPOINT, { source: "DeepSeek models", headers: bearer(key) }),
      fetchText(PRICING_ENDPOINT, { source: "DeepSeek pricing" }),
    ]);
    return { models, pricing };
  },
  observe(raw) {
    const { models, pricing } = DeepSeekRaw.parse(raw);
    const { prices, aliases } = parseDeepSeekPricing(pricing);
    const listed = new Set(models.data.map((model) => model.id));
    const observations = models.data.map((model) => observe(model, prices.get(model.id)));
    for (const [alias, target] of aliases) {
      const observation = observations.find((item) => item.id === target);
      if (observation === undefined || listed.has(alias)) continue;
      observations.push({ ...structuredClone(observation), id: alias, updateOnly: true });
    }
    return observations;
  },
};

function observe(model: DeepSeekModel, price: DeepSeekPrice | undefined): Observation {
  const kinds = (values: string[]) => values.map((value) => value.toLowerCase());
  const effort = model.effort;
  if (effort !== undefined && !effort.supported_levels.includes(effort.default_level)) {
    throw new Error(`DeepSeek ${model.id}: default effort ${effort.default_level} isn't one of its levels`);
  }
  return {
    id: model.id,
    limit: { context: model.context_window, output: model.max_output_tokens },
    modalities: { input: kinds(model.input_modalities) },
    ...(effort === undefined
      ? {}
      : {
        capabilities: {
          reasoning: {
            effort: reasoningControls({ effort: effort.supported_levels }).effort!,
            default: { type: "effort", value: effort.default_level as never },
          },
        },
      }),
    ...(price === undefined
      ? {}
      : {
        cost: {
          text: {
            input: { price: price.input, cache: { read: price.cacheRead } },
            output: { price: price.output, reasoning: price.output },
          },
        },
      }),
  };
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

// The labels of the price rows: [second column, third column] → field.
const PRICE_ROWS = {
  cacheRead: "1M INPUT TOKENS / (CACHE HIT)",
  input: "1M INPUT TOKENS / (CACHE MISS)",
  output: "1M OUTPUT TOKENS",
} as const;

/**
 * Off-peak prices per model from the "Model Details" table, and the legacy
 * names its footnotes say are still served by a model. Throws when the table's
 * shape changes or a peak price isn't twice the off-peak one.
 */
export function parseDeepSeekPricing(markdown: string) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^\|\s*MODEL\s*\|/.test(line));
  if (start === -1) throw new Error("DeepSeek pricing: no model table");
  const header = cells(lines[start]!);
  if (!/^\|[\s|:-]+\|$/.test(lines[start + 1]?.trim() ?? "")) throw new Error("DeepSeek pricing: the model table has no separator row");
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    if (row.length !== header.length) throw new Error(`DeepSeek pricing: a row has ${row.length} cells, the header ${header.length}`);
    rows.push(row);
  }
  // Model columns follow the three label columns, each an ID with an optional footnote marker.
  const labels = header.slice(0, 3);
  if (labels.some((label) => label !== "MODEL")) throw new Error("DeepSeek pricing: unexpected label columns");
  const columns = header.slice(3).map((cell) => {
    const match = /^([a-z0-9][a-z0-9.-]*)(?:\((\d+)\))?$/.exec(cell);
    if (match === null) throw new Error(`DeepSeek pricing: unexpected model column ${JSON.stringify(cell)}`);
    return { id: match[1]!, note: match[2] };
  });
  if (columns.length === 0) throw new Error("DeepSeek pricing: no model columns");

  const value = (label: string, band: "OFF-PEAK" | "PEAK", column: number) => {
    const matches = rows.filter((row) => row[0]!.startsWith("PRICING") && row[1] === label && row[2] === band);
    if (matches.length !== 1) throw new Error(`DeepSeek pricing: expected one ${label} ${band} row, found ${matches.length}`);
    const cell = matches[0]![3 + column]!;
    const match = /^\$(\d+(?:\.\d+)?)$/.exec(cell);
    if (match === null) throw new Error(`DeepSeek pricing: ${columns[column]!.id} ${label} ${band} isn't a dollar price: ${JSON.stringify(cell)}`);
    return Number(match[1]);
  };

  const prices = new Map<string, DeepSeekPrice>();
  columns.forEach((column, index) => {
    const price = {} as DeepSeekPrice;
    for (const [field, label] of Object.entries(PRICE_ROWS) as [keyof DeepSeekPrice, string][]) {
      const offPeak = value(label, "OFF-PEAK", index);
      const peak = value(label, "PEAK", index);
      // Files hold a 2x peak multiplier; anything else needs a person.
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
