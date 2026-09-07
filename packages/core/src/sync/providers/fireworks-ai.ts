import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.fireworks.ai/v1/serverless/models";

const FireworksPrice = z.object({
  sku: z.string().min(1),
  amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  unit: z.literal("1M tokens"),
}).passthrough();

export const FireworksModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  serverless_mode: z.string().min(1),
  service_tier: z.string().min(1).optional(),
  usage_identifier: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  pricing: z.array(FireworksPrice),
  display_name: z.string().min(1),
  description: z.string(),
  context_length: z.number().int().positive().optional(),
  use_cases: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  created: z.number().int().nonnegative(),
}).passthrough();

export const FireworksResponse = z.object({
  object: z.literal("list"),
  data: z.array(FireworksModel),
}).passthrough();

export type FireworksModel = z.infer<typeof FireworksModel>;
export type FireworksCatalogModel = FireworksModel & {
  catalogId: string;
  flagModes: FireworksModel[];
};

export const fireworksAi = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  modelsDir: "providers/fireworks-ai/models",
  skipCreates: true,
  // The endpoint describes the public serverless catalog, but it still lacks
  // enough intrinsic metadata and reasoning controls to create safe entries.
  deleteMissing: false,
  sourceID(model) {
    return supportsCatalogModel(model) ? model.catalogId : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Fireworks serverless text/vision IDs were not created because the endpoint does not yet provide output limits, reasoning controls, tool support, or open-weight status. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Fireworks models were absent from the serverless catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.FIREWORKS_API_KEY;
    if (key === undefined) throw new Error("Fireworks AI sync requires FIREWORKS_API_KEY");
    return fetchFireworksModels(key);
  },
  parseModels(raw) {
    return expandFireworksModels(FireworksResponse.parse(raw).data);
  },
  translateModel(model, context) {
    if (!supportsCatalogModel(model)) return undefined;
    const existing = context.existing(model.catalogId);
    if (existing === undefined) return undefined;
    return {
      id: model.catalogId,
      model: buildFireworksModel(model, existing),
    };
  },
} satisfies SyncProvider<FireworksCatalogModel>;

export async function fetchFireworksModels(
  key: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(API_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Fireworks AI models request failed: ${response.status} ${response.statusText}`);
  }
  return FireworksResponse.parse(await response.json());
}

export function expandFireworksModels(models: FireworksModel[]): FireworksCatalogModel[] {
  const expanded = new Map<string, FireworksCatalogModel>();
  const grouped = Map.groupBy(models, (model) => model.id);
  for (const rows of grouped.values()) {
    const defaultRow = rows.find((model) =>
      model.usage_identifier === undefined && model.service_tier === undefined
    );
    const flagModes = rows.filter((model) => model.service_tier !== undefined);

    // A default row owns the base model ID and exposes flag-based paths such as
    // Priority as experimental modes. A priority-only model still needs to be
    // discoverable, so its service-tier recipe becomes the base invocation.
    const baseRow = defaultRow ?? flagModes[0];
    if (baseRow !== undefined) add(baseRow.id, baseRow, defaultRow === undefined ? [] : flagModes);

    for (const model of rows) {
      if (model.usage_identifier !== undefined) add(model.usage_identifier, model, []);
      for (const alias of model.aliases ?? []) add(alias, model, []);
    }
  }
  return [...expanded.values()];

  function add(catalogId: string, model: FireworksModel, flagModes: FireworksModel[]) {
    if (!expanded.has(catalogId)) expanded.set(catalogId, { ...model, catalogId, flagModes });
  }
}

function supportsCatalogModel(model: FireworksCatalogModel) {
  return model.output_modalities.includes("text");
}

type Modality = SyncedFullModel["modalities"]["input"][number];

const MODALITIES = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);

function catalogModalities(values: string[], fallback: Modality[]): Modality[] {
  const modalities = values.filter((value): value is Modality => MODALITIES.has(value as Modality));
  return modalities.length === 0 ? fallback : modalities;
}

function pricing(model: Pick<FireworksModel, "pricing">, existing: NonNullable<SyncedFullModel["cost"]>) {
  const bySku = new Map(model.pricing.map((price) => [price.sku, Number(price.amount)]));
  return {
    ...existing,
    input: bySku.get("LLM input tokens (uncached)") ?? existing.input,
    cache_read: bySku.get("LLM input tokens (cached)") ?? existing.cache_read,
    output: bySku.get("LLM output tokens") ?? existing.output,
  };
}

function provider(
  model: FireworksCatalogModel,
  existing: ExistingModel["provider"],
): ExistingModel["provider"] {
  if (model.service_tier !== undefined) {
    return {
      ...existing,
      body: {
        ...existing?.body,
        service_tier: model.service_tier,
      },
    };
  }
  if (existing === undefined) return undefined;

  const body = { ...existing.body };
  delete body.service_tier;
  const result = { ...existing };
  if (Object.keys(body).length === 0) delete result.body;
  else result.body = body;
  return Object.keys(result).length === 0 ? undefined : result;
}

function experimental(
  model: FireworksCatalogModel,
  cost: NonNullable<SyncedFullModel["cost"]>,
  existing: ExistingModel["experimental"],
): ExistingModel["experimental"] {
  const modes = { ...existing?.modes };
  // Priority is currently the only Fireworks flag-based serverless mode. The
  // endpoint is authoritative for its availability as well as its pricing.
  delete modes.priority;
  for (const mode of model.flagModes) {
    modes[mode.serverless_mode] = {
      cost: pricing(mode, cost),
      provider: { body: { service_tier: mode.service_tier! } },
    };
  }
  if (Object.keys(modes).length === 0) return undefined;
  return {
    ...existing,
    modes,
  };
}

export function buildFireworksModel(
  model: FireworksCatalogModel,
  existing: ExistingModel,
): SyncedModel {
  const name = existing.name;
  const description = existing.description;
  const releaseDate = existing.release_date;
  const lastUpdated = existing.last_updated;
  const reasoning = existing.reasoning;
  const toolCall = existing.tool_call;
  const openWeights = existing.open_weights;
  const limit = existing.limit;
  const modalities = existing.modalities;
  const cost = existing.cost;

  if (
    name === undefined
    || description === undefined
    || releaseDate === undefined
    || lastUpdated === undefined
    || reasoning === undefined
    || toolCall === undefined
    || openWeights === undefined
    || limit === undefined
    || limit.context === undefined
    || limit.output === undefined
    || modalities === undefined
    || cost === undefined
  ) {
    throw new Error(`Fireworks AI model ${model.catalogId} has incomplete local TOML metadata required for sync`);
  }

  const input = catalogModalities(model.input_modalities, modalities.input);
  const outputModalities = catalogModalities(model.output_modalities, modalities.output);
  // Fireworks reports the advertised context window, while some deployments
  // reserve a few prompt tokens. Preserve a smaller verified local cap, but
  // immediately follow any lower ceiling reported by the API.
  const context = model.context_length === undefined
    ? limit.context
    : Math.min(limit.context, model.context_length);
  const output = Math.min(limit.output, context);
  const values = {
    name,
    description,
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment: input.some((modality) => modality !== "text"),
    reasoning,
    reasoning_options: existing.reasoning_options,
    temperature: existing.temperature,
    tool_call: toolCall,
    structured_output: existing.structured_output,
    knowledge: existing.knowledge,
    open_weights: openWeights,
    status: existing.status,
    interleaved: existing.interleaved,
    cost: pricing(model, cost),
    limit: {
      context,
      input: limit.input,
      output,
    },
    modalities: {
      input,
      output: outputModalities,
    },
    provider: provider(model, existing.provider),
    experimental: experimental(model, cost, existing.experimental),
  } satisfies SyncedFullModel;

  return existing.base_model === undefined
    ? values
    : factorBaseModel(existing.base_model, values, values.limit, existing.base_model_omit);
}
