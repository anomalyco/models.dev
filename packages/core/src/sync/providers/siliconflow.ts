import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

export const SiliconFlowModel = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    created: z.number().int().nonnegative().optional(),
    owned_by: z.string().optional(),
  })
  .passthrough();

export const SiliconFlowResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(SiliconFlowModel).nullable(),
  })
  .passthrough();

export type SiliconFlowModel = z.infer<typeof SiliconFlowModel>;

/**
 * `/v1/models` only reports IDs. Pricing, limits and reasoning controls are
 * documented per model on the SiliconFlow site, so this sync never authors a
 * new TOML: it keeps existing files as they are and reports unseen chat IDs
 * through the missing-model issue flow for a human to measure and price.
 */
export interface SiliconFlowOptions {
  id: string;
  name: string;
  modelsDir: string;
  /** Provider API root, including `/v1`. */
  endpoint: string;
  /** Environment variable holding the API key for this host. */
  keyEnv: string;
}

export function parseSiliconFlowModels(raw: unknown): SiliconFlowModel[] {
  const response = SiliconFlowResponse.parse(raw);
  // `sub_type` is validated by the API: an unsupported value returns
  // `{"object":"list","data":null}` with a 200. Treating that as an empty
  // catalog would report every local file as missing from the source.
  if (response.data === null) {
    throw new Error("SiliconFlow returned no model list; the sub_type=chat filter is not supported by this endpoint");
  }
  // `LoRA/...` rows are published fine-tune presets over another catalog model,
  // not routes of their own.
  return response.data.filter((model) => !model.id.startsWith("LoRA/"));
}

export async function fetchSiliconFlowModels(
  options: { endpoint: string; key: string },
  fetcher: typeof fetch = fetch,
) {
  const url = `${options.endpoint.replace(/\/+$/, "")}/models?sub_type=chat`;
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${options.key}` },
  });
  if (!response.ok) {
    throw new Error(`SiliconFlow models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function defineSiliconFlow(options: SiliconFlowOptions): SyncProvider<SiliconFlowModel> {
  return {
    id: options.id,
    name: options.name,
    modelsDir: options.modelsDir,
    // The list endpoint carries no prices, limits, capabilities or modalities,
    // so a created file could not be a complete provider entry.
    skipCreates: true,
    trackMissingModels: true,
    // A key can be scoped to part of the platform, and an empty `data` array
    // passes the schema; retain local files and report them instead of deleting.
    deleteMissing: false,
    sourceID(model) {
      return model.id;
    },
    skippedNotice(ids) {
      if (ids.length === 0) return [];
      return [
        `${ids.length} ${options.name} chat models returned by the API are missing from the local catalog and require hand-authored pricing and limits.`,
        `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      ];
    },
    missingNotice(paths) {
      if (paths.length === 0) return [];
      return [
        `${paths.length} local ${options.name} models are missing from the API list and were retained; a human removes retired models.`,
      ];
    },
    async fetchModels() {
      const key = process.env[options.keyEnv];
      if (key === undefined || key.trim() === "") {
        throw new Error(`${options.name} sync requires ${options.keyEnv}`);
      }
      return fetchSiliconFlowModels({ endpoint: options.endpoint, key });
    },
    parseModels: parseSiliconFlowModels,
    translateModel(model, context) {
      const authored = context.authored(model.id);
      if (authored === undefined) return undefined;
      return { id: model.id, model: preserveAuthoredModel(options.id, model.id, authored) };
    },
  };
}

// Re-emit the file's own fields so the runner's comparison sees an unchanged
// model. `authored` is the v1 projection of a v2 file, so a v2 file is patched
// in place rather than converted back to v1.
function preserveAuthoredModel(provider: string, id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider, model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export const siliconflow = defineSiliconFlow({
  id: "siliconflow",
  name: "SiliconFlow",
  modelsDir: "providers/siliconflow/models",
  endpoint: "https://api.siliconflow.com/v1",
  keyEnv: "SILICONFLOW_API_KEY",
});

export const siliconflowCn = defineSiliconFlow({
  id: "siliconflow-cn",
  name: "SiliconFlow (China)",
  modelsDir: "providers/siliconflow-cn/models",
  endpoint: "https://api.siliconflow.cn/v1",
  keyEnv: "SILICONFLOW_CN_API_KEY",
});
