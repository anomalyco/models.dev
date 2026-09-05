import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import {
  factorBaseModel,
  modelMetadata,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// ========================================
// Constants
// ========================================

const API_ENDPOINT = "https://api.edenai.run/v3/models";
const MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "models",
);
const PROVIDERS_DIR = path.join(MODELS_DIR, "..", "providers");
const TOKENS_PER_MILLION = 1_000_000;
const PRICE_DECIMALS = 1_000_000;

// Values `reasoning_effort` accepts on POST /v3/chat/completions. Which of them
// a given model exposes comes from its lab entry, not from this list.
const ACCEPTED_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const REGION_SUFFIX = /@[a-z0-9-]+$/i;
const DOTTED_VENDOR = /^[a-z0-9-]+\./;
const VERSION_TAIL = /-v\d+:\d+$/;
const DATE_TAIL = /-\d{8}$/;
const DATABRICKS_PREFIX = "databricks-";
const TIER_KEY = /^input_cost_per_token_above_(\d+)k_tokens$/;

const MODALITY_BY_EDENAI: Record<
  string,
  SyncedFullModel["modalities"]["input"][number]
> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  file: "pdf",
};

// Upstreams that are the lab's own API for models under that namespace.
const LAB_UPSTREAMS: Record<string, readonly string[]> = {
  alibaba: ["qwen"],
  amazon: ["amazon"],
  anthropic: ["anthropic"],
  cohere: ["cohere"],
  deepseek: ["deepseek"],
  google: ["google", "vertex"],
  microsoft: ["microsoft"],
  minimax: ["minimax"],
  mistral: ["mistral"],
  moonshotai: ["moonshot"],
  openai: ["openai"],
  perplexity: ["perplexityai"],
  xai: ["xai"],
  zhipuai: ["zai"],
};

type ReasoningOption = NonNullable<
  SyncedFullModel["reasoning_options"]
>[number];

const canonicalNameByID = new Map<string, string>();

let firstPartyBaseModels: ReadonlySet<string> = new Set();

// ========================================
// Schemas
// ========================================

const EdenAIPricing = z
  .object({
    input_cost_per_token: z.number().nullish(),
    output_cost_per_token: z.number().nullish(),
    output_cost_per_reasoning_token: z.number().nullish(),
    cache_read_input_token_cost: z.number().nullish(),
    cache_creation_input_token_cost: z.number().nullish(),
    input_cost_per_audio_token: z.number().nullish(),
  })
  .passthrough();

const EdenAICapabilities = z
  .object({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
    supports_function_calling: z.boolean().optional(),
    supports_response_schema: z.boolean().optional(),
  })
  .passthrough();

export const EdenAIModel = z
  .object({
    id: z.string().min(1),
    owned_by: z.string().min(1),
    model_name: z.string().min(1),
    context_length: z.number().nullish(),
    capabilities: EdenAICapabilities,
    pricing: EdenAIPricing.nullish(),
    list_pricing: EdenAIPricing.nullish(),
    alias_of: z.string().nullish(),
  })
  .passthrough();

export const EdenAIResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(EdenAIModel),
  })
  .passthrough();

export type EdenAIModel = z.infer<typeof EdenAIModel>;

// ========================================
// Base model resolution
// ========================================

function baseModelExists(modelID: string) {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

// Ids are `<upstream>/<native id>`, so each upstream keeps its own convention.
function baseModelCandidates(modelName: string) {
  const candidates = [modelName];

  if (DOTTED_VENDOR.test(modelName)) {
    const dotted = modelName.replace(".", "/");
    candidates.push(
      dotted,
      dotted.replace(VERSION_TAIL, "").replace(DATE_TAIL, ""),
    );
  }

  const last = modelName.split("/").at(-1) ?? modelName;
  candidates.push(last);
  if (last.startsWith(DATABRICKS_PREFIX)) {
    candidates.push(last.slice(DATABRICKS_PREFIX.length));
  }
  candidates.push(last.replace(VERSION_TAIL, "").replace(DATE_TAIL, ""));

  return [...new Set(candidates)].filter((candidate) => candidate.length > 0);
}

export function resolveEdenAIBaseModel(model: EdenAIModel) {
  const names = [model.model_name.replace(REGION_SUFFIX, "")];
  if (model.alias_of != null) {
    const target = model.alias_of.split("/").slice(1).join("/");
    if (target.length > 0) names.push(target);
  }

  for (const name of names) {
    for (const candidate of baseModelCandidates(name)) {
      const resolved = resolveModelMetadataBaseModel(candidate);
      if (resolved !== undefined && baseModelExists(resolved)) return resolved;
    }
  }
  return undefined;
}

function isFirstPartyRoute(model: EdenAIModel, baseModel: string) {
  const lab = baseModel.split("/")[0] ?? "";
  return (LAB_UPSTREAMS[lab] ?? []).includes(model.owned_by);
}

export function collectFirstPartyBaseModels(models: readonly EdenAIModel[]) {
  const bases = new Set<string>();
  for (const model of models) {
    const baseModel = resolveEdenAIBaseModel(model);
    if (baseModel !== undefined && isFirstPartyRoute(model, baseModel)) {
      bases.add(baseModel);
    }
  }
  return bases;
}

function canonicalModelName(baseModel: string) {
  let cached = canonicalNameByID.get(baseModel);
  if (cached === undefined) {
    try {
      const toml = Bun.TOML.parse(
        readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
      ) as { name?: unknown };
      cached = typeof toml.name === "string" ? toml.name : "";
    } catch {
      cached = "";
    }
    canonicalNameByID.set(baseModel, cached);
  }
  return cached === "" ? undefined : cached;
}

function hasOutputLimit(baseModel: string) {
  const limit = modelMetadata(baseModel).limit;
  return (
    typeof limit === "object" &&
    limit !== null &&
    typeof (limit as { output?: unknown }).output === "number"
  );
}

function titleCaseSlug(slug: string) {
  return slug
    .split(/[-_]/)
    .filter((word) => word.length > 0)
    .map((word) =>
      word.toLowerCase() === "gpt"
        ? "GPT"
        : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function isLatestAlias(model: EdenAIModel) {
  if (model.alias_of == null) return false;
  const id = model.id.replace(REGION_SUFFIX, "");
  const target = model.alias_of.replace(REGION_SUFFIX, "");
  if (id.toLowerCase() === target.toLowerCase()) return false;
  const slug = id.split("/").at(-1) ?? id;
  return /(?:^|-)latest$/i.test(slug);
}

function displayName(model: EdenAIModel, baseModel: string) {
  const region = REGION_SUFFIX.exec(model.id)?.[0].slice(1);
  const latest = isLatestAlias(model);
  if (region === undefined && !latest) return undefined;

  const canonical = canonicalModelName(baseModel);
  if (canonical === undefined) return undefined;
  if (latest) {
    const slug = model.id.replace(REGION_SUFFIX, "").split("/").at(-1) ?? "";
    const name = `${titleCaseSlug(slug)} (${canonical})`;
    return region === undefined ? name : `${name} (${region.toUpperCase()})`;
  }
  return `${canonical} (${region.toUpperCase()})`;
}

// ========================================
// Reasoning options
// ========================================

// This sync currently maps only `reasoning_effort`, using the effort list the
// lab entry (or an established relay peer) documents. Toggle / budget controls
// need route-specific mappings. Preserve authored controls when unresolved;
// skip new models rather than inventing an empty control set.
function effortValues(options: unknown): string[] | "always-on" | undefined {
  if (!Array.isArray(options)) return undefined;
  if (options.length === 0) return "always-on";

  let toggled = false;
  let accepted: string[] | undefined;

  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    const type = (option as { type?: unknown }).type;
    if (type === "toggle") toggled = true;
    if (type !== "effort") continue;

    const values = (option as { values?: unknown }).values;
    if (!Array.isArray(values)) continue;
    const filtered = values.filter(
      (value): value is string =>
        typeof value === "string" && ACCEPTED_EFFORTS.has(value),
    );
    if (filtered.length > 0) accepted = filtered;
  }

  if (accepted === undefined) return undefined;
  // Eden AI switches reasoning off with `reasoning_effort=none`, so a lab-side
  // toggle becomes `none` in the effort list instead of a separate option.
  return toggled && !accepted.includes("none")
    ? ["none", ...accepted]
    : accepted;
}

function parseToml(filePath: string) {
  try {
    return Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function tomlFilesIn(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? tomlFilesIn(path.join(dir, entry.name))
      : entry.name.endsWith(".toml")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

// OpenRouter is the established same-surface relay, so it is the one peer
// consulted when a lab entry documents no effort levels.
const PEER_PROVIDER = "openrouter";

let peerEfforts: Map<string, string[] | "always-on"> | undefined;

function peerEffortsByBaseModel() {
  if (peerEfforts !== undefined) return peerEfforts;

  peerEfforts = new Map();
  for (const file of tomlFilesIn(
    path.join(PROVIDERS_DIR, PEER_PROVIDER, "models"),
  )) {
    const toml = parseToml(file);
    const base = toml?.base_model;
    if (typeof base !== "string" || peerEfforts.has(base)) continue;
    const values = effortValues(toml?.reasoning_options);
    if (values !== undefined) peerEfforts.set(base, values);
  }
  return peerEfforts;
}

export function reasoningOptionsFor(
  baseModel: string,
): SyncedFullModel["reasoning_options"] | undefined {
  const [lab, ...rest] = baseModel.split("/");
  const firstParty = effortValues(
    parseToml(
      path.join(PROVIDERS_DIR, lab ?? "", "models", `${rest.join("/")}.toml`),
    )?.reasoning_options,
  );
  const derived = firstParty ?? peerEffortsByBaseModel().get(baseModel);

  if (derived === undefined) return undefined;
  if (derived === "always-on") return [];
  return [{ type: "effort", values: derived } as ReasoningOption];
}

// ========================================
// Cost
// ========================================

function pricePerMillion(price: number) {
  return (
    Math.round(price * TOKENS_PER_MILLION * PRICE_DECIMALS) / PRICE_DECIMALS
  );
}

function chargedPricePerMillion(price: unknown) {
  return typeof price === "number" && price > 0
    ? pricePerMillion(price)
    : undefined;
}

function costTiers(pricing: Record<string, unknown>) {
  const thresholds = Object.keys(pricing)
    .map((key) => TIER_KEY.exec(key)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  return thresholds.flatMap((threshold) => {
    // Built explicitly so `..._above_1hr_above_200k_tokens` is never read as a
    // context tier.
    const suffix = `_above_${threshold}k_tokens`;
    const input = pricing[`input_cost_per_token${suffix}`];
    const output = pricing[`output_cost_per_token${suffix}`];
    if (typeof input !== "number" || typeof output !== "number") return [];

    return [
      {
        tier: { type: "context" as const, size: threshold * 1_000 },
        input: pricePerMillion(input),
        output: pricePerMillion(output),
        cache_read: chargedPricePerMillion(
          pricing[`cache_read_input_token_cost${suffix}`],
        ),
        cache_write: chargedPricePerMillion(
          pricing[`cache_creation_input_token_cost${suffix}`],
        ),
      },
    ];
  });
}

function buildCost(
  model: EdenAIModel,
  reasoning: boolean,
): SyncedFullModel["cost"] {
  // `pricing` carries account-level discounts; `list_pricing` is the public rate.
  const pricing = model.list_pricing ?? model.pricing;
  if (pricing == null) return undefined;

  const input = pricing.input_cost_per_token;
  const output = pricing.output_cost_per_token;
  if (input == null || output == null) return undefined;

  const tiers = costTiers(pricing);
  return {
    input: pricePerMillion(input),
    output: pricePerMillion(output),
    reasoning: reasoning
      ? chargedPricePerMillion(pricing.output_cost_per_reasoning_token)
      : undefined,
    cache_read: chargedPricePerMillion(pricing.cache_read_input_token_cost),
    cache_write: chargedPricePerMillion(
      pricing.cache_creation_input_token_cost,
    ),
    input_audio: chargedPricePerMillion(pricing.input_cost_per_audio_token),
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

// ========================================
// Model translation
// ========================================

function mapModalities(values: readonly string[] | null | undefined) {
  if (values == null) return undefined;

  const mapped = [
    ...new Set(
      values
        .map((value) => MODALITY_BY_EDENAI[value.toLowerCase()])
        .filter(
          (value): value is NonNullable<typeof value> => value !== undefined,
        ),
    ),
  ];
  return mapped.length > 0 ? mapped : undefined;
}

export function buildEdenAIModel(
  model: EdenAIModel,
  existing?: ExistingModel,
  firstParty: ReadonlySet<string> = firstPartyBaseModels,
): SyncedModel | undefined {
  const baseModel = resolveEdenAIBaseModel(model);
  // Eden AI relays other labs' models only, so an entry needs its lab metadata.
  if (baseModel === undefined) return undefined;
  // The catalog reports no output limit, so the base has to resolve one.
  if (!hasOutputLimit(baseModel)) return undefined;
  // Where Eden AI relays the lab's own API, that route is the entry. Models
  // with no first-party route keep every route, since their prices differ and
  // there is no canonical one to pick.
  if (firstParty.has(baseModel) && !isFirstPartyRoute(model, baseModel)) {
    return undefined;
  }

  const capabilities = model.capabilities;
  const input = mapModalities(capabilities.input_modalities);
  const output = mapModalities(capabilities.output_modalities);
  const modalities =
    input !== undefined && output !== undefined ? { input, output } : undefined;

  // Whether a model reasons is a property of the model, not of the relay, so
  // the lab entry owns it and only the effort controls are authored here.
  const reasoning = modelMetadata(baseModel).reasoning === true;
  const reasoningOptions = reasoning
    ? reasoningOptionsFor(baseModel) ?? existing?.reasoning_options
    : undefined;
  if (reasoning && reasoningOptions === undefined) return undefined;

  const limit =
    model.context_length != null && model.context_length > 0
      ? { context: model.context_length }
      : undefined;

  return factorBaseModel(
    baseModel,
    {
      name: displayName(model, baseModel),
      modalities,
      attachment: input?.some((value) => value !== "text"),
      reasoning_options: reasoningOptions,
      tool_call: capabilities.supports_function_calling,
      structured_output: capabilities.supports_response_schema,
      cost: buildCost(model, reasoning),
      limit,
    },
    limit,
  );
}

// ========================================
// Eden AI provider
// ========================================

export const edenai = {
  id: "edenai",
  name: "Eden AI",
  modelsDir: "providers/edenai/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Eden AI request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    const unique = new Map<string, EdenAIModel>();
    for (const model of EdenAIResponse.parse(raw).data) {
      const key = model.id.toLowerCase();
      const previous = unique.get(key);
      // Eden AI publishes case-only duplicates that collide on macOS. Keep the
      // lowercase API ID, but retain context metadata supplied by its duplicate.
      const preferred = model.id === key ? model : previous ?? model;
      unique.set(key, {
        ...preferred,
        context_length: preferred.context_length ?? previous?.context_length ?? model.context_length,
      });
    }
    const models = [...unique.values()];
    firstPartyBaseModels = collectFirstPartyBaseModels(models);
    return models;
  },
  translateModel(model, context) {
    const built = buildEdenAIModel(model, context.existing(model.id));
    if (built === undefined) return undefined;
    return { id: model.id, model: built };
  },
} satisfies SyncProvider<EdenAIModel>;
