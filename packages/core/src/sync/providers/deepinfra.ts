import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

// Public DeepInfra deploy catalog. Richer than the OpenAI-compatible
// `/v1/openai/models` endpoint: it exposes capability tags (tools,
// structured-output, multimodal, input-audio/video, reasoning), token pricing,
// the served context window, and deprecation state.
const API_ENDPOINT = "https://api.deepinfra.com/models/list?type=text-generation";

export const DeepInfraModel = z.object({
  model_name: z.string().min(1),
  type: z.string(),
  tags: z.array(z.string()).nullish(),
  pricing: z.object({
    type: z.string().nullish(),
    cents_per_input_token: z.number().nullish(),
    cents_per_output_token: z.number().nullish(),
    // Cache rates are multipliers applied to the input price, not absolute prices.
    rate_per_input_token_cached: z.number().nullish(),
    rate_per_input_token_cache_write: z.number().nullish(),
    // Free-text breakdown of context-based pricing tiers, when the model has them.
    full: z.string().nullish(),
  }).passthrough().nullish(),
  // DeepInfra's `max_tokens` is the served context window, not a completion cap.
  max_tokens: z.number().int().positive().nullish(),
  // null when active; a unix timestamp (possibly in the future) when scheduled.
  deprecated: z.union([z.number(), z.string(), z.boolean()]).nullish(),
  private: z.number().nullish(),
}).passthrough();

export const DeepInfraResponse = z.array(DeepInfraModel);

export type DeepInfraModel = z.infer<typeof DeepInfraModel>;

// DeepInfra resells some proprietary models via passthrough. We exclude those
// closed-weight families from this provider's catalog (open Google `gemma-*`
// models are kept — only `gemini-*` is dropped).
const EXCLUDED_PATTERNS = [/^anthropic\//, /^google\/gemini/];

function isExcluded(modelName: string) {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(modelName));
}

export const deepinfra = {
  id: "deepinfra",
  name: "Deep Infra",
  modelsDir: "providers/deepinfra/models",
  // DeepInfra rotates served models frequently; never delete local TOMLs
  // automatically — surface them for manual lifecycle review instead.
  deleteMissing: false,
  sourceID(model) {
    return model.model_name;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Deep Infra models were not created because they lacked provider-agnostic metadata to inherit (no \`models/\` entry) and the API does not supply the required curated fields, or because they are already deprecated.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
      "Add a `models/<provider>/<model>.toml` entry (or a full provider TOML) to include them in the next sync.",
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Deep Infra models were absent from the live API and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    return fetchDeepInfraModels(process.env.DEEPINFRA_API_KEY);
  },
  parseModels(raw) {
    return DeepInfraResponse.parse(raw).filter((model) =>
      model.type === "text-generation"
      && !model.private
      && !isExcluded(model.model_name),
    );
  },
  translateModel(model, context) {
    const id = model.model_name;
    const existing = context.existing(id);
    const baseModel = existing === undefined
      ? resolveDeepInfraBaseModel(id)
      : existing.base_model;

    const inputCost = perMillion(model.pricing?.cents_per_input_token);
    const outputCost = perMillion(model.pricing?.cents_per_output_token);

    // A brand-new model we can neither inherit nor price has nothing to author.
    if (existing === undefined && baseModel === undefined) return undefined;
    if (
      existing === undefined
      && (inputCost === undefined || outputCost === undefined)
    ) return undefined;
    // Don't introduce brand-new entries for models that are already deprecated;
    // existing entries are kept and marked instead.
    if (existing === undefined && isDeprecated(model)) return undefined;

    return {
      id,
      model: buildDeepInfraModel(model, existing, baseModel),
    };
  },
} satisfies SyncProvider<DeepInfraModel>;

export async function fetchDeepInfraModels(
  key: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(API_ENDPOINT, {
    headers: key === undefined ? undefined : { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Deep Infra models request failed: ${response.status} ${response.statusText}`);
  }
  return DeepInfraResponse.parse(await response.json());
}

function isDeprecated(model: DeepInfraModel) {
  const deprecated = model.deprecated;
  if (deprecated === undefined || deprecated === null || deprecated === false) {
    return false;
  }
  // Numeric values are unix (seconds) timestamps. A future timestamp is a
  // scheduled deprecation — the model is still served until then.
  if (typeof deprecated === "number") return deprecated * 1000 <= Date.now();
  return Boolean(deprecated);
}

// DeepInfra prices in cents per token; the catalog uses USD per million tokens.
// cents/token * 1e6 tokens / 100 cents-per-dollar = cents/token * 10_000.
function perMillion(centsPerToken: number | null | undefined) {
  if (centsPerToken === undefined || centsPerToken === null) return undefined;
  if (!Number.isFinite(centsPerToken) || centsPerToken < 0) return undefined;
  return round(centsPerToken * 10_000);
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// DeepInfra's API exposes cache pricing via `rate_per_input_token_cached`
// (a multiplier on the input price). When that rate is null the model has no
// cache pricing, so the (possibly stale) curated value is cleared.
function cacheCost(inputCost: number, rate: number | null | undefined) {
  return rate == null ? undefined : round(inputCost * rate);
}

function buildCost(
  model: DeepInfraModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["cost"] | undefined {
  const inputCost = perMillion(model.pricing?.cents_per_input_token);
  const outputCost = perMillion(model.pricing?.cents_per_output_token);
  // No usable API price — leave the curated cost untouched.
  if (inputCost === undefined || outputCost === undefined) return existing?.cost;

  const cacheWriteRate = model.pricing?.rate_per_input_token_cache_write;
  const tiered = parseTieredPricing(model.pricing?.full);

  if (tiered !== undefined) {
    const base = tiered.base;
    return {
      input: round(base.input),
      output: round(base.output),
      reasoning: existing?.cost?.reasoning,
      cache_read: base.cache_read === undefined ? undefined : round(base.cache_read),
      cache_write: cacheWriteRate == null ? undefined : round(base.input * cacheWriteRate),
      tiers: tiered.tiers.map((tier) => ({
        tier: { type: "context" as const, size: tier.size },
        input: round(tier.input),
        output: round(tier.output),
        cache_read: tier.cache_read === undefined ? undefined : round(tier.cache_read),
      })),
    };
  }

  return {
    input: inputCost,
    output: outputCost,
    reasoning: existing?.cost?.reasoning,
    cache_read: cacheCost(inputCost, model.pricing?.rate_per_input_token_cached),
    cache_write: cacheCost(inputCost, cacheWriteRate),
    // API pricing is flat (or its tier string was unparseable): clear any stale
    // curated tiers rather than leaving obsolete thresholds active.
    tiers: undefined,
  };
}

interface ParsedSegment {
  input: number;
  output: number;
  cache_read: number | undefined;
  bound: number | undefined;
}

// Parses DeepInfra's free-text tiered-pricing string, e.g.
//   "$1.2 in $6 out $0.24 cached <= 32K, $2.4 in $12 out $0.48 cached <= 128K, $3 in $15 out $0.6 cached > 128K"
// into a base cost (cheapest tier) plus context tiers keyed by the lower bound
// at which each higher tier starts. Returns undefined for flat pricing or any
// string that does not match the expected shape (caller falls back to the flat
// per-token price), so a format change degrades gracefully instead of mispricing.
function parseTieredPricing(full: string | null | undefined) {
  if (full == null || !/[\d.]\s*[KM]\b/i.test(full)) return undefined;
  const segments = full.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return undefined;

  const parsed: ParsedSegment[] = [];
  for (const segment of segments) {
    // The bound (`<= 32K` / `> 128K`) is optional: the final tier is often
    // unbounded (e.g. ByteDance/Seed-2.0-code "$1 in $6 out $0.20 cached").
    const match = segment.match(
      /^\$\s*([\d.]+)\s+in\s+\$\s*([\d.]+)\s+out(?:\s+\$\s*([\d.]+)\s+cached)?(?:\s+(?:<=|>)\s*([\d.]+)\s*([KM]))?\s*$/i,
    );
    if (match === null) {
      console.warn(`Deep Infra: unrecognized tiered pricing, using flat price: ${full}`);
      return undefined;
    }
    const cached = match[3];
    const size = match[4];
    parsed.push({
      input: Number(match[1]),
      output: Number(match[2]),
      cache_read: cached === undefined ? undefined : Number(cached),
      bound: size === undefined
        ? undefined
        : Math.round(Number(size) * (match[5]!.toUpperCase() === "M" ? 1_000_000 : 1_000)),
    });
  }

  // Every segment except the last must carry a bound — the next tier starts at
  // the previous segment's upper bound, so a missing interior bound is unparseable.
  if (parsed.slice(0, -1).some((segment) => segment.bound === undefined)) {
    console.warn(`Deep Infra: tiered pricing missing interior bound, using flat price: ${full}`);
    return undefined;
  }

  const tiers = parsed.slice(1).map((segment, index) => ({
    size: parsed[index]!.bound!,
    input: segment.input,
    output: segment.output,
    cache_read: segment.cache_read,
  }));
  for (let index = 1; index < tiers.length; index++) {
    if (tiers[index]!.size <= tiers[index - 1]!.size) return undefined;
  }

  return { base: parsed[0]!, tiers };
}

export function buildDeepInfraModel(
  model: DeepInfraModel,
  existing: ExistingModel | undefined,
  baseModel = existing === undefined ? resolveDeepInfraBaseModel(model.model_name) : existing.base_model,
): SyncedModel {
  const tags = new Set(model.tags ?? []);

  // Capabilities are derived from the live tags (authoritative), falling back to
  // curated values only where no tag expresses the capability.
  // Capability tags only ever turn a feature ON (DeepInfra's tagging is
  // incomplete — e.g. reasoning models without a reasoning tag), with the sole
  // exception of the explicit `non-reasoning` tag. When no tag speaks to a
  // capability we leave it unset so it inherits the canonical `models/` metadata
  // (base_model entries) or keeps the curated value (full definitions), rather
  // than clobbering it with a `false`/default.
  const reasoning = tags.has("reasoning") || tags.has("can-disable-reasoning")
    ? true
    : tags.has("non-reasoning")
      ? false
      : existing?.reasoning;
  const toolCall = tags.has("tools") ? true : existing?.tool_call;
  // `structured-output` marks dedicated structured output (JSON schema); the
  // generic `json` tag only means JSON mode, so it does not count here.
  const structuredOutput = tags.has("structured-output") || tags.has("structured_output")
    ? true
    : existing?.structured_output;
  // `can-disable-reasoning` means a reasoning on/off toggle exists. Surface that
  // as an explicit option, but never override curated options (e.g. effort scales).
  const reasoningOptions = existing?.reasoning_options
    ?? (tags.has("can-disable-reasoning") ? [{ type: "toggle" as const }] : undefined);

  // Modalities are model-intrinsic. Merge the tag-derived inputs into existing
  // values for full definitions (never dropping curated extras like video); for
  // new base_model entries leave them unset so they inherit from metadata.
  const derivedModalities: Modality[] = [];
  if (tags.has("multimodal")) derivedModalities.push("image");
  if (tags.has("input-audio")) derivedModalities.push("audio");
  if (tags.has("input-video")) derivedModalities.push("video");
  const unsupportedModalities = UNSUPPORTED_MODALITIES[model.model_name];
  const inputModalities = existing?.modalities?.input !== undefined || derivedModalities.length > 0
    ? mergeModalities(existing?.modalities?.input, derivedModalities)
        .filter((value) => !unsupportedModalities?.has(value))
    : undefined;
  const modalities = inputModalities === undefined
    ? undefined
    : { input: inputModalities, output: existing?.modalities?.output ?? ["text"] };
  const attachment = inputModalities === undefined
    ? existing?.attachment
    : inputModalities.some((value) => value !== "text");

  const cost = buildCost(model, existing);

  // Only the context window is sourced from the API; the curated input/output
  // limits stay authoritative (the API exposes no real completion cap).
  const limit = {
    context: model.max_tokens ?? existing?.limit?.context,
    input: existing?.limit?.input,
    output: existing?.limit?.output,
  } as SyncedFullModel["limit"];

  const deprecated = isDeprecated(model);
  const status = deprecated
    ? "deprecated"
    : existing?.status === "deprecated"
      ? undefined
      : existing?.status;

  const values: Partial<SyncedFullModel> = {
    // For base_model entries the display name is inherited from `models/`;
    // deriveName is only a fallback for standalone full definitions.
    name: existing?.name ?? (baseModel !== undefined ? undefined : deriveName(model.model_name)),
    family: existing?.family,
    release_date: existing?.release_date,
    last_updated: existing?.last_updated,
    attachment,
    reasoning,
    reasoning_options: reasoningOptions,
    // No tag expresses temperature support, so always inherit/preserve it.
    temperature: existing?.temperature,
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge: existing?.knowledge,
    // open_weights is a model-intrinsic fact: always inherit it from `models/`
    // for base_model entries (so proprietary passthrough models like Claude keep
    // open_weights=false), and only carry it on standalone full definitions.
    open_weights: baseModel !== undefined ? undefined : existing?.open_weights,
    status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities,
  };

  if (baseModel !== undefined) {
    if (limit.context === undefined) {
      throw new Error(`Deep Infra model ${model.model_name} is missing a context length required for sync`);
    }
    // Everything except context / cost / capability flags is inherited from the
    // `models/` metadata.
    return factorBaseModel(baseModel, values, limit, existing?.base_model_omit);
  }

  const required = z.object({
    name: z.string(),
    release_date: z.string(),
    last_updated: z.string(),
    open_weights: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    limit: z.object({ context: z.number(), output: z.number() }),
  }).safeParse(values);
  if (!required.success) {
    throw new Error(`Deep Infra model ${model.model_name} has incomplete local metadata required for sync`);
  }
  return values as SyncedFullModel;
}

// DeepInfra uses Hugging Face style `org/model` IDs. Map the org prefix to the
// catalog's canonical metadata namespace so new models can inherit via
// `base_model` whenever a `models/` entry already exists.
const DEEPINFRA_PREFIXES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  "meta-llama": "meta",
  google: "google",
  microsoft: "microsoft",
  MiniMaxAI: "minimax",
  mistralai: "mistralai",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  Qwen: "qwen",
  XiaomiMiMo: "xiaomi",
  "zai-org": "zai",
};

export function resolveDeepInfraBaseModel(id: string) {
  const [prefix, ...parts] = id.split("/");
  if (prefix === undefined || parts.length === 0) return undefined;
  const canonicalPrefix = DEEPINFRA_PREFIXES[prefix];
  if (canonicalPrefix === undefined) return resolveCanonicalBaseModel(id);
  return resolveCanonicalBaseModel(`${canonicalPrefix}/${parts.join("/").toLowerCase()}`);
}

function deriveName(id: string) {
  const modelPart = id.split("/").at(-1) ?? id;
  return modelPart.replace(/[-_]+/g, " ").trim();
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const ALLOWED_MODALITIES = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);

// DeepInfra currently applies `input-audio` to the whole Gemma 4 family, but
// its model page limits audio input to the E2B and E4B variants.
const UNSUPPORTED_MODALITIES: Record<string, Set<Modality>> = {
  "google/gemma-4-31B-it": new Set(["audio"]),
};

function mergeModalities(existing: string[] | undefined, add: Modality[]): Modality[] {
  const result = new Set<Modality>(["text"]);
  for (const value of existing ?? []) {
    const lowered = value.toLowerCase();
    if (ALLOWED_MODALITIES.has(lowered as Modality)) result.add(lowered as Modality);
  }
  for (const value of add) result.add(value);
  return [...result];
}
