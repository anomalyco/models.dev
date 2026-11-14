import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// The public price list the OpenCheap site, model pages and llms.txt read. No
// key. `ours` is the price OpenCheap bills per 1M tokens for each model.
const API_ENDPOINT = "https://opencheap.si/api/prices";

const Usd = z.number().nonnegative();

const LongContextTier = z
  .object({ aboveTokens: z.number().int().positive() })
  .passthrough();

export const OpenCheapModel = z
  .object({
    id: z.string(),
    contextLength: z.number().int().nullish(),
    ours: z
      .object({
        promptUsd: Usd.nullish(),
        completionUsd: Usd.nullish(),
        cacheReadUsd: Usd.nullish(),
        longContext: z.array(LongContextTier).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const OpenCheapResponse = z.object({ models: z.array(OpenCheapModel) }).passthrough();

export type OpenCheapModel = z.infer<typeof OpenCheapModel>;

export const opencheap = {
  id: "opencheap",
  name: "OpenCheap",
  modelsDir: "providers/opencheap/models",
  // The list carries every model OpenCheap routes (closed and open), but the
  // catalog lists a hand-picked subset whose capabilities were checked live.
  // The list has no capability data, so the sync only reprices those files:
  // it never creates one and opens no issues for the rest.
  skipCreates: true,
  trackMissingModels: false,
  // An unauthenticated list; one truncated 200 must not delete checked files.
  deleteMissing: false,
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local OpenCheap models are missing from ${API_ENDPOINT} and were retained; a human removes retired models: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchOpenCheapModels();
  },
  parseModels(raw) {
    return OpenCheapResponse.parse(raw).models.filter((model) => model.id.trim() !== "");
  },
  translateModel(model, context) {
    const authored = context.authored(model.id);
    // Only models that already have a file are synced (see skipCreates).
    if (authored === undefined) return undefined;
    return buildOpenCheapModel(model, authored, context.existing(model.id));
  },
} satisfies SyncProvider<OpenCheapModel>;

export async function fetchOpenCheapModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`OpenCheap price list request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Patch the authored file with the list's prices. Everything else stays as
 * authored: capabilities, cache support, APIs and the base_model pointer.
 *
 * - Input and output prices follow `ours`. A model with no positive price on
 *   the list keeps its authored prices (a routeless model, not a free one).
 * - A cache-read price is kept current only where the file already lists one:
 *   those files declare caching that was confirmed live, and the list prices a
 *   cache read on routes that report no cached tokens.
 * - limit.context follows the list only where the file already overrides the
 *   lab's window. Elsewhere a list window below the inherited one is reported.
 */
export function buildOpenCheapModel(
  model: OpenCheapModel,
  authored: ExistingModel,
  resolved: ExistingModel | undefined,
): { id: string; model: SyncedModel; notices?: string[] } {
  const notices: string[] = [];
  const ours = model.ours ?? undefined;
  const input = ours?.promptUsd ?? 0;
  const output = ours?.completionUsd ?? 0;

  let cost = authored.cost;
  if (input > 0 && output > 0) {
    const { cache_read: authoredCacheRead, ...rest } = authored.cost ?? {};
    const cacheRead = authoredCacheRead === undefined ? undefined : ours?.cacheReadUsd ?? authoredCacheRead;
    cost = {
      ...rest,
      input,
      output,
      ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    } as ExistingModel["cost"];
  } else {
    notices.push(`OpenCheap: \`${model.id}\` has no positive price on the list; kept the authored prices.`);
  }

  if ((ours?.longContext?.length ?? 0) > 0) {
    notices.push(`OpenCheap: \`${model.id}\` lists long-context prices above ${ours!.longContext!.map((tier) => tier.aboveTokens).join(", ")} tokens, which this sync does not author.`);
  }

  const listContext = model.contextLength ?? 0;
  let limit = authored.limit;
  if (listContext > 0) {
    if (authored.limit?.context !== undefined) {
      limit = { ...authored.limit, context: listContext } as ExistingModel["limit"];
    } else {
      const inherited = resolved?.limit?.context;
      if (inherited !== undefined && listContext < inherited) {
        notices.push(`OpenCheap: \`${model.id}\` serves a ${listContext}-token window but inherits ${inherited} from its lab file; author limit.context.`);
      }
    }
  }

  return {
    id: model.id,
    model: { ...authored, cost, ...(limit === undefined ? {} : { limit }) } as SyncedModel,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
