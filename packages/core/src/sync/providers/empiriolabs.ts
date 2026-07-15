import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

// EmpirioLabs exposes a public, unauthenticated OpenAI-compatible model
// catalog, so no API key is needed or used for this sync.
const API_ENDPOINT = "https://api.empiriolabs.ai/v1/models";

const CANONICAL_BASE_MODELS: Record<string, string> = {
  "fugu-ultra": "sakana/fugu-ultra",
  "gemma-4-26b-a4b": "google/gemma-4-26b-a4b-it",
  "gemma-4-e4b": "google/gemma-4-E4B-it",
  "mistral-medium-3": "mistral/mistral-medium-2505",
  "mistral-small-4": "mistral/mistral-small-2603",
  "muse-spark-1-1": "meta/muse-spark-1.1",
  "qwen3-5-9b": "alibaba/qwen3.5-9b",
  "qwen3-7-max": "alibaba/qwen3.7-max",
  "qwen3-7-plus": "alibaba/qwen3.7-plus",
  "step-3-5-flash": "stepfun/step-3.5-flash",
  "step-3-5-flash-2603": "stepfun/step-3.5-flash-2603",
  "step-3-7-flash": "stepfun/step-3.7-flash",
};

const EmpiriolabsParameter = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .passthrough();

const EmpiriolabsPricingTier = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_read: z.string().optional(),
    min_context: z.number().nullable().optional(),
  })
  .passthrough();

// Pricing is returned either as a single tier object or as an array of tier
// objects (tiered/context-priced models). Accept both shapes.
const EmpiriolabsPricing = z.union([
  z.array(EmpiriolabsPricingTier),
  EmpiriolabsPricingTier,
]);

const EmpiriolabsModel = z
  .object({
    id: z.string(),
    display_name: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    context_length: z.number().nullable().optional(),
    context_window: z.number().nullable().optional(),
    max_output_tokens: z.number().nullable().optional(),
    model_released_at: z.string().nullable().optional(),
    pricing: EmpiriolabsPricing.optional(),
    capabilities: z.record(z.unknown()).optional(),
    features: z.array(z.string()).optional(),
    structured_output: z.string().nullable().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    supported_parameters: z.array(EmpiriolabsParameter).optional(),
  })
  .passthrough();

const EmpiriolabsResponse = z
  .object({
    data: z.array(EmpiriolabsModel),
  })
  .passthrough();

export type EmpiriolabsModel = z.infer<typeof EmpiriolabsModel>;

export const empiriolabs = {
  id: "empiriolabs",
  name: "EmpirioLabs AI",
  modelsDir: "providers/empiriolabs/models",
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} EmpirioLabs AI models returned by the API were not created because they could not be mapped exactly to models.dev canonical metadata. `
        + "Existing models and canonical matches are still updated from API-authoritative fields.",
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`EmpirioLabs request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Text chat models only. Skip non-text categories (image, video, audio,
    // 3D, research, tools) and regional/capability variant lanes (id has ":").
    return EmpiriolabsResponse.parse(raw).data.filter(
      (model) => (model.category ?? "").toLowerCase() === "text" && !model.id.includes(":"),
    );
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    const baseModel = existing?.base_model ?? resolveEmpiriolabsBaseModel(model.id);
    if (existing === undefined && baseModel === undefined) return undefined;
    const built = buildEmpiriolabsModel(model, existing, baseModel);
    // A model with no resolvable context window cannot produce a valid TOML
    // (limit.context is required), so skip it rather than fail the whole sync.
    if (built === undefined) return undefined;
    return {
      id: model.id,
      model: built,
    };
  },
} satisfies SyncProvider<EmpiriolabsModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";
type EffortValue =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

const EFFORT_VALUES: EffortValue[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
];

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  // Per-token string converted to a per-1M-token number.
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

function nonZeroPrice(value: string | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

type TierCost = { input: number; output: number; cache_read?: number };

function tierCost(tier: z.infer<typeof EmpiriolabsPricingTier> | undefined): TierCost | undefined {
  const input = price(tier?.prompt);
  const output = price(tier?.completion);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = nonZeroPrice(tier?.input_cache_read);
  return { input, output, cache_read: cacheRead };
}

function modalities(values: string[] | undefined, fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = (values ?? [])
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function reasoningOptions(model: EmpiriolabsModel): SyncedModel["reasoning_options"] {
  const params = model.supported_parameters ?? [];
  const options: NonNullable<SyncedModel["reasoning_options"]> = [];
  if (params.some((parameter) => parameter.name === "enable_thinking")) {
    options.push({ type: "toggle" });
  }

  const effort = params.find((parameter) => parameter.name === "reasoning_effort");
  if (effort?.options?.length) {
    const values = effort.options.filter((value): value is EffortValue =>
      (EFFORT_VALUES as string[]).includes(value),
    );
    if (values.length > 0) options.push({ type: "effort", values });
  }

  const budget = params.find((parameter) => parameter.name === "thinking_budget");
  if (budget !== undefined) {
    const option: { type: "budget_tokens"; min?: number; max?: number } = { type: "budget_tokens" };
    if (budget.min !== undefined) option.min = budget.min;
    if (budget.max !== undefined) option.max = budget.max;
    options.push(option);
  }
  return options;
}

function parameterOutputLimit(model: EmpiriolabsModel) {
  const parameter = (model.supported_parameters ?? []).find(
    (item) => item.name === "max_tokens" || item.name === "max_completion_tokens",
  );
  return parameter?.max !== undefined && parameter.max > 0 ? parameter.max : undefined;
}

export function resolveEmpiriolabsBaseModel(id: string) {
  const explicit = CANONICAL_BASE_MODELS[id];
  if (explicit !== undefined) return explicit;
  return canonicalCandidates(id)
    .map((candidate) => resolveCanonicalBaseModel(candidate))
    .find((candidate) => candidate !== undefined);
}

function canonicalCandidates(id: string) {
  const candidates: string[] = [];

  if (id.startsWith("deepseek-")) {
    candidates.push(`deepseek/${id}`);
    candidates.push(`deepseek/${id.replace(/^deepseek-v(\d+)-(\d+)/, "deepseek-v$1.$2")}`);
  }

  if (id.startsWith("glm-")) {
    const normalized = id
      .replace(/^glm-(\d+)-(\d+)/, "glm-$1.$2")
      .replace(/^glm-(\d+)-(\d+)v/, "glm-$1.$2v");
    candidates.push(`z-ai/${id}`);
    candidates.push(`z-ai/${normalized}`);
  }

  if (id.startsWith("kimi-")) {
    const normalized = id.replace(/^(kimi-k\d+)-(\d+)/, "$1.$2");
    candidates.push(`moonshotai/${id}`);
    candidates.push(`moonshotai/${normalized}`);
  }

  if (id.startsWith("minimax-")) {
    const normalized = id.replace(/^minimax-m(\d+)-(\d+)/, "minimax-m$1.$2");
    candidates.push(`minimax/${id}`);
    candidates.push(`minimax/${normalized}`);
  }

  if (id.startsWith("mimo-")) {
    const normalized = id.replace(/^mimo-v(\d+)-(\d+)/, "mimo-v$1.$2");
    candidates.push(`xiaomi/${id}`);
    candidates.push(`xiaomi/${normalized}`);
  }

  if (id.startsWith("qwen")) {
    const normalized = id.replace(/^(qwen\d+)-(\d+)/, "$1.$2");
    candidates.push(`qwen/${id}`);
    candidates.push(`qwen/${normalized}`);
  }

  return [...new Set(candidates)];
}

export function buildEmpiriolabsModel(
  model: EmpiriolabsModel,
  existing: ExistingModel | undefined,
  baseModel = existing?.base_model ?? resolveEmpiriolabsBaseModel(model.id),
): SyncedModel | undefined {
  const features = new Set(model.features ?? []);
  const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
  const input = modalities(model.input_modalities, ["text"]);
  const output = modalities(model.output_modalities, ["text"]);
  const attachment = input.some((value) => value !== "text");
  const reasoning =
    capabilities.reasoning === true || features.has("reasoning") || existing?.reasoning === true;
  const toolCall =
    features.has("function_calling") || features.has("tools") || existing?.tool_call === true;
  const structuredOutput = features.has("structured_output") || existing?.structured_output === true;
  const temperature =
    (model.supported_parameters ?? []).some((parameter) => parameter.name === "temperature")
    || existing?.temperature === true;

  const pricingTiers = model.pricing === undefined
    ? []
    : Array.isArray(model.pricing)
    ? [...model.pricing].sort((a, b) => (a.min_context ?? 0) - (b.min_context ?? 0))
    : [model.pricing];
  const baseCost = tierCost(pricingTiers[0]);
  const contextTiers = pricingTiers
    .slice(1)
    .map((tier) => {
      const tierPricing = tierCost(tier);
      return tierPricing === undefined || tier.min_context === undefined || tier.min_context === null
        ? undefined
        : { tier: { type: "context" as const, size: tier.min_context }, ...tierPricing };
    })
    .filter((tier): tier is NonNullable<typeof tier> => tier !== undefined);
  const cost = baseCost !== undefined
    ? {
        ...baseCost,
        reasoning: existing?.cost?.reasoning,
        cache_write: existing?.cost?.cache_write,
        tiers: contextTiers.length > 0 ? contextTiers : undefined,
      }
    : existing?.cost;

  const context =
    model.context_length ?? model.context_window ?? existing?.limit?.context;
  // No usable context window: cannot build a valid model TOML, so skip.
  if (context === undefined || context === null) return undefined;

  const releaseDate = baseModel === undefined
    ? model.model_released_at ?? existing?.release_date
    : undefined;
  const lastUpdated = baseModel === undefined
    ? model.model_released_at ?? existing?.last_updated ?? releaseDate
    : existing?.last_updated ?? releaseDate;
  const outputTokens = model.max_output_tokens
    ?? parameterOutputLimit(model)
    ?? existing?.limit?.output
    ?? context;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: outputTokens,
  };
  const values: Partial<SyncedFullModel> = {
    name: model.display_name ?? model.name ?? model.id,
    description: baseModel === undefined ? existing?.description ?? model.description : existing?.description,
    family: existing?.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    attachment,
    reasoning,
    reasoning_options: reasoning ? reasoningOptions(model) : undefined,
    temperature: temperature || undefined,
    tool_call: toolCall,
    structured_output:
      (model.structured_output !== undefined && model.structured_output !== null)
      || structuredOutput
      || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  if (existing === undefined) return undefined;
  const required = z.object({
    name: z.string(),
    description: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`EmpirioLabs model ${model.id} has incomplete local metadata required for sync`);
  }

  return values as SyncedFullModel;
}
