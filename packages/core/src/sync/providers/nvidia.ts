import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

// Both are public and need no key.
const API_ENDPOINT = "https://integrate.api.nvidia.com/v1/models";
const CATALOG_ENDPOINT = "https://build.nvidia.com/models.md";

const NvidiaApiModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
}).passthrough();

const NvidiaResponse = z.object({
  models: z.object({ object: z.literal("list"), data: z.array(NvidiaApiModel) }).passthrough(),
  catalog: z.string(),
});

export interface NvidiaModel {
  id: string;
  /** The model also has a page in the build.nvidia.com catalog. */
  listed: boolean;
}

// The catalog links each model page by a slug that has no publisher and spells dots three ways
// (`kimi-k3_1-pro`, `glm-5-3-flash`, `laguna-xs-2.1`), so both sides are compared with `.` and `_` as `-`.
const slug = (name: string) => name.toLowerCase().replace(/[._]/g, "-");

export function parseNvidiaCatalog(markdown: string) {
  return new Set([...markdown.matchAll(/\]\(\/[^/)\s]+\/([^/)\s]+)\.md\)/g)].map((match) => slug(match[1]!)));
}

// GET /v1/models keeps retired IDs and omits live ones (see providers/nvidia/provider.toml), so on its own it can't
// say a model is live. An ID is reported only when the catalog lists a page for it as well.
export function parseNvidiaModels(raw: unknown): NvidiaModel[] {
  const { models, catalog } = NvidiaResponse.parse(raw);
  if (models.data.length === 0) throw new Error("NVIDIA returned no models; refusing to sync an empty list");
  const listed = parseNvidiaCatalog(catalog);
  if (listed.size === 0) throw new Error("NVIDIA catalog page listed no models; its format may have changed");
  return models.data.map((model) => ({
    id: model.id,
    listed: listed.has(slug(model.id.slice(model.id.lastIndexOf("/") + 1))),
  }));
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "nvidia", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchNvidiaModels(fetcher: typeof fetch = fetch) {
  const [models, catalog] = await Promise.all([fetcher(API_ENDPOINT), fetcher(CATALOG_ENDPOINT)]);
  if (!models.ok) throw new Error(`NVIDIA models request failed: ${models.status} ${models.statusText}`);
  if (!catalog.ok) throw new Error(`NVIDIA catalog request failed: ${catalog.status} ${catalog.statusText}`);
  return { models: await models.json(), catalog: await catalog.text() };
}

export const nvidia = {
  id: "nvidia",
  name: "Nvidia",
  modelsDir: "providers/nvidia/models",
  // Neither source gives limits or reasoning controls, so new models are reported instead of created.
  skipCreates: true,
  trackMissingModels: true,
  // The API omits live models, so a local file missing from it is kept.
  deleteMissing: false,
  sourceID(model) {
    return model.listed ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} NVIDIA models returned by the API and listed in the catalog are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchNvidiaModels();
  },
  parseModels: parseNvidiaModels,
  translateModel(model, context) {
    const authored = context.authored(model.id);
    if (authored === undefined) return undefined;
    return { id: model.id, model: preserveAuthoredModel(model.id, authored) };
  },
} satisfies SyncProvider<NvidiaModel>;
