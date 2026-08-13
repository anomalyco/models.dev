import { z } from "zod";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";

const API_ENDPOINT = "https://tokenfactory.nebius.com/api/public/models_info";
const THROTTLED_CONTEXT_SENTINEL = 8_000;

const NebiusFlavor = z.object({
  external_provider: z.boolean(),
  input_price_per_million_tokens: z.number().nonnegative(),
  max_model_len: z.number().int().positive(),
  model_id: z.string().min(1),
  model_name: z.string().min(1),
  model_type: z.string().min(1),
  output_price_per_million_tokens: z.number().nonnegative(),
  use_cases: z.array(z.string()),
}).passthrough();

const NebiusCatalogModel = z.object({
  name: z.string().min(1),
  status: z.string().min(1),
  type: z.string().min(1),
  use_cases: z.array(z.string()),
  flavors: z.array(NebiusFlavor).min(1),
}).passthrough();

export const NebiusResponse = z.array(NebiusCatalogModel);

export type NebiusModel = z.infer<typeof NebiusFlavor> & {
  catalog_status: string;
  catalog_type: string;
  catalog_use_cases: string[];
};

export const nebius = {
  id: "nebius",
  name: "Nebius Token Factory",
  modelsDir: "providers/nebius/models",
  skipCreates: true,
  async fetchModels() {
    return fetchNebiusModels();
  },
  parseModels(raw) {
    return parseNebiusModels(raw);
  },
  translateModel(model, context) {
    if (!isActiveFirstPartyModel(model)) return undefined;
    const existing = context.existing(model.model_id);
    const authored = context.authored(model.model_id);
    if (existing === undefined || authored === undefined) return undefined;
    return {
      id: model.model_id,
      model: buildNebiusModel(model, existing, authored),
    };
  },
  sourceID(model) {
    return isActiveFirstPartyModel(model) ? model.model_id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} active Nebius models were not created because the public catalog does not expose enough metadata to author complete entries safely.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
} satisfies SyncProvider<NebiusModel>;

export async function fetchNebiusModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Nebius public catalog request failed: ${response.status} ${response.statusText}`);
  }
  return NebiusResponse.parse(await response.json());
}

export function parseNebiusModels(raw: unknown): NebiusModel[] {
  const models = NebiusResponse.parse(raw).flatMap((catalogModel) =>
    catalogModel.flavors.map((flavor) => ({
      ...flavor,
      catalog_status: catalogModel.status,
      catalog_type: catalogModel.type,
      catalog_use_cases: catalogModel.use_cases,
    }))
  );

  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.model_id)) {
      throw new Error(`Duplicate Nebius public catalog model ID: ${model.model_id}`);
    }
    seen.add(model.model_id);
  }
  return models;
}

export function buildNebiusModel(
  model: NebiusModel,
  existing: ExistingModel,
  authored: ExistingModel,
): SyncedModel {
  const sourceUseCases = new Set([...model.catalog_use_cases, ...model.use_cases]);
  const sourceImageInput = model.catalog_type === "image2text" || model.model_type === "image2text";
  const addsImageInput = sourceImageInput && !existing.modalities?.input.includes("image");

  const safeContext = exactContext(model, existing);
  const cost = {
    ...authored.cost,
    input: model.input_price_per_million_tokens,
    output: model.output_price_per_million_tokens,
  };
  const limit = safeContext === undefined || safeContext === existing.limit?.context
    ? authored.limit
    : { ...authored.limit, context: safeContext };
  const modalities = !addsImageInput
    ? authored.modalities
    : {
        input: [...new Set([...(existing.modalities?.input ?? ["text"]), "image" as const])],
        output: existing.modalities?.output ?? authored.modalities?.output ?? ["text"],
      };

  return {
    ...authored,
    attachment: sourceImageInput && existing.attachment !== true ? true : authored.attachment,
    reasoning: sourceUseCases.has("reasoning") && existing.reasoning !== true ? true : authored.reasoning,
    tool_call: sourceUseCases.has("function_calling") && existing.tool_call !== true ? true : authored.tool_call,
    cost,
    limit,
    modalities,
  } as SyncedModel;
}

function isActiveFirstPartyModel(model: NebiusModel) {
  return model.catalog_status === "active" && !model.external_provider;
}

function exactContext(model: NebiusModel, existing: ExistingModel) {
  // The public catalog uses 8,000 as a serving/configuration sentinel even when
  // its own model-level context metadata advertises a much larger window. It is
  // not safe to replace a curated model limit with that value.
  if (model.max_model_len === THROTTLED_CONTEXT_SENTINEL) return undefined;

  // Do not create an internally inconsistent limit when a source contraction
  // conflicts with a larger, separately curated input or output allowance.
  const trustedMinimum = Math.max(existing.limit?.input ?? 0, existing.limit?.output ?? 0);
  return model.max_model_len >= trustedMinimum ? model.max_model_len : undefined;
}
