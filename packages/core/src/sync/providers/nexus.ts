import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://nexus-api.dappnode.com/v1/models";
const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const ROUTER_COMPATIBILITY_LIMIT = {
  context: 1_048_576,
  output: 393_216,
};
let modelMetadataIDs: Set<string> | undefined;
let modelMetadataIDsByModelID: Map<string, string[]> | undefined;

const NexusModel = z.object({
  id: z.string(),
  base_model: z.string().optional(),
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
  const canonical = resolveNexusBaseModel(model.id, model.base_model, existing?.base_model);
  const reasoning = isRouter || features.has("reasoning");
  const authoredModalities = existing?.modalities ?? (canonical === undefined ? modalities : undefined);

  const values: Partial<SyncedFullModel> = {
    name,
    attachment: existing?.attachment ?? authoredModalities?.input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: nexusReasoningOptions(model.id, reasoning, existing),
    temperature: existing?.temperature ?? true,
    tool_call: isRouter || features.has("function-calling") || features.has("parallel-tool-calls"),
    structured_output: isRouter || features.has("structured-outputs"),
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: authoredModalities,
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
    reasoning_options: values.reasoning_options,
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

function resolveNexusBaseModel(
  id: string,
  apiBaseModel: string | undefined,
  existingBaseModel: string | undefined,
) {
  if (apiBaseModel !== undefined) {
    return canonicalNexusBaseModel(apiBaseModel) ?? existingBaseModel;
  }

  return existingBaseModel ?? (id.startsWith("private/") ? undefined : canonicalNexusBaseModel(id));
}

function canonicalNexusBaseModel(baseModel: string | undefined) {
  if (baseModel === undefined) return undefined;
  return resolveCanonicalBaseModel(baseModel)
    ?? (modelMetadataExists(baseModel) ? baseModel : undefined)
    ?? uniqueModelMetadataID(baseModel);
}

function modelMetadataExists(modelID: string) {
  return modelMetadataIDSet().has(modelID) || existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

function uniqueModelMetadataID(baseModel: string) {
  const matches = new Set<string>();
  for (const alias of modelIDAliases(baseModel)) {
    for (const match of modelMetadataIDMap().get(alias) ?? []) matches.add(match);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function modelIDAliases(value: string) {
  const cleanValue = value.replace(/:free$/, "");
  const [, ...parts] = cleanValue.split("/");
  const modelID = (parts.length > 0 ? parts.join("/") : cleanValue).toLowerCase();
  const aliases = new Set<string>();

  const add = (alias: string) => {
    if (alias.length === 0) return;
    aliases.add(alias);
    aliases.add(compactModelID(alias));
  };

  add(modelID);
  for (const suffix of ["-it", "-instruct"]) {
    if (modelID.endsWith(suffix)) add(modelID.slice(0, -suffix.length));
  }

  return aliases;
}

function compactModelID(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelMetadataIDSet() {
  loadModelMetadataIDs();
  return modelMetadataIDs!;
}

function modelMetadataIDMap() {
  loadModelMetadataIDs();
  return modelMetadataIDsByModelID!;
}

function loadModelMetadataIDs() {
  if (modelMetadataIDs !== undefined && modelMetadataIDsByModelID !== undefined) return;

  modelMetadataIDs = new Set();
  modelMetadataIDsByModelID = new Map();

  for (const provider of readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const model of readdirSync(path.join(MODELS_DIR, provider.name), { withFileTypes: true })) {
      if (!model.isFile() || !model.name.endsWith(".toml")) continue;

      const modelID = model.name.slice(0, -".toml".length);
      const metadataID = `${provider.name}/${modelID}`;
      modelMetadataIDs.add(metadataID);

      for (const key of modelIDAliases(modelID)) {
        const matches = modelMetadataIDsByModelID.get(key) ?? [];
        matches.push(metadataID);
        modelMetadataIDsByModelID.set(key, matches);
      }
    }
  }
}

function privateName(name: string, isPrivateModel: boolean) {
  if (!isPrivateModel || name.startsWith("Private ") || name.endsWith(" - Private")) return name;
  return `${name} - Private`;
}

function nexusReasoningOptions(
  id: string,
  reasoning: boolean,
  existing: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  if (existing?.reasoning_options !== undefined) return existing.reasoning_options;
  if (!reasoning) return [];
  if (id.startsWith("deepseek/")) {
    return [
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh"] },
    ];
  }
  if (id === "minimax/minmax-m3" || id.startsWith("moonshotai/") || id.startsWith("nexus/")) {
    return [{ type: "toggle" }];
  }
  return [];
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
