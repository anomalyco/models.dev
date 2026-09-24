import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.novita.ai/openai/v1/models";
// Listed in /models, but chat/completions returned 503 SERVICE_NOT_AVAILABLE on 2026-09-20.
// Re-enable after the route works and its reasoning controls can be verified.
const UNAVAILABLE_ROUTES = new Set(["deepseek/deepseek-r1-0528-qwen3-8b"]);
const BASE_MODEL_ALIASES: Record<string, string> = {
  "deepseek/deepseek_v3": "deepseek/deepseek-v3",
  "baidu/ernie-4.5-21B-a3b": "baidu/ernie-4.5-21b-a3b",
  "baidu/ernie-4.5-vl-424b-a47b": "baidu/ernie-4.5-vl-424b-a47b",
  "deepseek/deepseek-r1-distill-llama-70b": "deepseek/deepseek-r1-distill-llama-70b",
  "deepseek/deepseek-r1-turbo": "deepseek/deepseek-r1",
  "minimaxai/minimax-m1-80k": "minimax/minimax-m1-80k",
};
// Verified per model with Novita chat/completions: disabling thinking removes
// reasoning_content, while enabling it returns reasoning_content.
const VERIFIED_THINKING_TOGGLE = new Set([
  "baidu/ernie-4.5-vl-424b-a47b",
  "deepseek/deepseek-r1-turbo",
  "deepseek/deepseek-v3.1",
  "deepseek/deepseek-v3.1-terminus",
  "deepseek/deepseek-v3.2-exp",
  "deepseek/deepseek-v3.2",
  "google/gemma-4-26b-a4b-it",
  "google/gemma-4-31b-it",
  "inclusionai/ling-3.0-flash-fin",
  "minimax/minimax-m3",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.7-code",
  "nvidia/nemotron-3-nano-30b-a3b",
  "tencent/hy3",
  "zai-org/glm-4.5-air",
  "zai-org/glm-4.5v",
  "zai-org/glm-4.6",
  "zai-org/glm-4.6v",
  "zai-org/glm-4.7-flash",
  "zai-org/glm-4.7",
  "zai-org/glm-5-turbo",
  "zai-org/glm-5",
  "zai-org/glm-5.1",
  "zai-org/glm-5.3",
  "zai-org/glm-5v-turbo",
]);
const VERIFIED_NON_REASONING = new Set([
  "qwen/qwen3-omni-30b-a3b-thinking",
  "qwen/qwen3-235b-a22b-fp8",
  "qwen/qwen3-next-80b-a3b-instruct",
]);
// Novita's inventory lists image input, but both routes answer that they cannot see images.
const VERIFIED_TEXT_ONLY = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const VERIFIED_ALWAYS_ON = new Set([
  "minimaxai/minimax-m1-80k",
  "minimax/minimax-m2.1",
]);
// Novita accepts the thinking toggle for these routes, but no effort ladder
// was verified; do not preserve an inherited guessed ladder from older files.
const VERIFIED_TOGGLE_HEADER = "# Toggle: thinking.type = enabled|disabled\n# Verified with Novita chat/completions on 2026-09-17: disabling removes reasoning_content.\n";
const VERIFIED_RECENT_TOGGLE_HEADER = "# Toggle: thinking.type = enabled|disabled\n# Verified with Novita chat/completions on 2026-09-20: enabled returns reasoning_content; disabled does not.\n";
const VERIFIED_BUDGET_TOGGLE = new Set([
  "qwen/qwen3.5-27b",
  "qwen/qwen3.5-35b-a3b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.5-plus",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.6-35b-a3b",
  "qwen/qwen3.6-plus",
  "qwen/qwen3.7-max",
  "qwen/qwen3.8-27b",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.8-max",
  "qwen/qwen3-max",
]);
const VERIFIED_BUDGET_ONLY = new Set([
  "qwen/qwen3-235b-a22b-thinking-2507",
]);
const VERIFIED_EFFORT_TOGGLE = new Map<string, Array<"low" | "high" | "max">>([
  ["deepseek/deepseek-v4-pro", ["high", "max"]],
  ["deepseek/deepseek-v4.1-flash", ["low", "high", "max"]],
  ["deepseek/deepseek-v4-flash", ["low", "high", "max"]],
  ["deepseek/deepseek-v4-flash-0731", ["low", "high", "max"]],
  ["deepseek/deepseek-v4-flash-vision-exp", ["low", "high", "max"]],
  ["moonshotai/kimi-k3", ["low", "high", "max"]],
]);
const VERIFIED_EFFORT_ONLY = new Map<string, Array<"none" | "high" | "max">>([
  ["zai-org/glm-5.2", ["none", "high", "max"]],
]);
const Price = z.object({ price_per_m_decimal: z.string().optional() }).passthrough();
const Pricing = z.object({
  prompt: Price.optional(),
  completion: Price.optional(),
  input_cache_read: Price.optional(),
  input_cache_write: Price.optional(),
}).passthrough();

export const NovitaAIModel = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string(),
  input_token_price_per_m: z.number().optional(),
  output_token_price_per_m: z.number().optional(),
  title: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  // Some non-LLM catalog entries use zero when no context window applies.
  context_size: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  features: z.array(z.string()).optional(),
  model_type: z.string().optional(),
  endpoints: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  pricing: Pricing.optional(),
  is_tiered_billing: z.boolean().optional(),
  tiered_billing_configs: z.array(z.object({
    min_tokens: z.number().int().nonnegative(),
    max_tokens: z.number().int().positive(),
    pricing: Pricing,
  }).passthrough()).optional(),
}).passthrough();

export const NovitaAIResponse = z.object({
  // Novita's endpoint currently omits the OpenAI-compatible top-level object.
  // Keep accepting the standard value if the API adds it later.
  object: z.literal("list").optional(),
  data: z.array(NovitaAIModel).min(1),
}).passthrough();

export type NovitaAIModel = z.infer<typeof NovitaAIModel>;

function decimalPrice(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[] | undefined, fallback: Modality[] | undefined) {
  if (values === undefined || values.length === 0) return fallback;
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase() === "file" ? "pdf" : value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  return result.length > 0 ? [...new Set(result)] : fallback;
}

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

type Cost = NonNullable<ExistingModel["cost"]>;

function price(pricing: z.infer<typeof Pricing> | undefined, existing?: Cost) {
  const input = decimalPrice(pricing?.prompt?.price_per_m_decimal);
  const output = decimalPrice(pricing?.completion?.price_per_m_decimal);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    reasoning: existing?.reasoning,
    cache_read: decimalPrice(pricing?.input_cache_read?.price_per_m_decimal) ?? existing?.cache_read,
    cache_write: decimalPrice(pricing?.input_cache_write?.price_per_m_decimal) ?? existing?.cache_write,
    input_audio: existing?.input_audio,
    output_audio: existing?.output_audio,
  };
}

function cost(model: NovitaAIModel, existing: ExistingModel | undefined) {
  if (model.is_tiered_billing !== true) {
    // Novita uses zero top-level prices without a pricing object for free models.
    if (model.pricing === undefined && model.input_token_price_per_m === 0 && model.output_token_price_per_m === 0) {
      return { ...existing?.cost, input: 0, output: 0, tiers: undefined };
    }
    return price(model.pricing, existing?.cost) ?? existing?.cost;
  }
  const bands = [...model.tiered_billing_configs ?? []].sort((a, b) => a.min_tokens - b.min_tokens);
  if (bands.length === 0 || bands[0]!.min_tokens > 1 || bands.some((band, index) =>
    band.max_tokens <= band.min_tokens || (index > 0 && band.min_tokens <= bands[index - 1]!.min_tokens)
  )) return existing?.cost;
  const base = price(bands[0]!.pricing, existing?.cost);
  if (base === undefined || bands.some((band) => price(band.pricing) === undefined)) return existing?.cost;
  return {
    ...base,
    tiers: bands.slice(1).map((band) => ({
      ...price(band.pricing, existing?.cost?.tiers?.find((tier) => tier.tier.size === band.min_tokens))!,
      tier: { type: "context" as const, size: band.min_tokens },
    })),
  };
}

function buildNovitaModel(model: NovitaAIModel, existing: ExistingModel | undefined, resolved: ExistingModel | undefined): SyncedModel | undefined {
  const baseModel = existing?.base_model ?? BASE_MODEL_ALIASES[model.id] ?? resolveModelMetadataBaseModel(model.id);
  // New provider entries require a lab model. Do not create fabricated inline lab facts.
  if (existing === undefined && baseModel === undefined) return undefined;
  const name = model.display_name ?? model.title ?? existing?.name ?? model.id;
  const input = VERIFIED_TEXT_ONLY.has(model.id) ? ["text" as const] : modalities(model.input_modalities, resolved?.modalities?.input) ?? ["text"];
  const output = modalities(model.output_modalities, resolved?.modalities?.output) ?? ["text"];
  const features = model.features === undefined ? undefined : new Set(model.features);
  const featureValue = (feature: string, fallback: boolean | undefined) =>
    features === undefined || features.size === 0 || !features.has(feature)
      ? fallback ?? false
      : true;
  const reasoning = VERIFIED_NON_REASONING.has(model.id) ? false : featureValue("reasoning", resolved?.reasoning);
  const toolCall = featureValue("function-calling", resolved?.tool_call);
  const structuredOutput = featureValue("structured-outputs", resolved?.structured_output);
  const context = model.context_size && model.context_size > 0
    ? model.context_size
    : resolved?.limit?.context ?? 0;
  const outputLimit = model.max_output_tokens ?? resolved?.limit?.output ?? context;
  const modelCost = cost(model, existing);
  // Novita's GLM-5.3 description claims reasoning cannot be disabled, but
  // its chat API returns no reasoning when thinking.type is disabled.
  const description = model.id === "zai-org/glm-5.3" ? undefined : model.description;
  // DeepSeek R1 is fixed-reasoning on Novita, as with its already curated R1 variants.
  const effort = VERIFIED_EFFORT_TOGGLE.get(model.id);
  const effortOnly = VERIFIED_EFFORT_ONLY.get(model.id);
  const reasoningOptions = VERIFIED_NON_REASONING.has(model.id) ? undefined
    : VERIFIED_ALWAYS_ON.has(model.id) ? []
      : VERIFIED_BUDGET_ONLY.has(model.id) ? [{ type: "budget_tokens" as const }]
        : VERIFIED_BUDGET_TOGGLE.has(model.id) ? [{ type: "toggle" as const }, { type: "budget_tokens" as const }]
          : effort !== undefined ? [{ type: "toggle" as const }, { type: "effort" as const, values: effort }]
            : effortOnly !== undefined ? [{ type: "effort" as const, values: effortOnly }]
              : VERIFIED_THINKING_TOGGLE.has(model.id) ? [{ type: "toggle" as const }]
                : existing?.reasoning_options ?? (model.id === "deepseek/deepseek-r1" ? [] : undefined);
  const interleaved = VERIFIED_NON_REASONING.has(model.id) ? undefined : existing?.interleaved ?? (reasoningOptions?.some((option) => option.type === "toggle") ? { field: "reasoning_content" as const } : undefined);
  if (existing === undefined && (modelCost === undefined || (reasoning && reasoningOptions === undefined))) return undefined;
  const values: SyncedFullModel = {
    name,
    description: existing?.description || description || describeModel({ id: model.id, name, reasoning, tool_call: toolCall, structured_output: structuredOutput || undefined, open_weights: existing?.open_weights ?? false, limit: { context, output: outputLimit }, modalities: { input, output } }),
    family: existing?.family,
    release_date: existing?.release_date ?? dateFromTimestamp(model.created),
    last_updated: existing?.last_updated ?? dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    tool_call: toolCall,
    structured_output: structuredOutput,
    temperature: existing?.temperature,
    open_weights: existing?.open_weights ?? false,
    cost: modelCost,
    limit: { context, output: outputLimit },
    modalities: { input, output },
  };
  if (baseModel !== undefined) return factorBaseModel(baseModel, {
    ...values,
    // An empty catalog description is not a provider-specific override.
    description: existing?.description || description || undefined,
    // These are lab facts, not claims made by the Novita catalog endpoint.
    open_weights: existing?.open_weights,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    temperature: existing?.temperature,
    reasoning_options: reasoningOptions,
    interleaved,
  }, values.limit, existing?.base_model_omit);
  return {
    ...existing,
    ...values,
    reasoning_options: existing?.reasoning_options,
    interleaved,
    status: existing?.status,
    knowledge: existing?.knowledge,
  } as SyncedModel;
}

export async function fetchNovitaAIModels(key: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  const response = await fetcher(API_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Novita AI models request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function catalogCandidateID(model: NovitaAIModel) {
  if (UNAVAILABLE_ROUTES.has(model.id)) return undefined;
  if (model.model_type !== "chat" || !model.endpoints?.includes("chat/completions") || (model.context_size ?? 0) <= 0) return undefined;
  if (cost(model, undefined) === undefined) return undefined;
  return model.id;
}

function hasVerifiedReasoningControl(id: string) {
  return VERIFIED_THINKING_TOGGLE.has(id)
    || VERIFIED_BUDGET_TOGGLE.has(id)
    || VERIFIED_BUDGET_ONLY.has(id)
    || VERIFIED_EFFORT_TOGGLE.has(id)
    || VERIFIED_EFFORT_ONLY.has(id);
}

function reasoningHeader(id: string, model: SyncedModel) {
  if (!hasVerifiedReasoningControl(id) || !("reasoning_options" in model) || model.reasoning_options === undefined) return undefined;
  const options = model.reasoning_options;
  const toggle = options.some((option) => option.type === "toggle")
    ? (["baidu/ernie-4.5-vl-424b-a47b", "deepseek/deepseek-r1-turbo"].includes(id) ? VERIFIED_RECENT_TOGGLE_HEADER : VERIFIED_TOGGLE_HEADER)
    : "";
  const effort = options.filter((option) => option.type === "effort")
    .map((option) => `# Effort: reasoning_effort = ${option.values.join("|")}\n`).join("");
  const budget = options.some((option) => option.type === "budget_tokens") ? "# Budget: thinking_budget (integer reasoning tokens)\n" : "";
  const maxEvidence = id === "qwen/qwen3-max"
    ? "# Verified on Novita 2026-09-18: thinking_budget=64 produced 64 reasoning tokens; prices and context tiers come from GET /openai/v1/models.\n"
    : "";
  const effortEvidence = id === "zai-org/glm-5.2"
    ? "# Verified on Novita 2026-09-20: none omits reasoning_content; high|max return it.\n"
    : "";
  return `${toggle}${effort}${budget}${maxEvidence}${effortEvidence}` || undefined;
}

export const novitaAi = {
  id: "novita-ai",
  name: "Novita AI",
  modelsDir: "providers/novita-ai/models",
  // The endpoint exposes the metadata needed to author new provider models.
  skipCreates: false,
  // The authenticated inventory may be account- or tier-scoped; never delete
  // locally curated models solely because a key cannot see them.
  deleteMissing: false,
  authoritativeHeadersWhenPresent: true,
  trackMissingModels: true,
  missingModelID(model) {
    return catalogCandidateID(model);
  },
  sourceID(model) {
    return catalogCandidateID(model);
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [`Novita models needing lab metadata, pricing, or verified reasoning controls: ${ids.join(", ")}`];
  },
  async fetchModels() {
    const key = process.env.NOVITA_API_KEY;
    if (key === undefined) throw new Error("Novita AI sync requires NOVITA_API_KEY");
    return fetchNovitaAIModels(key);
  },
  parseModels(raw) {
    return NovitaAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (catalogCandidateID(model) === undefined) return undefined;
    const translated = buildNovitaModel(model, context.authored(model.id), context.existing(model.id));
    return translated === undefined ? undefined : {
      id: model.id,
      model: translated,
      header: reasoningHeader(model.id, translated),
    };
  },
} satisfies SyncProvider<NovitaAIModel>;
