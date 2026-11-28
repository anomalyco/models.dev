import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";

// Boundless's public catalog, no key. It is the data behind https://inference.boundless.network/models.
const API_ENDPOINT = process.env.BOUNDLESS_CATALOG_URL ?? "https://inference.boundless.network/api/catalog";

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");

const Price = z.number().nonnegative();

export const BoundlessModel = z.object({
  id: z.string().min(1),
  contextTokens: z.number().int().positive(),
  // USD per million tokens; null on a model that isn't sold (retired, or not serving).
  inputPerMillionTokens: Price.nullable(),
  cachedInputPerMillionTokens: Price.nullable(),
  outputPerMillionTokens: Price.nullable(),
  // Set once a retirement is announced; the model keeps answering until that time.
  retiresAt: z.string().datetime({ offset: true }).optional(),
  serving: z.boolean(),
  supports: z.array(z.string()),
}).passthrough();

export type BoundlessModel = z.infer<typeof BoundlessModel>;

// A model is listed while Boundless serves it and sells it, up to its retirement time: a model with a retirement
// announced keeps answering until then, so its file stays, marked deprecated, and is removed once the time passes.
// Models without tool calling (Laya, a small classifier-style model) are left out on purpose.
export function listed(model: BoundlessModel, now = Date.now()) {
  return model.serving
    && (model.retiresAt === undefined || Date.parse(model.retiresAt) > now)
    && model.inputPerMillionTokens !== null
    && model.outputPerMillionTokens !== null
    && model.supports.includes("tool-use");
}

function labLimit(baseModel: string | undefined): { context?: number; input?: number } {
  if (baseModel === undefined) return {};
  try {
    const lab = Bun.TOML.parse(readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8")) as { limit?: Record<string, unknown> };
    const number = (value: unknown) => (typeof value === "number" ? value : undefined);
    return { context: number(lab.limit?.context), input: number(lab.limit?.input) };
  } catch {
    return {};
  }
}

// Token prices, the context window and the retirement status. Reasoning controls, modalities and names stay
// hand-written: the catalog doesn't state reasoning levels, and its capability labels are coarser than MIME types.
// `resolvedContext` is the file's context after the base_model merge: a window the lab file already states is not
// restated here, so override-only files stay override-only.
// `lab` is the base model's limit. Boundless can serve a smaller window than the lab, and an input limit can't exceed
// the context, so the lab's `limit.input` is omitted while it does. The omit is worked out again each run, and a
// context the sync wrote goes once the window matches the lab's again.
export function buildBoundlessModel(
  model: BoundlessModel,
  authored: ExistingModel,
  resolvedContext?: number,
  lab = labLimit(authored.base_model),
): SyncedModel {
  const cached = model.cachedInputPerMillionTokens;
  const cost = {
    ...authored.cost,
    input: model.inputPerMillionTokens,
    output: model.outputPerMillionTokens,
    ...(cached === null ? {} : { cache_read: cached }),
  };
  const status = model.retiresAt === undefined ? authored.status : "deprecated";
  const ownInput = authored.limit?.input;
  const window = model.contextTokens;
  // A stale window the lab file now gives is dropped; one that already resolves to the catalog's stays as written.
  const context = lab.context === window && authored.limit?.context !== window
    ? undefined
    : resolvedContext === window ? authored.limit?.context : window;
  const limit = {
    ...authored.limit,
    context,
    ...(ownInput === undefined ? {} : { input: Math.min(ownInput, model.contextTokens) }),
  };
  const stated = Object.fromEntries(Object.entries(limit).filter(([, value]) => value !== undefined));
  const built = { ...authored, cost, status, limit: Object.keys(stated).length > 0 ? stated : undefined };
  if (authored.base_model === undefined) return built as SyncedModel;
  const dropInput = ownInput === undefined && lab.input !== undefined && lab.input > model.contextTokens;
  const others = (authored.base_model_omit ?? []).filter((key) => key !== "limit.input");
  // An empty list still replaces the file's own, so the omit goes once the window fits again.
  return { ...built, base_model_omit: [...others, ...(dropInput ? ["limit.input"] : [])] } as SyncedModel;
}

export const boundless = {
  id: "boundless",
  name: "Boundless",
  modelsDir: "providers/boundless/models",
  // New models need hand-written reasoning controls and modalities, so they're reported instead of created.
  skipCreates: true,
  // The catalog is authoritative for what Boundless serves: a file it no longer lists, or whose retirement time has
  // passed, is removed.
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
