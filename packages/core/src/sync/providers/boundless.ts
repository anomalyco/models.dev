import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Boundless's public catalog, no key. It is the data behind https://inference.boundless.network/models.
const API_ENDPOINT = process.env.BOUNDLESS_CATALOG_URL ?? "https://inference.boundless.network/api/catalog";

const Price = z.number().nonnegative();

export const BoundlessModel = z.object({
  id: z.string().min(1),
  contextTokens: z.number().int().positive(),
  // USD per million tokens; null on a model that isn't sold (retired, or not serving).
  inputPerMillionTokens: Price.nullable(),
  cachedInputPerMillionTokens: Price.nullable(),
  outputPerMillionTokens: Price.nullable(),
  // Set once a retirement is announced; the model keeps answering until that time.
  retiresAt: z.string().optional(),
  serving: z.boolean(),
  supports: z.array(z.string()),
}).passthrough();

export type BoundlessModel = z.infer<typeof BoundlessModel>;

// A model is listed while Boundless serves it, sells it and has no retirement date. Dropping it at the announcement
// rather than at the cutoff gives the six-hourly sync time to remove it before requests start failing.
// Models without tool calling (Laya, a small classifier-style model) are left out on purpose.
export function listed(model: BoundlessModel) {
  return model.serving
    && model.retiresAt === undefined
    && model.inputPerMillionTokens !== null
    && model.outputPerMillionTokens !== null
    && model.supports.includes("tool-use");
}

// Token prices and the context window. Reasoning controls, modalities and names stay hand-written: the catalog
// doesn't state reasoning levels, and its capability labels are coarser than MIME types.
// `resolvedContext` is the file's context after the base_model merge: a window the lab file already states is not
// restated here, so override-only files stay override-only.
export function buildBoundlessModel(model: BoundlessModel, authored: ExistingModel, resolvedContext?: number): SyncedModel {
  const cached = model.cachedInputPerMillionTokens;
  const cost = {
    ...authored.cost,
    input: model.inputPerMillionTokens,
    output: model.outputPerMillionTokens,
    ...(cached === null ? {} : { cache_read: cached }),
  };
  if (resolvedContext === model.contextTokens) return { ...authored, cost } as SyncedModel;
  return { ...authored, cost, limit: { ...authored.limit, context: model.contextTokens } } as SyncedModel;
}

export const boundless = {
  id: "boundless",
  name: "Boundless",
  modelsDir: "providers/boundless/models",
  // New models need hand-written reasoning controls and modalities, so they're reported instead of created.
  skipCreates: true,
  // The catalog is authoritative for what Boundless serves: a file it no longer lists is removed.
  deleteMissing: true,
  sourceID(model) {
    return listed(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} Boundless models have no local file: ${ids.map((id) => `\`${id}\``).join(", ")}`];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Boundless catalog request failed: ${response.status} ${response.statusText}`);
    const type = response.headers.get("content-type") ?? "";
    // An error or challenge page must fail the sync, not parse as an empty catalog.
    if (!type.includes("json")) throw new Error(`Boundless catalog request returned ${type || "no content type"}, not JSON`);
    return response.json();
  },
  parseModels(raw) {
    const models = z.object({ data: z.array(BoundlessModel) }).parse(raw).data;
    // deleteMissing would otherwise remove every file.
    if (!models.some(listed)) throw new Error("Boundless returned no listed models; refusing to sync an empty catalog");
    return models;
  },
  translateModel(model, context) {
    if (!listed(model)) return undefined;
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: buildBoundlessModel(model, authored, context.existing(model.id)?.limit?.context) };
  },
} satisfies SyncProvider<BoundlessModel>;
