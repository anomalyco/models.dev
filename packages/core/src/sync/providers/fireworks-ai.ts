import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.fireworks.ai/v1/serverless/models";
const INVENTORY_ENDPOINT = "https://api.fireworks.ai/v1/accounts/fireworks/models";

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

export const FireworksInventoryModel = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  supportsServerless: z.boolean(),
}).passthrough();

export const FireworksInventoryResponse = z.object({
  models: z.array(FireworksInventoryModel),
  nextPageToken: z.string().optional(),
}).passthrough();

const FireworksSyncResponse = z.object({
  serverless: FireworksResponse,
  inventory: z.array(FireworksInventoryModel),
});

export type FireworksModel = z.infer<typeof FireworksModel>;
export type FireworksInventoryModel = z.infer<typeof FireworksInventoryModel>;
export type FireworksCatalogModel = FireworksModel & {
  catalogId: string;
  flagModes: FireworksModel[];
};
export type FireworksInventoryCatalogModel = {
  catalogId: string;
  inventoryOnly: true;
};

type FireworksSourceModel = FireworksCatalogModel | FireworksInventoryCatalogModel;

export const fireworksAi = {
  id: "fireworks-ai",
  name: "Fireworks AI",
  modelsDir: "providers/fireworks-ai/models",
  skipCreates: true,
  // The pricing feed supplies invocation IDs and serving modes, while List
  // Models fills inventory gaps. A model absent from both is not serverless.
  deleteMissing: true,
  sourceID(model) {
    return supportsCatalogModel(model) ? model.catalogId : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Fireworks serverless text/vision IDs were not created because the sources do not yet provide enough output limits, reasoning controls, tool support, or open-weight status. Existing models are still updated from API-authoritative fields.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const key = process.env.FIREWORKS_API_KEY;
    if (key === undefined) throw new Error("Fireworks AI sync requires FIREWORKS_API_KEY");
    const [serverless, inventory] = await Promise.all([
      fetchFireworksModels(key),
      fetchFireworksInventory(key),
    ]);
    return { serverless, inventory };
  },
  parseModels(raw) {
    const parsed = FireworksSyncResponse.parse(raw);
    return mergeFireworksModels(parsed.serverless.data, parsed.inventory);
  },
  translateModel(model, context) {
    if (!supportsCatalogModel(model)) return undefined;
    const existing = context.existing(model.catalogId);
    if (existing === undefined) return undefined;
    const authored = context.authored(model.catalogId);
    if ("inventoryOnly" in model && authored === undefined) {
      throw new Error(`Fireworks AI model ${model.catalogId} has no local TOML to preserve`);
    }
    if ("inventoryOnly" in model) {
      // The shared runner validates translated models before writing them.
      return { id: model.catalogId, model: authored as SyncedModel };
    }
    return {
      id: model.catalogId,
      model: buildFireworksModel(model, existing),
    };
  },
} satisfies SyncProvider<FireworksSourceModel>;

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

export async function fetchFireworksInventory(
  key: string,
  fetcher: typeof fetch = fetch,
  pageToken?: string,
): Promise<FireworksInventoryModel[]> {
  const url = new URL(INVENTORY_ENDPOINT);
  url.searchParams.set("filter", "supports_serverless=true");
  url.searchParams.set("pageSize", "200");
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Fireworks AI inventory request failed: ${response.status} ${response.statusText}`);
  }
  const page = FireworksInventoryResponse.parse(await response.json());
  if (page.nextPageToken === undefined || page.nextPageToken.length === 0) return page.models;
  return [...page.models, ...await fetchFireworksInventory(key, fetcher, page.nextPageToken)];
}

export function mergeFireworksModels(
  serverless: FireworksModel[],
  inventory: FireworksInventoryModel[],
): FireworksSourceModel[] {
  if (serverless.length === 0 || inventory.length === 0) {
    throw new Error("Fireworks AI returned an empty serverless source; refusing destructive sync");
  }
  const expanded = expandFireworksModels(serverless);
  const ids = new Set(expanded.map((model) => model.catalogId));
  return [
    ...expanded,
    ...inventory
      .filter((model) =>
        model.kind === "HF_BASE_MODEL"
        && model.supportsServerless
        && !ids.has(model.name)
      )
      .map((model): FireworksInventoryCatalogModel => ({
        catalogId: model.name,
        inventoryOnly: true,
      })),
  ];
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
      for (const alias of model.aliases ?? []) {
        add(alias, model, model === defaultRow ? flagModes : []);
      }
    }
  }
  return [...expanded.values()];

  function add(catalogId: string, model: FireworksModel, flagModes: FireworksModel[]) {
    if (!expanded.has(catalogId)) expanded.set(catalogId, { ...model, catalogId, flagModes });
  }
}

function supportsCatalogModel(model: FireworksSourceModel) {
  return "inventoryOnly" in model || model.output_modalities.includes("text");
}

type Modality = SyncedFullModel["modalities"]["input"][number];

const MODALITIES = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);

function catalogModalities(values: string[], fallback: Modality[]): Modality[] {
  const modalities = values.filter((value): value is Modality => MODALITIES.has(value as Modality));
  return modalities.length === 0 ? fallback : modalities;
}

function pricing(
  model: Pick<FireworksModel, "id" | "pricing" | "serverless_mode">,
  existing?: NonNullable<SyncedFullModel["cost"]>,
): NonNullable<SyncedFullModel["cost"]> {
  const bySku = new Map(model.pricing.map((price) => [price.sku, Number(price.amount)]));
  const input = bySku.get("LLM input tokens (uncached)") ?? existing?.input;
  const output = bySku.get("LLM output tokens") ?? existing?.output;
  if (input === undefined || output === undefined) {
    throw new Error(
      `Fireworks AI model ${model.id} ${model.serverless_mode} mode has incomplete token pricing`,
    );
  }
  return {
    ...existing,
    input,
    cache_read: bySku.get("LLM input tokens (cached)") ?? existing?.cache_read,
    output,
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
  ) {
    throw new Error(`Fireworks AI model ${model.catalogId} has incomplete local TOML metadata required for sync`);
  }

  const modelCost = pricing(model, cost);
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
    cost: modelCost,
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
    experimental: experimental(model, modelCost, existing.experimental),
  } satisfies SyncedFullModel;

  return existing.base_model === undefined
    ? values
    : factorBaseModel(existing.base_model, values, values.limit, existing.base_model_omit);
}
