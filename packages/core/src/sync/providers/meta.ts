import { z } from "zod";

import type { SyncProvider, SyncedModel } from "../index.js";

const MODELS_ENDPOINT = "https://dev.meta.ai/docs/models.md";
const PRICING_ENDPOINT = "https://dev.meta.ai/docs/pricing-rate-limits.md";

const MetaResponse = z.object({ models: z.string(), pricing: z.string() });
const MetaModel = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  context: z.number().int().positive().safe(),
  cost: z.object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cache_read: z.number().finite().nonnegative(),
  }),
});

export type MetaModel = z.infer<typeof MetaModel>;

const AVAILABILITY = ["Model API (pay-as-you-go)", "Muse Code"];
const PRICES = ["Usage", "Standard mode (per 1M tokens)", "Contributor mode (per 1M tokens)"];

type Mode = "standard" | "contributor";

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
  const found: string[][][] = [];
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
    found.push(rows);
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
  return (found[0] ?? []).flatMap(([variant, api]) => {
    if (api === "Not available") return [];
    const id = variant!.match(/\(`([^`]+)`\)$/)?.[1];
    const mode = API_MODES.get(api!);
    if (id === undefined || mode === undefined || id.endsWith("-contributor") !== (mode === "contributor")) {
      throw new Error("Meta docs have an unsupported model availability row");
    }
    return [{ id, mode }];
  });
}

function familyContext(section: string) {
  const windows = new Set(
    [...section.matchAll(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)-token context window/g)]
      .map((match) => Number(match[1]!.replaceAll(",", ""))),
  );
  if (windows.size !== 1) throw new Error(`Meta docs need exactly one ${sectionID(section)} context window`);
  return [...windows][0]!;
}

function familyCost(pricing: string, family: string, mode: Mode) {
  const matches = sections(pricing, "###").filter((section) => sectionID(section) === family);
  if (matches.length !== 1) throw new Error(`Meta docs need exactly one pricing section for ${family}`);
  const found = tables(matches[0]!, (header) => same(header, PRICES));
  if (found.length !== 1) throw new Error(`Meta docs need exactly one ${family} token price table`);
  const column = mode === "standard" ? 1 : 2;
  const prices = new Map<string, number>();
  for (const row of found[0]!) {
    const usage = row[0]!;
    const price = row[column]!;
    if (!/^\$\d+(?:\.\d+)?$/.test(price) || prices.has(usage)) {
      throw new Error(`Meta docs have invalid or duplicate ${family} ${mode} mode pricing`);
    }
    prices.set(usage, Number(price.slice(1)));
  }
  return {
    input: prices.get("Input"),
    output: prices.get("Output"),
    cache_read: prices.get("Cached input"),
  };
}

export function parseMetaModels(raw: unknown): MetaModel[] {
  const response = MetaResponse.parse(raw);
  const ids = new Set<string>();
  const models = sections(response.models, "##").flatMap((section) => {
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

export async function fetchMetaModels(fetcher: typeof fetch = fetch) {
  const [models, pricing] = await Promise.all([MODELS_ENDPOINT, PRICING_ENDPOINT].map(async (url) => {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Meta docs request failed: ${response.status} ${response.statusText}`);
    return response.text();
  }));
  return { models, pricing };
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
      model: { ...authored, limit, cost: { ...authored.cost, ...model.cost } } as SyncedModel,
    };
  },
} satisfies SyncProvider<MetaModel>;
