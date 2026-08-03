import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.llmgateway.io/v1/models";

// LLM Gateway names the originating lab in `family`; most already match the
// canonical prefixes understood by resolveCanonicalBaseModel. Alias the few that
// spell the lab differently. (Mirrors huggingface's CANONICAL_ORG_PREFIXES.)
const CANONICAL_FAMILY_ALIASES: Record<string, string> = {
  mistral: "mistralai",
  moonshot: "moonshotai",
};

const BASE_MODEL_ALIASES: Record<string, string> = {
  "glm-5-2": "zhipuai/glm-5.2",
};

const Pricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  internal_reasoning: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

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
      providerId: z.string(),
      vision: z.boolean().optional(),
      tools: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      reasoning_efforts: z.array(
        z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
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
    return LLMGatewayResponse.parse(raw).data.filter(textOnly);
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildLLMGatewayModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<LLMGatewayModel>;

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
    // the provider-pinned catalog, so refuse to proceed.
    if (!data.every((model) => model.id.includes("/"))) {
      throw new Error("LLM Gateway mapped view unavailable: response contains unprefixed model ids");
    }
    // llmgateway/custom is the BYO-model placeholder and llmgateway/auto the
    // auto-router; pinning either to a provider is meaningless in this catalog
    // (the aggregated llmgateway provider carries `auto`).
    return data.filter((model) => !model.id.startsWith("llmgateway/") && textOnly(model));
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildLLMGatewayMappedModel(model, context.existing(model.id)),
    };
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

const MODELS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const canonicalOutputLimitByID = new Map<string, number | undefined>();

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
  return resolveCanonicalBaseModel(`${prefix}/${modelID}`);
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
): SyncedModel {
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = model.supported_parameters.includes("reasoning")
    || model.supported_parameters.includes("include_reasoning");
  const reported = model.context_length ?? 0;
  const context = reported > 0 ? reported : existing?.limit?.context ?? reported;

  // The gateway is authoritative for the volatile, gateway-specific data — cost
  // and served limits. Its supported_parameters / modalities are too noisy to
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
  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output ?? context,
  };

  // Existing factored model: refresh cost + limit, keep every authored override
  // as-is (undefined fields keep inheriting the base model).
  if (existing?.base_model !== undefined) {
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
          limit,
          modalities: existing.modalities,
        }),
        reasoning: existing.reasoning,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        modalities: existing.modalities,
        limit,
        cost,
      },
      limit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost + limit, preserve curated metadata.
  if (existing !== undefined) {
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
    return factorBaseModel(canonical, { limit: factoredLimit, cost }, factoredLimit);
  }

  // Brand-new model: best-effort translation from the gateway. Capability and
  // modality data are unreliable here and should be hand-reviewed.
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
      limit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: input.some((value) => value !== "text"),
    reasoning,
    temperature: model.supported_parameters.includes("temperature"),
    tool_call: model.supported_parameters.includes("tools")
      || model.supported_parameters.includes("tool_choice"),
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

export function buildLLMGatewayMappedModel(
  model: LLMGatewayModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  // Mapped entries carry exactly one provider mapping; its capability flags
  // describe that specific deployment, unlike the aggregated view where
  // supported_parameters are too noisy to trust.
  const mapping = model.providers?.[0];
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = mapping?.reasoning
    ?? (model.supported_parameters.includes("reasoning")
      || model.supported_parameters.includes("include_reasoning"));
  // The exact reasoning_effort values this deployment accepts.
  const reasoningOptions = mapping?.reasoning_efforts?.length
    ? [{ type: "effort" as const, values: mapping.reasoning_efforts }]
    : undefined;
  const reported = model.context_length ?? 0;
  const context = reported > 0 ? reported : existing?.limit?.context ?? reported;

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
  // The gateway's max_output is the deployment's real served limit, so it wins
  // over inherited/authored values, unlike the aggregated view.
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.max_output ?? existing?.limit?.output ?? context,
  };

  // Existing factored model: refresh cost + limit, keep every authored override
  // as-is. Unlike the aggregated provider, the name override must be carried
  // forward: mapped names disambiguate deployments of the same model (e.g.
  // "GPT-5.5 (Azure)" vs "GPT-5.5 (OpenAI)") and must not collapse back to the
  // base metadata name.
  if (existing?.base_model !== undefined) {
    return factorBaseModel(
      existing.base_model,
      {
        name: existing.name ?? model.name,
        attachment: existing.attachment,
        description: existing.description ?? describeModel({
          id: model.id,
          name: existing.name ?? model.name,
          family: existing.family,
          reasoning: existing.reasoning,
          tool_call: existing.tool_call,
          structured_output: existing.structured_output,
          open_weights: existing.open_weights,
          limit,
          modalities: existing.modalities,
        }),
        reasoning: existing.reasoning,
        temperature: existing.temperature,
        tool_call: existing.tool_call,
        structured_output: existing.structured_output,
        status: existing.status,
        interleaved: existing.interleaved,
        knowledge: existing.knowledge,
        modalities: existing.modalities,
        limit,
        cost,
      },
      limit,
      existing.base_model_omit,
    );
  }

  // Existing full model: refresh cost + limit, preserve curated metadata.
  if (existing !== undefined) {
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
      attachment: existing.attachment ?? mapping?.vision ?? false,
      reasoning: existing.reasoning ?? reasoning,
      temperature: existing.temperature ?? false,
      tool_call: existing.tool_call ?? mapping?.tools ?? false,
      structured_output: existing.structured_output ?? model.structured_outputs,
      knowledge: existing.knowledge,
      open_weights: existing.open_weights ?? false,
      status: existing.status,
      interleaved: existing.interleaved,
      cost,
      limit,
      modalities: existing.modalities ?? defaultModalities(model),
    } satisfies SyncedFullModel;
  }

  // Brand-new model with a reviewed metadata entry: factor against the
  // canonical base. The mapped ID is `serving-provider/model-id` and the
  // serving provider is unrelated to the originating lab, so resolve the base
  // from the root model ID + family, and keep the disambiguating name. The
  // mapping's own capability flags describe this specific deployment, so they
  // go in as overrides (factorBaseModel drops the ones equal to the base).
  const rootID = model.id.split("/").slice(1).join("/");
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
      tool_call: mapping?.tools,
      structured_output: model.structured_outputs,
      limit: factoredLimit,
      cost,
    }, factoredLimit);
  }

  // Brand-new model without metadata: best-effort translation. The mapping's
  // own capability flags are reliable here; modalities mirror the mapping too.
  const { input, output } = defaultModalities(model);
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
      limit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: dateFromTimestamp(model.created),
    last_updated: dateFromTimestamp(model.created),
    attachment: mapping?.vision ?? input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoningOptions,
    temperature: model.supported_parameters.includes("temperature"),
    tool_call: mapping?.tools ?? false,
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function defaultModalities(model: LLMGatewayModel) {
  return {
    input: modalities(model.architecture.input_modalities, ["text"]),
    output: modalities(model.architecture.output_modalities, ["text"]),
  };
}
