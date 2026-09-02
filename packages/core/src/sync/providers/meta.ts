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

function cells(line: string) {
  return line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
}

function table(markdown: string, header: string[]) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => JSON.stringify(cells(line)) === JSON.stringify(header));
  if (start < 0) throw new Error(`Meta docs are missing the ${header.join(" / ")} table`);
  const separator = cells(lines[start + 1] ?? "");
  if (separator.length !== header.length || separator.some((cell) => !/^:?-+:?$/.test(cell))) {
    throw new Error("Meta docs have an invalid table separator");
  }
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    if (row.length !== header.length) throw new Error("Meta docs have an invalid table row");
    rows.push(row);
  }
  if (rows.length === 0) throw new Error("Meta docs table is empty");
  return rows;
}

function tierCost(markdown: string, tier: string) {
  const sections = markdown.split(/^### /m).filter((section) => section.split("\n")[0]?.includes(`{#${tier}}`));
  if (sections.length !== 1) throw new Error(`Meta docs need exactly one pricing section for ${tier}`);
  const prices = new Map<string, number>();
  for (const [usage, price] of table(sections[0]!, ["Usage", "Price per 1M tokens"])) {
    if (!/^\$\d+(?:\.\d+)?$/.test(price!) || prices.has(usage!)) {
      throw new Error(`Meta docs have invalid or duplicate ${tier} pricing`);
    }
    prices.set(usage!, Number(price!.slice(1)));
  }
  return {
    input: prices.get("Input"),
    output: prices.get("Output"),
    cache_read: prices.get("Cached input"),
  };
}

export function parseMetaModels(raw: unknown): MetaModel[] {
  const response = MetaResponse.parse(raw);
  const rows = table(response.models, ["Model ID", "Tier", "Input modalities", "Output modalities", "Context window"]);
  const ids = new Set<string>();
  return rows.map(([model, tierLink, _input, output, window]) => {
    const id = model?.match(/^`([^`]+)`$/)?.[1];
    const tier = tierLink?.match(/^\[[^\]]+\]\([^)]*#([a-z-]+)\)$/)?.[1];
    const tokens = window?.match(/^(\d+|\d{1,3}(?:,\d{3})+) tokens$/)?.[1];
    if (id === undefined || tier === undefined || tokens === undefined || output !== "Text") {
      throw new Error("Meta docs have an unsupported token-priced model row");
    }
    if (ids.has(id)) throw new Error(`Meta docs have a duplicate model: ${id}`);
    ids.add(id);
    const parsed = MetaModel.safeParse({
      id,
      context: Number(tokens.replaceAll(",", "")),
      cost: tierCost(response.pricing, tier),
    });
    if (!parsed.success) {
      parsed.error.cause = { provider: "meta", model: id };
      throw parsed.error;
    }
    return parsed.data;
  });
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
