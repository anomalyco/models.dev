import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { readProviderModel, toV1Modality } from "../../translate.js";
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

// One entry per routable model name, with the providers that serve it nested
// under `endpoints`. A request names the model only and Eden AI picks the
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

// v2 data this sync never writes, so a file only has it where it was authored.
const AUTHORED_PATHS = [
  "capabilities.cache",
  "capabilities.prompt_cache_key",
  "api",
];

type ReasoningOption = NonNullable<
  SyncedFullModel["reasoning_options"]
>[number];

const labFiles = new Map<string, Record<string, unknown>>();

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

// A provider serving the model, under the id it is called by directly.
const EdenAIEndpoint = z
  .object({
    id: z.string().min(1),
    owned_by: z.string(),
  })
  .passthrough();

// The model-level fields summarise the endpoints: the largest context window,
// every capability at least one provider supports, and the price list of the
// cheapest provider (https://www.edenai.co/docs/v3/llms/listing-models).
export const EdenAIModel = z
  .object({
    id: z.string().min(1),
    // The lab that made the model; empty when Eden AI names none.
    owned_by: z.string(),
    context_length: z.number().nullish(),
    capabilities: EdenAICapabilities,
    pricing: EdenAIPricing.nullish(),
    alias_of: z.string().nullish(),
    endpoints: z.array(EdenAIEndpoint),
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

// A routable name is the lab's own model id, so the lab tree resolves it
// directly (`claude-sonnet-5.5` to `anthropic/claude-sonnet-5-5`). An alias
// resolves to the model it names.
export function resolveEdenAIBaseModel(model: EdenAIModel) {
  for (const name of [model.id, model.alias_of]) {
    if (name == null) continue;
    const candidates =
      model.owned_by === "" ? [name] : [`${model.owned_by}/${name}`, name];
    for (const candidate of candidates) {
      const resolved = resolveModelMetadataBaseModel(candidate);
      if (resolved !== undefined && baseModelExists(resolved)) return resolved;
    }
  }
  return undefined;
}

function labFile(baseModel: string) {
  let cached = labFiles.get(baseModel);
  if (cached === undefined) {
    try {
      cached = Bun.TOML.parse(
        readFileSync(path.join(MODELS_DIR, `${baseModel}.toml`), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      cached = {};
    }
    labFiles.set(baseModel, cached);
  }
  return cached;
}

function canonicalModelName(baseModel: string) {
  const name = labFile(baseModel).name;
  return typeof name === "string" && name !== "" ? name : undefined;
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
  return model.alias_of != null && /(?:^|-)latest$/i.test(model.id);
}

// A name that resolves onto another model's lab entry (`glm-5.3-fast` onto
// `glm-5.3`) is a different offering, so it must not share that model's name.
function displayName(model: EdenAIModel, baseModel: string) {
  const baseSlug = baseModel.split("/").at(-1) ?? baseModel;
  if (normalizeModelSlug(model.id) === normalizeModelSlug(baseSlug)) {
    return undefined;
  }

  const canonical = canonicalModelName(baseModel);
  if (canonical === undefined) return undefined;
  return isLatestAlias(model)
    ? `${titleCaseSlug(model.id)} (${canonical})`
    : `${canonical} (${model.id})`;
}

// ========================================
// Provider ids replaced by a routable name
// ========================================

// Entries used to be one per provider id (`anthropic/claude-sonnet-5-5`). Until
// a sync removes those files they hold what was authored on them: reasoning
// controls the mapper below cannot derive, cache settings, image APIs and the
// comments that source them. A new routable name starts from the file of the
// lab's own API, or of another provider where Eden AI does not relay the lab.
function replacedID(model: EdenAIModel, listed: (id: string) => boolean) {
  const ids = model.endpoints.filter((endpoint) => listed(endpoint.id));
  const own = ids.find((endpoint) => endpoint.owned_by === model.owned_by);
  return (own ?? ids[0])?.id;
}

function leadingComment(file: string) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const end = lines.findIndex((line) => !line.startsWith("#"));
    return end > 0 ? `${lines.slice(0, end).join("\n")}\n` : undefined;
  } catch {
    return undefined;
  }
}

function valueAt(toml: unknown, key: string) {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      toml,
    );
}

// Eden AI lists media kinds, not formats, so each kind takes its MIME types
// from the first source that has any.
function withFormats(kinds: unknown, sources: unknown[]) {
  if (!Array.isArray(kinds)) return kinds;
  return kinds.flatMap((kind) => {
    for (const formats of sources) {
      const exact = (Array.isArray(formats) ? formats : []).filter(
        (format) => String(format).includes("/") && toV1Modality(format) === kind,
      );
      if (exact.length > 0) return exact;
    }
    return [kind];
  });
}

// What a new file holds beyond the synced fields: the replaced file's authored
// values, and MIME types from that file or else from the lab.
function newFileValues(
  replaced: Record<string, unknown> | undefined,
  lab: Record<string, unknown>,
) {
  const values: Record<string, unknown> = {};
  for (const key of AUTHORED_PATHS) {
    const value = valueAt(replaced, key);
    if (value !== undefined) values[key] = value;
  }
  for (const key of ["modalities.input", "modalities.output"]) {
    values[key] = (kinds: unknown) =>
      withFormats(kinds, [valueAt(replaced, key), valueAt(lab, key)]);
  }
  return values;
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
    return readProviderModel(filePath);
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
  // The rates Eden AI bills on the cheapest provider. A call routed to another
  // provider is billed at that provider's rates.
  const pricing = model.pricing;
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

function withImage(values: ReturnType<typeof mapModalities>, add: boolean | undefined) {
  if (values === undefined || !add || values.includes("image")) return values;
  return [...values, "image" as const];
}

export function buildEdenAIModel(
  model: EdenAIModel,
  existing?: ExistingModel,
): SyncedModel | undefined {
  // Eden AI relays other labs' models only, so an entry needs its lab metadata.
  // A name the lab tree does not resolve (`beam`) keeps the entry its file has.
  const baseModel = resolveEdenAIBaseModel(model) ?? existing?.base_model;
  if (baseModel === undefined) return undefined;
  // The catalog reports no output limit, so the base has to resolve one.
  if (!hasOutputLimit(baseModel)) return undefined;

  const capabilities = model.capabilities;
  // Some image models are listed as text in, text out (vertex/gemini-nano-banana-2.1)
  // though they are priced per input and output image, so an image model keeps
  // the lab's image input and output.
  const lab = modelMetadata(baseModel) as { type?: string; modalities?: { input?: string[]; output?: string[] } };
  const imageModel = lab.type === "image";
  const input = withImage(mapModalities(capabilities.input_modalities), imageModel && lab.modalities?.input?.includes("image"));
  const output = withImage(mapModalities(capabilities.output_modalities), imageModel && lab.modalities?.output?.includes("image"));
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
    return EdenAIResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.id);
    if (existing !== undefined) {
      const built = buildEdenAIModel(model, existing);
      return built === undefined ? undefined : { id: model.id, model: built };
    }

    const replaced = replacedID(
      model,
      (id) => context.existing(id) !== undefined,
    );
    const built = buildEdenAIModel(
      model,
      replaced === undefined ? undefined : context.existing(replaced),
    );
    if (built === undefined || !("base_model" in built)) return undefined;
    return {
      id: model.id,
      model: built,
      header:
        replaced === undefined
          ? undefined
          : leadingComment(
              path.resolve(MODELS_DIR, "..", this.modelsDir, `${replaced}.toml`),
            ),
      v2Set: newFileValues(
        replaced === undefined ? undefined : context.v2?.(replaced),
        labFile(built.base_model),
      ),
    };
  },
} satisfies SyncProvider<EdenAIModel>;
