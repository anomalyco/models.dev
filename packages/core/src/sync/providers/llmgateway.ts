import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.llmgateway.io/v1/models";

// LLM Gateway names the originating lab in `family`; most already match the
// canonical prefixes understood by resolveModelMetadataBaseModel, and labs
// outside that shared table (e.g. perplexity) resolve through its exact
// `models/` path match without widening the OpenRouter prefix map for every
// other provider. Alias the few that spell the lab differently. (Mirrors
// huggingface's CANONICAL_ORG_PREFIXES.)
const CANONICAL_FAMILY_ALIASES: Record<string, string> = {
  grok: "xai",
  mistral: "mistralai",
  moonshot: "moonshotai",
};

const BASE_MODEL_ALIASES: Record<string, string> = {
  "glm-5-2": "zhipuai/glm-5.2",
  "grok-4-6": "xai/grok-4.6",
};

const Pricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  internal_reasoning: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

const ReasoningEffortOrder = new Map([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
].map((effort, index) => [effort, index]));

export const LLMGatewayModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  family: z.string().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  providers: z.array(
    z.object({
      providerId: z.string().optional(),
      vision: z.boolean().optional(),
      tools: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      reasoning_efforts: z.array(
        z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]),
      ).optional(),
    }).passthrough(),
  ).optional(),
  pricing: Pricing,
  // Absent for pseudo-models (custom/auto) and some non-text mappings; text
  // models always report it.
  context_length: z.number().optional(),
  max_output: z.number().optional(),
  supported_parameters: z.array(z.string()),
  structured_outputs: z.boolean().optional(),
}).passthrough();

export const LLMGatewayResponse = z.object({
  data: z.array(LLMGatewayModel),
}).passthrough();

export type LLMGatewayModel = z.infer<typeof LLMGatewayModel>;

async function fetchLLMGatewayModels(url: string) {
  const headers = process.env.LLMGATEWAY_API_KEY
    ? { Authorization: `Bearer ${process.env.LLMGATEWAY_API_KEY}` }
    : undefined;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`LLM Gateway request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function textOnly(model: LLMGatewayModel) {
  const output = model.architecture.output_modalities;
  return output.length === 1 && output[0] === "text";
}

// The DevPass (LLM Gateway) provider: the gateway's aggregated catalog of root
// model IDs, auto-routed across upstream providers.
export const llmgateway = {
  id: "llmgateway",
  name: "DevPass (LLM Gateway)",
  modelsDir: "providers/llmgateway/models",
  async fetchModels() {
    return fetchLLMGatewayModels(API_ENDPOINT);
  },
  parseModels(raw) {
    const data = LLMGatewayResponse.parse(raw).data.filter(textOnly);
    // An empty catalog is an upstream fault; syncing it would delete every
    // model file, so fail loudly instead.
    if (data.length === 0) {
      throw new Error("LLM Gateway returned no text models");
    }
    return data;
  },
  translateModel(model, context) {
    const translated = buildLLMGatewayModel(model, context.existing(model.id));
    if (translated === undefined) {
      return undefined;
    }
    return { id: model.id, model: translated };
  },
  sourceID(model) {
    return model.id;
  },
} satisfies SyncProvider<LLMGatewayModel>;

// Every toggle reasoning control requires a leading wire-path comment, and the
// sync runner only carries over headers that already exist on disk. Files this
// sync writes with a toggle get the gateway-wide default; a hand-written
// header on the existing file always wins.
const TOGGLE_HEADER = `# Toggle: $.reasoning_effort = "none" disables thinking; any other accepted
# value (or omitting the field) leaves it on. The gateway maps it to the
# deployment's thinking switch.
# https://docs.llmgateway.io/features/reasoning
`;

function toggleHeader(model: SyncedModel) {
  return model.reasoning_options?.some((option) => option.type === "toggle")
    ? TOGGLE_HEADER
    : undefined;
}

// The LLM Gateway provider: one entry per upstream provider mapping, addressed
// the way the gateway accepts provider-pinned requests (`provider/model-id`).
export const llmgatewayProviders = {
  id: "llmgateway-providers",
  name: "LLM Gateway",
  modelsDir: "providers/llmgateway-providers/models",
  async fetchModels() {
    return fetchLLMGatewayModels(`${API_ENDPOINT}?mapped=true`);
  },
  parseModels(raw) {
    const data = LLMGatewayResponse.parse(raw).data;
    // A deployment without the mapped view ignores the query param and returns
    // aggregated root IDs (no provider prefix); syncing those here would wipe
    // the provider-pinned catalog, so refuse to proceed. An empty response (or
    // one left empty after filtering) would silently do the same via the
    // delete-missing pass, so it is equally fatal.
    if (data.length === 0 || !data.every((model) => model.id.includes("/"))) {
      throw new Error("LLM Gateway mapped view unavailable: response is empty or contains unprefixed model ids");
    }
    // llmgateway/custom is the BYO-model placeholder and llmgateway/auto the
    // auto-router; pinning either to a provider is meaningless in this catalog
    // (the aggregated llmgateway provider carries `auto`).
    const mapped = data.filter((model) => !model.id.startsWith("llmgateway/") && textOnly(model));
    if (mapped.length === 0) {
      throw new Error("LLM Gateway mapped view returned no text models");
    }
    // Every mapped entry is one specific provider deployment whose single
    // providers[] mapping drives capabilities and reasoning controls. A kept
    // entry with zero or several mappings would make the builder silently fall
    // back to noisy supported_parameters / sibling defaults, so fail loudly.
    const malformed = mapped.filter((model) => model.providers?.length !== 1);
    if (malformed.length > 0) {
      throw new Error(
        `LLM Gateway mapped view returned entries without exactly one provider mapping: ${
          malformed.map((model) => model.id).join(", ")
        }`,
      );
    }
    return mapped;
  },
  translateModel(model, context) {
    const translated = buildLLMGatewayMappedModel(model, context.existing(model.id));
    if (translated === undefined) {
      return undefined;
    }
    return { id: model.id, model: translated, header: toggleHeader(translated) };
  },
  sourceID(model) {
    return model.id;
  },
} satisfies SyncProvider<LLMGatewayModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000_000_000_000) / 1_000_000
    : undefined;
}

// Cache/reasoning prices are reported as "0" when the gateway has no data; treat
// those as unknown so we never downgrade a hand-authored value to zero.
function nonZeroPrice(value: string | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

// Modalities as served by a specific deployment: a mapping without vision must
// not carry image/pdf input, regardless of what the model-level architecture
// claims — attachment=false with image input is contradictory.
function deploymentModalities(model: LLMGatewayModel, vision: boolean | undefined) {
  const base = defaultModalities(model);
  if (vision !== false) {
    return base;
  }
  const input = base.input.filter((value) => value !== "image" && value !== "pdf");
  return {
    input: input.length > 0 ? input : (["text"] satisfies Modality[]),
    output: base.output,
  };
}

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const AGGREGATED_MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers", "llmgateway", "models");
const canonicalOutputLimitByID = new Map<string, number | undefined>();

interface SiblingCuration {
  reasoning_options?: SyncedFullModel["reasoning_options"];
  interleaved?: SyncedFullModel["interleaved"];
  cost_tiers?: NonNullable<SyncedFullModel["cost"]>["tiers"];
}

const siblingCurationByID = new Map<string, SiblingCuration>();

// The aggregated llmgateway catalog curates reasoning controls, the reasoning
// side-channel, and context pricing tiers for the same gateway surface; mapped
// deployments of the same root model reuse them when the deployment does not
// declare its own.
function siblingCuration(rootID: string): SiblingCuration {
  let curation = siblingCurationByID.get(rootID);
  if (curation === undefined) {
    const filePath = path.join(AGGREGATED_MODELS_DIR, `${rootID}.toml`);
    const authored = existsSync(filePath)
      ? Bun.TOML.parse(readFileSync(filePath, "utf8")) as SiblingCuration & {
          cost?: { tiers?: NonNullable<SyncedFullModel["cost"]>["tiers"] };
        }
      : undefined;
    curation = {
      reasoning_options: authored?.reasoning_options?.length ? authored.reasoning_options : undefined,
      interleaved: authored?.interleaved,
      cost_tiers: authored?.cost?.tiers,
    };
    siblingCurationByID.set(rootID, curation);
  }
  return curation;
}

// Whether the canonical metadata declares limit.output; factored entries can
// only omit their own output override when the base has one to inherit.
function canonicalOutputLimit(modelID: string) {
  if (!canonicalOutputLimitByID.has(modelID)) {
    const filePath = path.join(MODELS_DIR, `${modelID}.toml`);
    const metadata = existsSync(filePath)
      ? Bun.TOML.parse(readFileSync(filePath, "utf8")) as { limit?: { output?: number } }
      : undefined;
    canonicalOutputLimitByID.set(modelID, metadata?.limit?.output);
  }
  return canonicalOutputLimitByID.get(modelID);
}

function resolveLLMGatewayBaseModel(model: LLMGatewayModel, modelID = model.id) {
  const alias = BASE_MODEL_ALIASES[modelID];
  if (alias !== undefined) return alias;
  if (model.family === undefined) return undefined;
  const prefix = CANONICAL_FAMILY_ALIASES[model.family] ?? model.family;
  return resolveModelMetadataBaseModel(`${prefix}/${modelID}`);
}

function inferFamily(model: LLMGatewayModel, name: string) {
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;

  const target = `${model.id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

export function buildLLMGatewayModel(
  model: LLMGatewayModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = model.supported_parameters.includes("reasoning")
    || model.supported_parameters.includes("include_reasoning");
  const reasoningOptions = llmGatewayReasoningOptions(model, existing);
  const reported = model.context_length ?? 0;
  // A missing/zero context must never be authored as limit.context = 0:
  // factored entries leave it unset and inherit the base, and unfactored
  // creates are skipped entirely. An authored 0 on the existing file is
  // equally unusable and must not be re-stamped.
  const servedContext = reported > 0 ? reported : undefined;
  const context = servedContext ?? (existing?.limit?.context || undefined);

  // The gateway is authoritative for the volatile, gateway-specific data — cost,
  // served limits, and explicitly advertised reasoning efforts. Its
  // supported_parameters / modalities are too noisy to
  // drive capability fields (it omits "tools" for flagship models yet lists
  // "temperature" for ones the catalog deliberately marks temperature=false),
  // so those stay curated: preserved from the existing entry (which, for a
  // factored model, inherits its base when the field is absent).
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning ? nonZeroPrice(model.pricing.internal_reasoning) ?? existing?.cost?.reasoning : existing?.cost?.reasoning,
        cache_read: nonZeroPrice(model.pricing.input_cache_read) ?? existing?.cost?.cache_read,
        cache_write: nonZeroPrice(model.pricing.input_cache_write) ?? existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  // Authored limits carry only known-positive values — never the zero/absent
  // `reported` fallback.
  const limit = context !== undefined
    ? {
        context,
        input: existing?.limit?.input,
        output: (existing?.limit?.output || undefined) ?? context,
      }
    : undefined;

  // Existing factored model: refresh cost + limit, keep every authored override
  // as-is (undefined fields keep inheriting the base model).
  if (existing?.base_model !== undefined) {
    const factoredLimit = {
      context,
      input: existing.limit?.input,
      output: existing.limit?.output ?? context,
    };
    return factorBaseModel(
      existing.base_model,
      {
        attachment: existing.attachment,
        description: existing.description ?? describeModel({
          id: model.id,
          name: existing.name ?? model.name,
          family: existing.family,
          reasoning: existing.reasoning,
          tool_call: existing.tool_call,
          structured_output: existing.structured_output,
          open_weights: existing.open_weights,
          limit: factoredLimit,
          modalities: existing.modalities,
        }),
        reasoning: existing.reasoning,
        reasoning_options: reasoningOptions,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        modalities: existing.modalities,
        limit: factoredLimit,
        cost,
      },
      factoredLimit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost + limit, preserve curated metadata.
  if (existing !== undefined) {
    // With no usable context from the API or the file there is nothing valid
    // to author, and skipping would hand the file to the delete-missing pass —
    // fail loudly rather than write limit.context = 0.
    if (limit === undefined) {
      throw new Error(`LLM Gateway entry ${model.id} has no usable context to author`);
    }
    return {
      name: existing.name ?? model.name,
      description: existing.description ?? describeModel({
        id: model.id,
        name: existing.name ?? model.name,
        family: existing.family,
        reasoning: existing.reasoning,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        open_weights: existing.open_weights,
        limit,
        modalities: existing.modalities ?? defaultModalities(model),
      }),
      family: existing.family,
      release_date: existing.release_date ?? dateFromTimestamp(model.created),
      last_updated: existing.last_updated ?? dateFromTimestamp(model.created),
      attachment: existing.attachment ?? false,
      reasoning: existing.reasoning ?? false,
      reasoning_options: reasoningOptions,
      temperature: existing.temperature ?? false,
      tool_call: existing.tool_call ?? false,
      structured_output: existing.structured_output,
      knowledge: existing.knowledge,
      open_weights: existing.open_weights ?? false,
      status: existing.status,
      interleaved: existing.interleaved,
      cost,
      limit,
      modalities: existing.modalities ?? defaultModalities(model),
    } satisfies SyncedFullModel;
  }

  // Brand-new model with a reviewed metadata entry: factor it against the
  // canonical base so capability, modality, and description facts inherit from
  // the curated `models/` file. The gateway serves bare IDs and names the lab in
  // `family`, so glue them into the prefixed form the shared resolver expects.
  // Only the gateway-authoritative cost and served context are overridden; the
  // gateway's capability/modality data is too noisy to author standalone.
  const canonical = resolveLLMGatewayBaseModel(model);
  if (canonical !== undefined) {
    const factoredLimit = { context, input: undefined, output: undefined };
    return factorBaseModel(canonical, {
      reasoning_options: reasoningOptions,
      limit: factoredLimit,
      cost,
    }, factoredLimit);
  }

  // Brand-new model: best-effort translation from the gateway. Capability and
  // modality data are unreliable here and should be hand-reviewed. Without a
  // positive served context there is nothing usable to author, so skip.
  if (servedContext === undefined) {
    return undefined;
  }
  const createdLimit = limit ?? { context: servedContext, input: undefined, output: servedContext };
  const { input, output } = defaultModalities(model);
  return {
    name: model.name,
    description: describeModel({
      id: model.id,
      name: model.name,
      family: inferFamily(model, model.name),
      reasoning,
      tool_call: model.supported_parameters.includes("tools")
        || model.supported_parameters.includes("tool_choice"),
      structured_output: model.structured_outputs ?? false,
      open_weights: false,
      limit: createdLimit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: model.supported_parameters.includes("temperature"),
    tool_call: model.supported_parameters.includes("tools")
      || model.supported_parameters.includes("tool_choice"),
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit: createdLimit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function buildLLMGatewayMappedModel(
  model: LLMGatewayModel,
  existing: ExistingModel | undefined,
): SyncedModel | undefined {
  // Mapped entries carry exactly one provider mapping; its capability flags
  // describe that specific deployment, unlike the aggregated view where
  // supported_parameters are too noisy to trust.
  const mapping = model.providers?.[0];
  const rootID = model.id.split("/").slice(1).join("/");
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  // The mapping's flag stays authoritative on resyncs too, so the written
  // reasoning boolean and the reasoning_options derived from it always move
  // together; prior curation only fills in when the mapping is silent, then
  // the noisy supported_parameters signal as a last resort.
  const reasoning = mapping?.reasoning
    ?? existing?.reasoning
    ?? (model.supported_parameters.includes("reasoning")
      || model.supported_parameters.includes("include_reasoning"));
  // The exact reasoning_effort values this deployment accepts. A deployment
  // whose only accepted effort is "none" exposes a plain on/off switch (the
  // gateway honours it through the thinking toggle), not effort tiers.
  const deploymentOptions = mapping?.reasoning_efforts?.length
    ? mapping.reasoning_efforts.length === 1 && mapping.reasoning_efforts[0] === "none"
      ? [{ type: "toggle" as const }]
      : [{ type: "effort" as const, values: mapping.reasoning_efforts }]
    : undefined;
  // Deployment-declared efforts own the effort/toggle surface; curation falls
  // back from non-empty options on this file to the aggregated llmgateway
  // catalog's controls for the same root model on the same gateway surface.
  // Curated non-effort controls (e.g. budget_tokens for $.reasoning.max_tokens,
  // which this host serves regardless of the effort list) survive alongside
  // deployment efforts instead of being wiped by them. A curated [] counts as
  // unknown so a bad first stamp is not sticky. Non-reasoning deployments
  // carry none; the same applies to the interleaved reasoning side-channel.
  const sibling = siblingCuration(rootID);
  const curatedOptions = (existing?.reasoning_options?.length ? existing.reasoning_options : undefined)
    ?? sibling.reasoning_options;
  const reasoningOptions = reasoning
    ? deploymentOptions !== undefined
      ? [
          ...(curatedOptions ?? []).filter((option) => option.type !== "effort" && option.type !== "toggle"),
          ...deploymentOptions,
        ]
      : curatedOptions
    : undefined;
  const interleaved = reasoning
    ? existing?.interleaved ?? sibling.interleaved
    : undefined;
  const reported = model.context_length ?? 0;
  // Same zero-context rule as the aggregated builder: never author 0, inherit
  // on factored entries, skip unfactored creates. An authored 0 on the
  // existing file is equally unusable.
  const servedContext = reported > 0 ? reported : undefined;
  const context = servedContext ?? (existing?.limit?.context || undefined);

  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning ? nonZeroPrice(model.pricing.internal_reasoning) ?? existing?.cost?.reasoning : existing?.cost?.reasoning,
        cache_read: nonZeroPrice(model.pricing.input_cache_read) ?? existing?.cost?.cache_read,
        cache_write: nonZeroPrice(model.pricing.input_cache_write) ?? existing?.cost?.cache_write,
        // The gateway API does not expose context pricing tiers, so authored
        // tiers stick and new files seed from the aggregated sibling's curated
        // tiers rather than silently under-stating long-context pricing.
        tiers: existing?.cost?.tiers ?? sibling.cost_tiers,
      }
    : existing?.cost;
  // The gateway's max_output is the deployment's real served limit, so it wins
  // over inherited/authored values, unlike the aggregated view.
  const servedOutput = (model.max_output || undefined) ?? (existing?.limit?.output || undefined);
  // Authored limits carry only known-positive values — never the zero/absent
  // `reported` fallback.
  const limit = context !== undefined
    ? {
        context,
        input: existing?.limit?.input,
        output: servedOutput ?? context,
      }
    : undefined;

  // Existing factored model: refresh cost + limit, keep every authored override
  // as-is. Unlike the aggregated provider, the name override must be carried
  // forward: mapped names disambiguate deployments of the same model (e.g.
  // "GPT-5.5 (Azure)" vs "GPT-5.5 (OpenAI)") and must not collapse back to the
  // base metadata name.
  if (existing?.base_model !== undefined) {
    // Mirror the brand-new factored path: without a served or authored output,
    // keep inheriting the base's output rather than stamping context over it.
    const factoredLimit = {
      context,
      input: existing.limit?.input,
      output: servedOutput ?? (canonicalOutputLimit(existing.base_model) !== undefined ? undefined : context),
    };
    // Deployment capability flags keep their create-path authority on
    // resyncs: a mapping that gains or loses reasoning/vision/tools/structured
    // outputs realigns the written flags together with the reasoning_options
    // computed from them, instead of freezing stale curation forever.
    return factorBaseModel(
      existing.base_model,
      {
        name: existing.name ?? model.name,
        attachment: mapping?.vision ?? existing.attachment,
        // No describeModel fallback: synthesizing a description here would
        // stamp a sticky generic override on every name-pinned factored entry;
        // leaving it unset keeps inheriting the lab text from the base.
        description: existing.description,
        reasoning: mapping?.reasoning ?? existing.reasoning,
        reasoning_options: reasoningOptions,
        temperature: existing.temperature,
        tool_call: mapping?.tools ?? existing.tool_call,
        structured_output: model.structured_outputs ?? existing.structured_output,
        status: existing.status,
        interleaved,
        knowledge: existing.knowledge,
        // Vision realigns modalities in both directions: false strips
        // image/pdf, true clears any stale stripped override so the base's
        // richer inputs inherit again; only a silent mapping keeps curation.
        modalities: mapping?.vision === undefined
          ? existing.modalities
          : mapping.vision
            ? undefined
            : deploymentModalities(model, false),
        limit: factoredLimit,
        cost,
      },
      factoredLimit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost + limit, preserve curated metadata.
  // Capability flags follow the same rule as the factored path above: the
  // deployment mapping wins, curation fills the gaps.
  if (existing !== undefined) {
    // With no usable context from the API or the file there is nothing valid
    // to author, and skipping would hand the file to the delete-missing pass —
    // fail loudly rather than write limit.context = 0.
    if (limit === undefined) {
      throw new Error(`LLM Gateway mapped entry ${model.id} has no usable context to author`);
    }
    const resolved = {
      attachment: mapping?.vision ?? existing.attachment ?? false,
      tool_call: mapping?.tools ?? existing.tool_call ?? false,
      structured_output: model.structured_outputs ?? existing.structured_output,
      // Same bidirectional vision rule as the factored path; with no base to
      // inherit from, a declared vision recomputes from the served
      // architecture instead of clearing.
      modalities: mapping?.vision === undefined
        ? existing.modalities ?? deploymentModalities(model, undefined)
        : deploymentModalities(model, mapping.vision),
    };
    return {
      name: existing.name ?? model.name,
      description: existing.description ?? describeModel({
        id: model.id,
        name: existing.name ?? model.name,
        family: existing.family,
        reasoning,
        tool_call: resolved.tool_call,
        structured_output: resolved.structured_output,
        open_weights: existing.open_weights,
        limit,
        modalities: resolved.modalities,
      }),
      family: existing.family,
      release_date: existing.release_date ?? dateFromTimestamp(model.created),
      last_updated: existing.last_updated ?? dateFromTimestamp(model.created),
      attachment: resolved.attachment,
      reasoning,
      reasoning_options: reasoningOptions,
      temperature: existing.temperature ?? false,
      tool_call: resolved.tool_call,
      structured_output: resolved.structured_output,
      knowledge: existing.knowledge,
      open_weights: existing.open_weights ?? false,
      status: existing.status,
      interleaved,
      cost,
      limit,
      modalities: resolved.modalities,
    } satisfies SyncedFullModel;
  }

  // Brand-new model with a reviewed metadata entry: factor against the
  // canonical base. The mapped ID is `serving-provider/model-id` and the
  // serving provider is unrelated to the originating lab, so resolve the base
  // from the root model ID + family, and keep the disambiguating name. The
  // mapping's own capability flags describe this specific deployment, so they
  // go in as overrides (factorBaseModel drops the ones equal to the base).
  const canonical = resolveLLMGatewayBaseModel(model, rootID);
  if (canonical !== undefined) {
    const factoredLimit = {
      context,
      input: undefined,
      // Without a served limit, inherit the base's output; only fall back to
      // context when the base declares none (output is required downstream).
      output: model.max_output ?? (canonicalOutputLimit(canonical) !== undefined ? undefined : context),
    };
    return factorBaseModel(canonical, {
      name: model.name,
      attachment: mapping?.vision,
      reasoning: mapping?.reasoning,
      reasoning_options: reasoningOptions,
      interleaved,
      tool_call: mapping?.tools,
      structured_output: model.structured_outputs,
      // A deployment without vision must not inherit image/pdf inputs from
      // the base — attachment=false with image input is contradictory.
      modalities: mapping?.vision === false ? deploymentModalities(model, false) : undefined,
      limit: factoredLimit,
      cost,
    }, factoredLimit);
  }

  // Brand-new model without metadata: best-effort translation. The mapping's
  // own capability flags are reliable here; modalities mirror the mapping too.
  // Without a positive served context there is nothing usable to author.
  if (servedContext === undefined) {
    return undefined;
  }
  const createdLimit = limit ?? { context: servedContext, input: undefined, output: servedOutput ?? servedContext };
  const { input, output } = deploymentModalities(model, mapping?.vision);
  return {
    name: model.name,
    description: describeModel({
      id: model.id,
      name: model.name,
      family: inferFamily(model, model.name),
      reasoning,
      tool_call: mapping?.tools ?? false,
      structured_output: model.structured_outputs ?? false,
      open_weights: false,
      limit: createdLimit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: mapping?.vision ?? input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    interleaved,
    temperature: model.supported_parameters.includes("temperature"),
    tool_call: mapping?.tools ?? false,
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit: createdLimit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function llmGatewayReasoningOptions(
  model: LLMGatewayModel,
  existing: ExistingModel | undefined,
): SyncedFullModel["reasoning_options"] {
  const advertised = new Set((model.providers ?? []).flatMap((provider) => provider.reasoning_efforts ?? []));
  if (advertised.size === 0) return undefined;

  const efforts = [...advertised].sort((a, b) => {
    const order = (ReasoningEffortOrder.get(a) ?? Number.MAX_SAFE_INTEGER)
      - (ReasoningEffortOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
    return order || a.localeCompare(b);
  });
  const preserved = existing?.reasoning_options?.filter((option) =>
    option.type !== "effort" && !(option.type === "toggle" && advertised.has("none"))
  ) ?? [];
  return [
    ...preserved,
    ReasoningOption.parse({ type: "effort", values: efforts }),
  ];
}

function defaultModalities(model: LLMGatewayModel) {
  return {
    input: modalities(model.architecture.input_modalities, ["text"]),
    output: modalities(model.architecture.output_modalities, ["text"]),
  };
}
