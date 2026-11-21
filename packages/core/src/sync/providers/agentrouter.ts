import { z } from "zod";

import { AuthoredModel } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://agentrouter.org/api/pricing";

export const AgentRouterModel = z.object({
  model_name: z.string().min(1),
  supported_endpoint_types: z.array(z.string().min(1)).min(1),
}).passthrough();

const AgentRouterResponse = z.object({
  success: z.literal(true),
  data: z.array(AgentRouterModel).min(1),
}).passthrough();

export type AgentRouterModel = z.infer<typeof AgentRouterModel>;

export function parseAgentRouterModels(raw: unknown) {
  const models = AgentRouterResponse.parse(raw).data;
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.model_name)) throw new Error(`Duplicate AgentRouter model ID: ${model.model_name}`);
    ids.add(model.model_name);
  }
  return models.toSorted((a, b) => a.model_name.localeCompare(b.model_name));
}

function preserveAuthoredModel(id: string, authored: ExistingModel): SyncedModel {
  if (authored.base_model !== undefined) return authored as SyncedBaseModel;

  const parsed = AuthoredModel.safeParse({ id, ...authored });
  if (!parsed.success) {
    parsed.error.cause = { provider: "agentrouter", model: id };
    throw parsed.error;
  }
  const { id: _id, ...model } = parsed.data;
  return model;
}

export async function fetchAgentRouterModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`AgentRouter pricing request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const agentrouter = {
  id: "agentrouter",
  name: "AgentRouter",
  modelsDir: "providers/agentrouter/models",
  skipCreates: true,
  trackMissingModels: true,
  // The public inventory can vary by group, so absence is not authoritative.
  deleteMissing: false,
  sourceID(model) {
    return model.model_name;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AgentRouter models returned by the pricing API are missing from the local catalog and require hand-authored metadata.`,
      `Missing remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local AgentRouter models are absent from the pricing API and were retained because availability can vary by group or account: ${paths.map((file) => `\`${file}\``).join(", ")}`,
    ];
  },
  fetchModels: fetchAgentRouterModels,
  parseModels: parseAgentRouterModels,
  translateModel(model, context) {
    const authored = context.authored(model.model_name);
    if (authored === undefined) return undefined;
    return {
      id: model.model_name,
      model: preserveAuthoredModel(model.model_name, authored),
    };
  },
} satisfies SyncProvider<AgentRouterModel>;
