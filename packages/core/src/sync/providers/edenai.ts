import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import {
  factorBaseModel,
  modelMetadata,
  normalizeModelSlug,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// ========================================
// Constants
// ========================================

// One entry per routable model name, with the providers that sell it nested
// under `endpoints`. Requests name the model only and Eden AI picks the
// provider: https://www.edenai.co/docs/v3/llms/provider-routing
const API_ENDPOINT = "https://api.edenai.run/v3/models?view=models";
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

type ReasoningOption = NonNullable<
  SyncedFullModel["reasoning_options"]
>[number];

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

export const EdenAIEndpoint = z
  .object({
    id: z.string().min(1),
    context_length: z.number().nullish(),
    capabilities: EdenAICapabilities,
    pricing: EdenAIPricing.nullish(),
  })
  .passthrough();

export const EdenAIModel = z
  .object({
    id: z.string().min(1),
    owned_by: z.string(),
    endpoints: z.array(EdenAIEndpoint),
  })
  .passthrough();

export const EdenAIResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(EdenAIModel),
  })
  .passthrough();

export type EdenAIEndpoint = z.infer<typeof EdenAIEndpoint>;
export type EdenAIModel = z.infer<typeof EdenAIModel>;
type EdenAIPricing = z.infer<typeof EdenAIPricing>;

// ========================================
// Base model resolution
// ========================================

function baseModelExists(modelID: string) {
  return existsSync(path.join(MODELS_DIR, `${modelID}.toml`));
}

// Eden AI names a model after its lab's id, so the lab tree resolves it
// directly (`claude-sonnet-5.5` to `anthropic/claude-sonnet-5-5`).
export function resolveEdenAIBaseModel(model: EdenAIModel) {
  for (const candidate of [`${model.owned_by}/${model.id}`, model.id]) {
    const resolved = resolveModelMetadataBaseModel(candidate);
    if (resolved !== undefined && baseModelExists(resolved)) return resolved;
  }
  return undefined;
}

function hasOutputLimit(baseModel: string) {
  const limit = modelMetadata(baseModel).limit;
  return (
    typeof limit === "object" &&
    limit !== null &&
    typeof (limit as { output?: unknown }).output === "number"
  );
}

// A name that resolves onto another model's lab entry (`glm-5.3-fast` onto
// `glm-5.3`) is a different offering, so it must not share that model's name.
function displayName(model: EdenAIModel, baseModel: string) {
  const baseSlug = baseModel.split("/").at(-1) ?? baseModel;
  if (normalizeModelSlug(model.id) === normalizeModelSlug(baseSlug)) {
    return undefined;
  }
  const canonical = modelMetadata(baseModel).name;
  return typeof canonical === "string" ? `${canonical} (${model.id})` : undefined;
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
// Provider selection
// ========================================

type RoutableEndpoint = EdenAIEndpoint & {
  pricing: EdenAIPricing & {
    input_cost_per_token: number;
    output_cost_per_token: number;
  };
};

// What the router accepts as a provider: it drops any whose effective price
// lacks an input or output rate. A `@region` endpoint is a regional pin that a
// bare model name never reaches on the global endpoint.
function isRoutable(endpoint: EdenAIEndpoint): endpoint is RoutableEndpoint {
  return (
    !REGION_SUFFIX.test(endpoint.id) &&
    endpoint.pricing?.input_cost_per_token != null &&
    endpoint.pricing?.output_cost_per_token != null
  );
}

// Input, output and cache-read rates at the precision this catalog publishes,
// so float noise in a converted rate never decides the order. A provider that
// lists no cache-read rate bills cache reads as input.
function sortRates({ pricing }: RoutableEndpoint) {
  return [
    pricePerMillion(pricing.input_cost_per_token),
    pricePerMillion(pricing.output_cost_per_token),
    pricePerMillion(
      pricing.cache_read_input_token_cost ?? pricing.input_cost_per_token,
    ),
  ] as const;
}

// Cheapest input rate, then output rate, as Eden AI's default `cost` routing
// ranks providers. Providers often tie on both, so the cache-read rate breaks
// the tie before the id.
function byPrice(a: RoutableEndpoint, b: RoutableEndpoint) {
  const [aInput, aOutput, aCacheRead] = sortRates(a);
  const [bInput, bOutput, bCacheRead] = sortRates(b);
  return (
    aInput - bInput ||
    aOutput - bOutput ||
    aCacheRead - bCacheRead ||
    a.id.localeCompare(b.id)
  );
}

// Routing does not filter on capability, so a model can do what any of its
// providers can.
function anyProvider(
  endpoints: readonly EdenAIEndpoint[],
  flag: "supports_function_calling" | "supports_response_schema",
) {
  const values = endpoints
    .map((endpoint) => endpoint.capabilities[flag])
    .filter((value) => value !== undefined);
  return values.length > 0 ? values.includes(true) : undefined;
}

// Routing skips providers whose window cannot hold the request, so the
// largest window is reachable.
function largestContext(endpoints: readonly EdenAIEndpoint[]) {
  return (
    Math.max(0, ...endpoints.map((endpoint) => endpoint.context_length ?? 0)) ||
    undefined
  );
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

// `pricing` is what Eden AI charges, after any discount on the model; it is
// the same for every caller.
function buildCost(
  pricing: RoutableEndpoint["pricing"],
  reasoning: boolean,
): SyncedFullModel["cost"] {
  const tiers = costTiers(pricing);
  return {
    input: pricePerMillion(pricing.input_cost_per_token),
    output: pricePerMillion(pricing.output_cost_per_token),
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

function mapModalities(
  endpoints: readonly EdenAIEndpoint[],
  key: "input_modalities" | "output_modalities",
) {
  const mapped = [
    ...new Set(
      endpoints
        .flatMap((endpoint) => endpoint.capabilities[key] ?? [])
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
): SyncedModel | undefined {
  const baseModel = resolveEdenAIBaseModel(model);
  // Eden AI relays other labs' models only, so an entry needs its lab metadata.
  if (baseModel === undefined) return undefined;
  // The catalog reports no output limit, so the base has to resolve one.
  if (!hasOutputLimit(baseModel)) return undefined;

  const routable = model.endpoints.filter(isRoutable).sort(byPrice);
  const cheapest = routable[0];
  if (cheapest === undefined) return undefined;

  const input = mapModalities(routable, "input_modalities");
  const output = mapModalities(routable, "output_modalities");
  const modalities =
    input !== undefined && output !== undefined ? { input, output } : undefined;

  // Whether a model reasons is a property of the model, not of the relay, so
  // the lab entry owns it and only the effort controls are authored here.
  const reasoning = modelMetadata(baseModel).reasoning === true;
  const reasoningOptions = reasoning
    ? reasoningOptionsFor(baseModel) ?? existing?.reasoning_options
    : undefined;
  if (reasoning && reasoningOptions === undefined) return undefined;

  const context = largestContext(routable);
  const limit = context !== undefined ? { context } : undefined;

  return factorBaseModel(
    baseModel,
    {
      name: displayName(model, baseModel),
      modalities,
      attachment: input?.some((value) => value !== "text"),
      reasoning_options: reasoningOptions,
      tool_call: anyProvider(routable, "supports_function_calling"),
      structured_output: anyProvider(routable, "supports_response_schema"),
      cost: buildCost(cheapest.pricing, reasoning),
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
    return EdenAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const built = buildEdenAIModel(model, context.existing(model.id));
    if (built === undefined) return undefined;
    return { id: model.id, model: built };
  },
} satisfies SyncProvider<EdenAIModel>;
