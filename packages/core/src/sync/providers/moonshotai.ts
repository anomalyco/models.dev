import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { modelMetadata } from "./openrouter.js";

// Moonshot AI: GET https://api.moonshot.ai/v1/models (MOONSHOT_API_KEY) for the context window, and the pricing page
// https://platform.kimi.ai/docs/pricing/chat for prices. The page's Markdown version has empty tables, so prices are
// read from the DocTable calls compiled into its HTML; any change to their columns or cells fails the sync.
// moonshotai-cn isn't synced: api.moonshot.cn needs a China key.
const MODELS_ENDPOINT = "https://api.moonshot.ai/v1/models";
const PRICING_ENDPOINT = "https://platform.kimi.ai/docs/pricing/chat";

const MoonshotModel = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive(),
}).passthrough();

export interface MoonshotPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: { "5m": number; "1h": number };
}


export interface MoonshotEntry {
  id: string;
  context: number;
  price?: MoonshotPrice;
}

// Context, token prices, cache read and the 5m cache write (when the file has one). Effort levels, toggles, output
// limits and per-API flags stay hand-written. The runner scales a file's other cache-write TTLs with the 5m price.
export function buildMoonshotModel(entry: MoonshotEntry, authored: ExistingModel): SyncedModel {
  const price = entry.price;
  const cost = price === undefined
    ? authored.cost
    : {
      ...authored.cost,
      input: price.input,
      output: price.output,
      cache_read: price.cacheRead,
      ...(authored.cost?.cache_write === undefined || price.cacheWrite === undefined ? {} : { cache_write: price.cacheWrite["5m"] }),
    };
  // A context equal to the lab's is inherited, not written.
  const labContext = authored.base_model === undefined
    ? undefined
    : (modelMetadata(authored.base_model).limit as { context?: number } | undefined)?.context;
  const writeContext = authored.limit?.context !== undefined || labContext !== entry.context;
  return {
    ...authored,
    ...(cost === undefined ? {} : { cost }),
    ...(writeContext ? { limit: { ...authored.limit, context: entry.context } } : {}),
  } as SyncedModel;
}

export const moonshotai = {
  id: "moonshotai",
  name: "Moonshot AI",
  modelsDir: "providers/moonshotai/models",
  // New models need toggles, output limits and API flags written by hand, so they're reported instead of created.
  skipCreates: true,
  deleteMissing: false,
  sourceID(entry) {
    return entry.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} Moonshot models have no local file: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [`${paths.length} local Moonshot models are no longer listed and were retained: ${paths.map((item) => `\`${item}\``).join(", ")}`];
  },
  async fetchModels() {
    const key = process.env.MOONSHOT_API_KEY ?? process.env.MOONSHOTAI_API_KEY;
    if (!key) throw new Error("Moonshot sync requires MOONSHOT_API_KEY");
    const [models, pricing] = await Promise.all([
      fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } }),
      fetch(PRICING_ENDPOINT),
    ]);
    if (!models.ok) throw new Error(`Moonshot models request failed: ${models.status} ${models.statusText}`);
    if (!pricing.ok) throw new Error(`Moonshot pricing request failed: ${pricing.status} ${pricing.statusText}`);
    return { models: await models.json(), pricing: await pricing.text() };
  },
  parseModels(raw) {
    const { models, pricing } = raw as { models: unknown; pricing: string };
    const list = z.object({ data: z.array(MoonshotModel).nonempty() }).passthrough().parse(models).data;
    const prices = parseMoonshotPricing(pricing);
    return list.map((model) => ({ id: model.id, context: model.context_length, ...(prices.has(model.id) ? { price: prices.get(model.id)! } : {}) }));
  },
  translateModel(entry, context) {
    const authored = context.authored(entry.id);
    if (authored === undefined) return undefined;
    return { id: entry.id, model: buildMoonshotModel(entry, authored) };
  },
} satisfies SyncProvider<MoonshotEntry>;

// The column sets the pricing tables use: K3 (with cache writes per TTL) and K2.
const COLUMNS = [
  ["Model", "Input", "Output", "Cached Input", "5m writes", "1h writes"],
  ["Model", "Input", "Output", "Cached Input"],
];

/**
 * Prices per model ID from the pricing page's compiled DocTable calls, e.g.
 * `columns:[{title:`Model`},...],rows:[[_jsx(_components.a,{href:`...`,children:`kimi-k3`}),`$3.00 / MTok`,...]]`.
 * Throws when a table's columns or cells don't have the expected shape.
 */
export function parseMoonshotPricing(html: string) {
  const prices = new Map<string, MoonshotPrice>();
  const tables = [...html.matchAll(/_jsx\(DocTable,\{(.*?)\]\]\}\)/gs)].map((match) => match[1]!);
  if (tables.length === 0) throw new Error("Moonshot pricing: no price tables");
  for (const table of tables) {
    const columnsText = /columns:\[(.*?)\],rows:\[/s.exec(table)?.[1];
    const rowsText = table.split(/,rows:\[/)[1];
    if (columnsText === undefined || rowsText === undefined) throw new Error("Moonshot pricing: a table has no columns or rows");
    const columns = [...columnsText.matchAll(/\{title:(?:`([^`]*)`|_jsx\(Tooltip,\{tip:`[^`]*`,children:`([^`]*)`\}\))/g)].map((match) => match[1] ?? match[2]!);
    if (!COLUMNS.some((expected) => JSON.stringify(expected) === JSON.stringify(columns))) {
      throw new Error(`Moonshot pricing: unexpected columns ${JSON.stringify(columns)}`);
    }
    const rows = [...`${rowsText}]`.matchAll(/\[(?:_jsx\(_components\.a,\{href:`[^`]*`,children:`([^`]+)`\}\)|`([^`]+)`)((?:,`[^`]*`)*)\]/g)];
    if (rows.length === 0 || rows.length !== (rowsText.match(/\],\[/g)?.length ?? 0) + 1) {
      throw new Error("Moonshot pricing: a table has rows the parser can't read");
    }
    for (const row of rows) {
      const id = row[1] ?? row[2]!;
      if (!/^kimi-[a-z0-9.-]+$/.test(id)) throw new Error(`Moonshot pricing: unexpected model ${JSON.stringify(id)}`);
      const cells = [...row[3]!.matchAll(/,`([^`]*)`/g)].map((match) => {
        const price = /^\$(\d+(?:\.\d+)?) \/ MTok$/.exec(match[1]!);
        if (price === null) throw new Error(`Moonshot pricing: ${id} has a cell that isn't a dollar price per MTok: ${JSON.stringify(match[1])}`);
        return Number(price[1]);
      });
      if (cells.length !== columns.length - 1) throw new Error(`Moonshot pricing: ${id} has ${cells.length} prices for ${columns.length - 1} columns`);
      if (prices.has(id)) throw new Error(`Moonshot pricing: ${id} is listed twice`);
      const [input, output, cacheRead, write5m, write1h] = cells as [number, number, number, number?, number?];
      prices.set(id, {
        input,
        output,
        cacheRead,
        ...(write5m === undefined || write1h === undefined ? {} : { cacheWrite: { "5m": write5m, "1h": write1h } }),
      });
    }
  }
  return prices;
}
