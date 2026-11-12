// Moonshot AI: https://api.moonshot.ai/v1/models (MOONSHOT_API_KEY) and the
// pricing page https://platform.kimi.ai/docs/pricing/chat. The page's Markdown
// version has empty tables, so the prices are read from the DocTable calls
// compiled into its HTML; any change to their columns or cells stops the sync.
// Authoritative: the context window, image and video input, effort levels and
// the default effort (from /models), and token, cache-hit and cache write
// prices per TTL (from the pricing tables). Toggles, output limits and per-API
// tool flags stay hand-authored, so new models are added by hand. A model
// /models stops listing is marked deprecated.
// moonshotai-cn isn't synced: api.moonshot.cn needs a China key.

import { z } from "zod";

import { bearer, fetchJSON, fetchText, requireEnv } from "../http.js";
import type { Observation, SyncModule } from "../types.js";
import { reasoningControls } from "../units.js";

const MODELS_ENDPOINT = "https://api.moonshot.ai/v1/models";
const PRICING_ENDPOINT = "https://platform.kimi.ai/docs/pricing/chat";

const MoonshotModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  context_length: z.number().int().positive(),
  modalities: z.object({ input: z.array(z.string()).nonempty(), output: z.array(z.string()).nonempty() }).passthrough(),
  supports_reasoning: z.boolean().optional(),
  reasoning: z.object({
    type: z.string(),
    effort: z.object({ valid: z.array(z.string()).nonempty(), default: z.string() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
type MoonshotModel = z.infer<typeof MoonshotModel>;

const MoonshotRaw = z.object({
  models: z.object({ object: z.literal("list"), data: z.array(MoonshotModel).nonempty() }).passthrough(),
  pricing: z.string(),
});

export interface MoonshotPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: { "5m": number; "1h": number };
}

export const moonshotai: SyncModule<unknown> = {
  id: "moonshotai",
  name: "Moonshot AI",
  policy: {
    owns: [
      "limit.context",
      { path: "modalities.input", merge: "kinds", only: ["image", "audio", "video"] },
      "capabilities.reasoning.effort",
      "capabilities.reasoning.default",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "gap",
    removals: "deprecate",
  },
  async fetch() {
    const key = requireEnv("Moonshot AI", "MOONSHOT_API_KEY", "MOONSHOTAI_API_KEY");
    const [models, pricing] = await Promise.all([
      fetchJSON(MODELS_ENDPOINT, { source: "Moonshot models", headers: bearer(key) }),
      fetchText(PRICING_ENDPOINT, { source: "Moonshot pricing" }),
    ]);
    return { models, pricing };
  },
  observe(raw) {
    const { models, pricing } = MoonshotRaw.parse(raw);
    const prices = parseMoonshotPricing(pricing);
    return models.data.map((model) => observe(model, prices.get(model.id)));
  },
};

function observe(model: MoonshotModel, price: MoonshotPrice | undefined): Observation {
  const effort = model.reasoning?.effort;
  if (effort !== undefined && !effort.valid.includes(effort.default)) {
    throw new Error(`Moonshot ${model.id}: default effort ${effort.default} isn't one of its levels`);
  }
  return {
    id: model.id,
    limit: { context: model.context_length },
    modalities: { input: model.modalities.input.map((value) => value.toLowerCase()) },
    // K2 models list no efforts; their toggles are the file's.
    ...(effort === undefined
      ? {}
      : {
        capabilities: {
          reasoning: {
            effort: reasoningControls({ effort: effort.valid }).effort!,
            default: { type: "effort", value: effort.default as never },
          },
        },
      }),
    ...(price === undefined
      ? {}
      : {
        cost: {
          text: {
            input: { price: price.input, cache: { read: price.cacheRead, write: price.cacheWrite ?? null } },
            output: { price: price.output },
          },
        },
      }),
  };
}

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
