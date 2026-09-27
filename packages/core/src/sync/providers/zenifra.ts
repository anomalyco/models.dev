import { ReasoningOption } from "../../schema.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";
import { z } from "zod";

const API_ENDPOINT = "https://ai.zenifra.com/v1/models";

// Zenifra publishes its model prices in BRL per million tokens. Keep this in
// sync with the rate used by the authored catalog until the API publishes a
// currency field or the project adopts dynamic FX conversion.
const BRL_PER_USD = 5.2;

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
  deleteMissing: true,
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
    if (existing === undefined && baseModel === undefined) return undefined;

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
    throw new Error("Zenifra returned an empty model catalog; refusing destructive sync");
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
  const input = modalities(model.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.output_modalities, existing?.modalities?.output ?? ["text"]);
  const capabilities = model.capabilities;
  const parameters = new Set(model.supported_parameters ?? []);
  const sourceReasoning = capabilities?.reasoning?.supported;
  const reasoning = sourceReasoning ?? existing?.reasoning ?? false;
  const reasoningOptions = reasoning
    ? resolveReasoningOptions(model, authored)
    : undefined;

  if (reasoning && reasoningOptions === undefined && baseModel === undefined) {
    throw new MissingReasoningOptionsError(
      model.id,
      "Zenifra exposes reasoning without a safe control set or authored reasoning_options",
    );
  }

  const context = model.context_length ?? existing?.limit?.context ?? 0;
  const outputLimit = model.max_output_tokens ?? existing?.limit?.output ?? context;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: outputLimit,
  };
  const values: SyncedFullModel = {
    name: existing?.name ?? model.id,
    description: existing?.description ?? model.id,
    family: existing?.family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: parameters.has("temperature"),
    tool_call: capabilities?.function_calling
      ?? capabilities?.tool_choice
      ?? (parameters.has("tools") || parameters.has("tool_choice")),
    structured_output: capabilities?.structured_outputs
      ?? capabilities?.response_schema
      ?? existing?.structured_output
      ?? false,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    provider: { shape: "completions" },
    cost: buildCost(model, existing),
    limit,
    modalities: { input, output },
  };

  return baseModel === undefined
    ? values
    : factorBaseModel(baseModel, values, limit, authored?.base_model_omit);
}

function resolveReasoningOptions(
  model: ZenifraModel,
  authored: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const authoredOptions = authored?.reasoning_options?.flatMap((option) => {
    const parsed = ReasoningOption.safeParse(option);
    return parsed.success ? [parsed.data] : [];
  });
  if (authoredOptions !== undefined && authoredOptions.length > 0) return authoredOptions;

  const levels = model.capabilities?.reasoning?.effort_levels
    ?.filter((value): value is ReasoningEffort => REASONING_EFFORTS.has(value as ReasoningEffort));
  if (levels !== undefined && levels.length > 0) {
    return [{ type: "effort", values: [...new Set(levels)] }];
  }

  return model.capabilities?.reasoning?.always_on === true ? [] : undefined;
}

function buildCost(
  model: ZenifraModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return existing?.cost;

  const input = usd(pricing.input);
  const output = usd(pricing.output);
  if (input === undefined || output === undefined) return existing?.cost;

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
    reasoning: existing?.cost?.reasoning,
    cache_read: pricing.cache_read_input === undefined ? undefined : usd(pricing.cache_read_input),
    cache_write: existing?.cost?.cache_write,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
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
