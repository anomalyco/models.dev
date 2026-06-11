import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://nexus-api.dappnode.com/v1/models";
const NEXUS_BASE_MODELS: Record<string, string> = {
  "minimax/minmax-m3": "minimax/MiniMax-M3",
};
const ROUTER_COMPATIBILITY_LIMIT = {
  context: 1_048_576,
  output: 393_216,
};

const NexusModel = z.object({
  id: z.string(),
  kind: z.enum(["public_model", "router"]).optional(),
  created: z.number().optional(),
  display_name: z.string().optional(),
  context_size: z.number().optional(),
  max_output_tokens: z.number().optional(),
  input_price_per_1m_tokens_usd: z.number().optional(),
  output_price_per_1m_tokens_usd: z.number().optional(),
  cache_read_price_per_1m_tokens_usd: z.number().optional(),
  cache_write_price_per_1m_tokens_usd: z.number().optional(),
  features: z.array(z.string()).optional().default([]),
  endpoints: z.array(z.string()).optional().default([]),
}).passthrough();

export const NexusResponse = z.object({
  data: z.array(NexusModel),
}).passthrough();

export type NexusModel = z.infer<typeof NexusModel>;

export const nexus = {
  id: "nexus",
  name: "Nexus",
  modelsDir: "providers/nexus/models",
  async fetchModels() {
    return fetchNexusModels();
  },
  parseModels(raw) {
    return NexusResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.id;
  },
  translateModel(model, context) {
    if (!model.endpoints.includes("chat/completions")) return undefined;
    return {
      id: model.id,
      model: buildNexusModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<NexusModel>;

export async function fetchNexusModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Nexus request failed: ${response.status} ${response.statusText}`);
  }
  return NexusResponse.parse(await response.json());
}

export function buildNexusModel(
  model: NexusModel,
  existing: ExistingModel | undefined,
  today = new Date().toISOString().slice(0, 10),
): SyncedModel {
  const features = new Set(model.features);
  const isPrivateModel = model.id.startsWith("private/");
  const name = privateName(model.display_name ?? existing?.name ?? model.id, isPrivateModel);
  const isRouter = model.kind === "router" || features.has("routing");
  const context = model.context_size
    ?? (isRouter ? ROUTER_COMPATIBILITY_LIMIT.context : existing?.limit?.context)
    ?? 0;
  const output = model.max_output_tokens
    ?? (isRouter ? ROUTER_COMPATIBILITY_LIMIT.output : existing?.limit?.output)
    ?? context;
  const limit = { context, input: existing?.limit?.input, output };
  const modalities = existing?.modalities ?? {
    input: ["text"] as const,
    output: ["text"] as const,
  };
  const releaseDate = dateFromTimestamp(model.created) ?? existing?.release_date ?? today;
  const cost = isRouter ? undefined : buildCost(model, existing?.cost);
  const canonical = resolveNexusBaseModel(model.id, existing?.base_model);

  const values: Partial<SyncedFullModel> = {
    name,
    attachment: existing?.attachment ?? modalities.input.some((value) => value !== "text"),
    reasoning: isRouter || features.has("reasoning"),
    temperature: existing?.temperature ?? true,
    tool_call: isRouter || features.has("function-calling") || features.has("parallel-tool-calls"),
    structured_output: isRouter || features.has("structured-outputs"),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities,
  };

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      values,
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    family: existing?.family ?? (isRouter ? "auto" : undefined),
    release_date: releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment: values.attachment ?? false,
    reasoning: values.reasoning ?? false,
    temperature: values.temperature,
    tool_call: values.tool_call ?? false,
    structured_output: values.structured_output,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities,
  } satisfies SyncedFullModel;
}

function dateFromTimestamp(timestamp: number | undefined) {
  if (timestamp === undefined || timestamp <= 0) return undefined;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function resolveNexusBaseModel(id: string, existingBaseModel: string | undefined) {
  if (id.startsWith("private/")) return undefined;
  return existingBaseModel ?? NEXUS_BASE_MODELS[id] ?? resolveCanonicalBaseModel(id);
}

function privateName(name: string, isPrivateModel: boolean) {
  if (!isPrivateModel || name.endsWith(" - Private")) return name;
  return `${name} - Private`;
}

function buildCost(model: NexusModel, existing: ExistingModel["cost"]) {
  const input = price(model.input_price_per_1m_tokens_usd);
  const output = price(model.output_price_per_1m_tokens_usd);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    reasoning: existing?.reasoning,
    cache_read: price(model.cache_read_price_per_1m_tokens_usd),
    cache_write: price(model.cache_write_price_per_1m_tokens_usd),
    tiers: existing?.tiers,
  };
}

function price(value: number | undefined) {
  if (value === undefined) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}
