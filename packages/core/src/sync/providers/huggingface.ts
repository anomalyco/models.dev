import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.huggingface.co/v1/models";

// Hugging Face org prefixes mapped to the canonical metadata prefixes understood
// by resolveCanonicalBaseModel. Anything not listed falls back to a direct lookup.
const CANONICAL_ORG_PREFIXES: Record<string, string> = {
  CohereLabs: "cohere",
  "deepseek-ai": "deepseek",
  google: "google",
  "meta-llama": "meta-llama",
  MiniMaxAI: "minimax",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  Qwen: "qwen",
  "stepfun-ai": "stepfun",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

const HuggingFaceProvider = z.object({
  provider: z.string(),
  status: z.string(),
  context_length: z.number().int().positive().optional(),
  pricing: z.object({
    input: z.number(),
    output: z.number(),
  }).passthrough().optional(),
  throughput: z.number().nonnegative().optional(),
  first_token_latency_ms: z.number().nonnegative().optional(),
  is_free: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_structured_output: z.boolean().optional(),
  is_model_author: z.boolean().optional(),
}).passthrough();

export const HuggingFaceModel = z.object({
  id: z.string().min(1),
  created: z.number().optional(),
  owned_by: z.string().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).passthrough(),
  providers: z.array(HuggingFaceProvider),
}).passthrough();

export const HuggingFaceResponse = z.object({
  data: z.array(HuggingFaceModel),
}).passthrough();

export type HuggingFaceModel = z.infer<typeof HuggingFaceModel>;
export type HuggingFaceProvider = z.infer<typeof HuggingFaceProvider>;

export const huggingface = {
  id: "huggingface",
  name: "Hugging Face",
  modelsDir: "providers/huggingface/models",
  deleteMissing: false,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Hugging Face Inference Providers models were not created because their IDs could not be mapped to provider-agnostic metadata, had no live provider, or had no priced provider.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Hugging Face models were absent from the Inference Providers catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const headers = process.env.HF_TOKEN
      ? { Authorization: `Bearer ${process.env.HF_TOKEN}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Hugging Face models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return HuggingFaceResponse.parse(raw).data;
  },
  translateModel(model, context) {
    if (!model.providers.some((provider) => provider.status === "live")) return undefined;

    const existing = context.existing(model.id);
    const baseModel = existing === undefined
      ? resolveHuggingFaceBaseModel(model.id)
      : existing.base_model;
    if (existing === undefined && baseModel === undefined) return undefined;

    // The router only exposes pricing per inference provider, so a new model with
    // no priced provider cannot be created with a meaningful cost.
    const aggregate = aggregateProviders(model);
    if (existing === undefined && aggregate.cost === undefined) return undefined;

    return {
      id: model.id,
      model: buildHuggingFaceModel(model, existing, baseModel, aggregate),
    };
  },
  sameModel() {
    // For now the sync only creates new models; existing curated TOMLs are left
    // untouched. Treating every existing model as already in sync skips updates
    // while still allowing new files to be created.
    return true;
  },
} satisfies SyncProvider<HuggingFaceModel>;

interface Aggregate {
  cost: { input: number; output: number } | undefined;
  context: number | undefined;
  tools: boolean;
  structuredOutput: boolean;
}

function price(value: number) {
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000) / 1_000_000
    : undefined;
}

// The router aggregates several inference providers per model and sends traffic to
// the fastest one, so this collapses them into the route a request would actually
// take: pricing and context from the highest-throughput provider, plus capabilities
// advertised by any provider (a caller can always pin a slower provider).
function aggregateProviders(model: HuggingFaceModel): Aggregate {
  const providers = model.providers.filter((provider) => provider.status === "live");

  const byThroughput = (a: HuggingFaceProvider, b: HuggingFaceProvider) =>
    (b.throughput ?? -Infinity) - (a.throughput ?? -Infinity);
  // The provider the router routes to (fastest). Take its price when it reports one;
  // otherwise fall back to the fastest provider that does, so a new model can still
  // be costed.
  const routed = [...providers].sort(byThroughput).at(0);
  const costProvider = routed?.pricing !== undefined
    ? routed
    : [...providers]
        .filter((provider): provider is HuggingFaceProvider & { pricing: { input: number; output: number } } =>
          provider.pricing !== undefined)
        .sort(byThroughput)
        .at(0);
  const input = costProvider?.pricing === undefined ? undefined : price(costProvider.pricing.input);
  const output = costProvider?.pricing === undefined ? undefined : price(costProvider.pricing.output);

  const contexts = providers
    .map((provider) => provider.context_length)
    .filter((value): value is number => value !== undefined);

  return {
    cost: input !== undefined && output !== undefined ? { input, output } : undefined,
    context: routed?.context_length ?? (contexts.length > 0 ? Math.max(...contexts) : undefined),
    tools: providers.some((provider) => provider.supports_tools === true),
    structuredOutput: providers.some((provider) => provider.supports_structured_output === true),
  };
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

export function buildHuggingFaceModel(
  model: HuggingFaceModel,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveHuggingFaceBaseModel(model.id) : existing.base_model,
  aggregate: Aggregate = aggregateProviders(model),
): SyncedModel {
  const input = modalities(model.architecture.input_modalities, existing?.modalities?.input ?? ["text"]);
  const output = modalities(model.architecture.output_modalities, existing?.modalities?.output ?? ["text"]);
  // Pricing is curated: keep what was authored and only fall back to the router
  // (fastest route) when the local model has no cost yet.
  const cost = existing?.cost ?? aggregate.cost;
  // context/output may be unset for a freshly created base_model entry, in which case
  // factorBaseModel inherits them from the canonical metadata; the standalone-model
  // path below validates their presence at runtime.
  const limit = {
    context: existing?.limit?.context ?? aggregate.context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  } as SyncedFullModel["limit"];
  const values: Partial<SyncedFullModel> = {
    name: existing?.name,
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment: input.some((value) => value !== "text"),
    reasoning: existing?.reasoning,
    reasoning_options: existing?.reasoning_options,
    temperature: existing?.temperature,
    tool_call: aggregate.tools || existing?.tool_call || undefined,
    structured_output: aggregate.structuredOutput || existing?.structured_output || undefined,
    knowledge: existing?.knowledge,
    open_weights: existing?.open_weights ?? true,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  // Standalone (non base_model) models require concrete booleans the router does
  // not always report; default the capability flags it leaves out.
  const full = { ...values, tool_call: values.tool_call ?? false };
  const required = z.object({
    name: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    reasoning: z.boolean(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    limit: z.object({ context: z.number(), output: z.number() }),
  }).safeParse(full);
  if (!required.success) {
    throw new Error(`Hugging Face model ${model.id} has incomplete local metadata required for sync`);
  }
  return full as SyncedFullModel;
}

export function resolveHuggingFaceBaseModel(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const canonicalPrefix = CANONICAL_ORG_PREFIXES[prefix];
  if (canonicalPrefix === undefined) return resolveCanonicalBaseModel(id);
  return resolveCanonicalBaseModel(`${canonicalPrefix}/${parts.join("/").toLowerCase()}`);
}
