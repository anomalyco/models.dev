import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://ai.zenifra.com/v1/models";

// Zenifra publishes its model prices in BRL per million tokens. Convert them to
// the USD values consumed by models.dev using the project's fixed BRL/USD rate.
const BRL_PER_USD = 5.3;

const ZenifraPricingTier = z.object({
  min_input_tokens: z.number().int().nonnegative(),
  max_input_tokens: z.number().int().positive().optional(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read_input: z.number().nonnegative().optional(),
}).passthrough();

const ZenifraPricing = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  unit: z.literal("per_million_tokens"),
  cache_read_input: z.number().nonnegative().optional(),
  context_tiers: z.array(ZenifraPricingTier).optional(),
}).passthrough();

const ZenifraReasoning = z.object({
  supported: z.boolean(),
  always_on: z.boolean().optional(),
  effort_levels: z.array(z.string()).optional(),
}).passthrough();

const ZenifraCapabilities = z.object({
  response_schema: z.boolean().optional(),
  structured_outputs: z.boolean().optional(),
  function_calling: z.boolean().optional(),
  tool_choice: z.boolean().optional(),
  reasoning: ZenifraReasoning.optional(),
}).passthrough();

export const ZenifraModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  owned_by: z.string().min(1),
  created: z.number().int().nonnegative(),
  context_length: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  pricing: ZenifraPricing.optional(),
  capabilities: ZenifraCapabilities.optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_operations: z.array(z.string()).optional(),
  supported_parameters: z.array(z.string()).optional(),
}).passthrough();

export const ZenifraResponse = z.object({
  object: z.literal("list"),
  data: z.array(ZenifraModel),
}).passthrough();

export type ZenifraModel = z.infer<typeof ZenifraModel>;

const CANONICAL_BASE_MODEL_OVERRIDES: Record<string, string> = {
  "zenifra/deepseek-v4-pro": "deepseek/deepseek-v4-pro-0813",
};

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default";

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
]);

export const zenifra = {
  id: "zenifra",
  name: "Zenifra",
  modelsDir: "providers/zenifra/models",
  // A valid but partial public feed must not erase the local catalog. Missing
  // routes are retained for manual lifecycle review until Zenifra publishes a
  // deletion-specific signal.
  deleteMissing: false,
  sourceID(model: ZenifraModel) {
    return model.id;
  },
  missingModelID(model: ZenifraModel) {
    return model.id;
  },
  skippedNotice(ids: string[]) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Zenifra models were skipped because they could not be mapped to canonical models.dev metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths: string[]) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Zenifra models were absent from the live API and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((path) => `\`${path}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchZenifraModels(process.env.ZENIFRA_AI_KEY);
  },
  parseModels: parseZenifraModels,
  translateModel(model: ZenifraModel, context) {
    const existing = context.existing(model.id);
    const authored = context.authored(model.id);
    const baseModel = authored?.base_model
      ?? existing?.base_model
      ?? resolveZenifraBaseModel(model.id);

    // A new relay route without canonical metadata is not safe to author as a
    // full inline model. Existing entries remain available for manual review.
    if (
      existing === undefined
      && (
        baseModel === undefined
        || model.pricing?.input === undefined
        || model.pricing.output === undefined
        || model.capabilities?.reasoning === undefined
      )
    ) return undefined;

    return {
      id: model.id,
      model: buildZenifraModel(model, existing, baseModel, authored),
    };
  },
} satisfies SyncProvider<ZenifraModel>;

export async function fetchZenifraModels(
  key: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const token = key?.trim();
  const response = await fetcher(API_ENDPOINT, {
    headers: token === undefined || token === ""
      ? undefined
      : { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Zenifra models request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseZenifraModels(raw: unknown) {
  const models = ZenifraResponse.parse(raw).data;
  if (models.length === 0) {
    throw new Error("Zenifra returned an empty model catalog; refusing to sync");
  }
  return models;
}

export function resolveZenifraBaseModel(modelID: string) {
  const override = CANONICAL_BASE_MODEL_OVERRIDES[modelID];
  if (override !== undefined) return override;

  const bareID = modelID.startsWith("zenifra/") ? modelID.slice("zenifra/".length) : modelID;
  return resolveModelMetadataBaseModel(bareID);
}

export function buildZenifraModel(
  model: ZenifraModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveZenifraBaseModel(model.id),
  authored: ExistingModel | undefined = existing,
): SyncedModel {
  const input = model.input_modalities === undefined
    ? existing?.modalities?.input
    : modalities(model.input_modalities, ["text"]);
  const output = model.output_modalities === undefined
    ? existing?.modalities?.output
    : modalities(model.output_modalities, ["text"]);
  const capabilities = model.capabilities;
  const parameters = model.supported_parameters === undefined
    ? undefined
    : new Set(model.supported_parameters);
  const sourceReasoning = capabilities?.reasoning?.supported;
  const reasoning = sourceReasoning
    ?? existing?.reasoning
    ?? (baseModel === undefined ? false : undefined);
  const reasoningOptions = reasoning === true
    ? resolveReasoningOptions(model, authored)
    : undefined;

  if (reasoning === true && reasoningOptions === undefined && (existing === undefined || baseModel === undefined)) {
    throw new MissingReasoningOptionsError(
      model.id,
      "Zenifra exposes reasoning without a safe control set or authored reasoning_options",
    );
  }

  const context = model.context_length
    ?? existing?.limit?.context
    ?? (baseModel === undefined ? 0 : undefined);
  const outputLimit = model.max_output_tokens
    ?? existing?.limit?.output
    ?? (baseModel === undefined ? 0 : undefined);
  const limit = {
    context,
    input: existing?.limit?.input,
    output: outputLimit,
  };
  const hostValues = {
    attachment: input === undefined ? existing?.attachment : input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: parameters === undefined ? existing?.temperature : parameters.has("temperature"),
    tool_call: capabilities?.function_calling
      ?? (parameters === undefined
        ? existing?.tool_call
        : parameters.has("tools") || parameters.has("tool_choice")),
    structured_output: capabilities?.structured_outputs
      ?? capabilities?.response_schema
      ?? (parameters === undefined ? existing?.structured_output : parameters.has("structured_outputs")),
    status: existing?.status,
    interleaved: existing?.interleaved,
    provider: { shape: "completions" as const },
    cost: buildCost(model, existing, reasoning),
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, hostValues, limit, authored?.base_model_omit);
  }

  return {
    name: existing?.name ?? model.id,
    description: existing?.description ?? model.id,
    family: existing?.family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    ...hostValues,
    attachment: hostValues.attachment ?? existing?.attachment ?? false,
    reasoning: hostValues.reasoning ?? false,
    tool_call: hostValues.tool_call ?? existing?.tool_call ?? false,
    structured_output: hostValues.structured_output ?? existing?.structured_output ?? false,
    limit: {
      ...limit,
      context: context ?? 0,
      output: outputLimit ?? context ?? 0,
    },
    modalities: {
      input: input ?? ["text"],
      output: output ?? ["text"],
    },
  } satisfies SyncedFullModel;
}

function resolveReasoningOptions(
  model: ZenifraModel,
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const authoredOptions = authored?.reasoning_options?.flatMap((option) => {
    const parsed = ReasoningOption.safeParse(option);
    return parsed.success ? [parsed.data] : [];
  });

  const levels = model.supported_parameters?.includes("reasoning_effort")
    ? model.capabilities?.reasoning?.effort_levels
      ?.filter((value): value is ReasoningEffort => REASONING_EFFORTS.has(value as ReasoningEffort))
    : undefined;
  if (levels !== undefined && levels.length > 0) {
    const preservedControls = authoredOptions?.filter((option) => option.type !== "effort") ?? [];
    return [
      ...preservedControls,
      { type: "effort", values: [...new Set(levels)] },
    ];
  }

  if (model.capabilities?.reasoning?.always_on === true) {
    return authoredOptions?.filter((option) => option.type !== "toggle") ?? [];
  }
  return authoredOptions;
}

function buildCost(
  model: ZenifraModel,
  existing: ExistingModel | undefined,
  reasoning: boolean | undefined,
): SyncedFullModel["cost"] | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return clearReasoningCost(existing?.cost, reasoning);

  const input = usd(pricing.input);
  const output = usd(pricing.output);
  if (input === undefined || output === undefined) return clearReasoningCost(existing?.cost, reasoning);

  const tiers = (pricing.context_tiers ?? [])
    .filter((tier) => tier.min_input_tokens > 0)
    .sort((a, b) => a.min_input_tokens - b.min_input_tokens)
    .map((tier) => ({
      tier: { type: "context" as const, size: tier.min_input_tokens },
      input: usd(tier.input)!,
      output: usd(tier.output)!,
      cache_read: tier.cache_read_input === undefined ? undefined : usd(tier.cache_read_input),
    }))
    .filter((tier, index, values) => index === 0 || tier.tier.size > values[index - 1]!.tier.size);

  return {
    input,
    output,
    reasoning: reasoning === false ? undefined : existing?.cost?.reasoning,
    cache_read: pricing.cache_read_input === undefined
      ? existing?.cost?.cache_read
      : usd(pricing.cache_read_input),
    cache_write: existing?.cost?.cache_write,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: pricing.context_tiers === undefined
      ? existing?.cost?.tiers
      : tiers.length > 0
        ? tiers
        : undefined,
  };
}

function clearReasoningCost(
  cost: SyncedFullModel["cost"] | undefined,
  reasoning: boolean | undefined,
) {
  if (cost === undefined || reasoning !== false) return cost;
  const { reasoning: _reasoning, ...withoutReasoning } = cost;
  return withoutReasoning;
}

function usd(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return round(value / BRL_PER_USD);
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function modalities(values: string[] | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const normalized = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}
