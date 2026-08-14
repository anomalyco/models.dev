import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.openference.com/v1/models";

// Openference is a curated OpenAI-compatible relay. `/v1/models` is authoritative
// for pricing (USD per token), served context/output limits, and the reasoning
// efforts each model accepts. Bare wire IDs resolve to canonical lab metadata in
// `models/` through the shared resolver; anything without a lab match preserves
// an existing hand-authored file (e.g. the host's own "Auto" router).
const BASE_MODEL_ALIASES: Record<string, string> = {
  // Openference's shorthand for the NVIDIA Super 120B A12B tier.
  "Nemotron-3-120B": "nvidia/nemotron-3-super-120b-a12b",
};

// Openference's catalog docs distinguish always-on from toggle-only models by
// name even when supported_efforts is omitted. Keep the documented always-on
// models explicit here so they do not receive a false thinking toggle.
const ALWAYS_ON_REASONING_MODELS = new Set(["Kimi K2.7 Code", "MiMo-V2.5"]);

const OpenferencePricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  cache_read: z.string().optional(),
});

type OpenferencePricing = z.infer<typeof OpenferencePricing>;

const OpenferenceReasoning = z
  .object({
    supported: z.boolean(),
    supported_efforts: z.array(z.string()).optional(),
  })
  .passthrough();

export const OpenferenceModel = z
  .object({
    id: z.string(),
    object: z.string(),
    created: z.number(),
    owned_by: z.string(),
    permission: z.array(z.unknown()),
    root: z.string(),
    parent: z.string().nullable(),
    pricing: OpenferencePricing,
    context_length: z.number(),
    max_output_tokens: z.number().optional(),
    reasoning: OpenferenceReasoning,
  })
  .passthrough();

export const OpenferenceResponse = z
  .object({
    object: z.string(),
    data: z.array(OpenferenceModel),
  })
  .passthrough();

export type OpenferenceModel = z.infer<typeof OpenferenceModel>;

const ReasoningEffortOrder = new Map(
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"].map(
    (effort, index) => [effort, index] as const,
  ),
);

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function buildCost(pricing: OpenferencePricing) {
  const input = price(pricing.prompt);
  const output = price(pricing.completion);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cache_read: price(pricing.cache_read),
  };
}

function reasoningOptions(
  model: OpenferenceModel,
): SyncedFullModel["reasoning_options"] {
  if (!model.reasoning.supported) return undefined;
  if (ALWAYS_ON_REASONING_MODELS.has(model.id)) return [];
  // Toggle-capable reasoning models expose `thinking.type = enabled|disabled`;
  // graded effort is layered on top when the endpoint advertises
  // `supported_efforts`.
  const toggle = [ReasoningOption.parse({ type: "toggle" })];
  const efforts = model.reasoning.supported_efforts;
  if (efforts === undefined || efforts.length === 0) return toggle;
  const sorted = [...efforts].sort((a, b) => {
    const order =
      (ReasoningEffortOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (ReasoningEffortOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
    return order || a.localeCompare(b);
  });
  return [
    ...(sorted.includes("none") ? [] : toggle),
    ReasoningOption.parse({ type: "effort", values: sorted }),
  ];
}

function resolveBaseModel(id: string) {
  const alias = BASE_MODEL_ALIASES[id];
  if (alias !== undefined) return alias;
  return resolveModelMetadataBaseModel(id.replace(/\s+/g, "-"));
}

function buildModel(
  model: OpenferenceModel,
  base: string,
  existing: ExistingModel | undefined,
): SyncedModel {
  const reasoning = model.reasoning.supported;
  const limit = {
    context: model.context_length,
    output: model.max_output_tokens,
  };
  const interleaved = reasoning
    ? existing?.interleaved ?? { field: "reasoning_content" as const }
    : undefined;
  return factorBaseModel(
    base,
    {
      cost: buildCost(model.pricing),
      limit,
      reasoning_options: reasoningOptions(model),
      interleaved,
    },
    limit,
  );
}

// Host-unique models without a canonical base_model (e.g. the Auto router)
// still need API-authoritative pricing and limits refreshed onto the
// hand-authored file. Overlay only the fields /v1/models is authoritative for;
// preserve everything else from the authored TOML.
function buildAuthoredOnlyModel(
  model: OpenferenceModel,
  authored: ExistingModel,
): SyncedModel {
  const { id: _authoredID, ...preserved } = authored;
  const apiCost = buildCost(model.pricing);
  const cost = apiCost !== undefined
    ? {
        ...authored.cost,
        input: apiCost.input,
        output: apiCost.output,
        ...(apiCost.cache_read !== undefined ? { cache_read: apiCost.cache_read } : {}),
      }
    : authored.cost;
  const limit = {
    ...authored.limit,
    context: model.context_length,
    ...(model.max_output_tokens !== undefined ? { output: model.max_output_tokens } : {}),
  };
  const reasoning = model.reasoning.supported;
  const apiOptions = reasoningOptions(model);
  const interleaved = reasoning
    ? authored.interleaved ?? { field: "reasoning_content" as const }
    : undefined;
  return {
    ...preserved,
    reasoning,
    cost,
    limit,
    ...(apiOptions !== undefined ? { reasoning_options: apiOptions } : {}),
    interleaved,
  } as SyncedModel;
}

export const openference = {
  id: "openference",
  name: "Openference",
  modelsDir: "providers/openference/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Openference request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    return OpenferenceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const base = resolveBaseModel(model.id);
    if (base === undefined) {
      // No canonical lab model — refresh API-authoritative fields onto a
      // hand-authored file (e.g. the host's own "Auto" router) and skip
      // models with no authored file at all.
      const authored = context.authored(model.id);
      if (authored === undefined) return undefined;
      return { id: model.id, model: buildAuthoredOnlyModel(model, authored) };
    }
    return { id: model.id, model: buildModel(model, base, context.existing(model.id)) };
  },
} satisfies SyncProvider<OpenferenceModel>;
