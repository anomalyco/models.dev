import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.llmgateway.io/v1/models";

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
  pricing: Pricing,
  context_length: z.number(),
  supported_parameters: z.array(z.string()),
  structured_outputs: z.boolean().optional(),
}).passthrough();

export const LLMGatewayResponse = z.object({
  data: z.array(LLMGatewayModel),
}).passthrough();

export type LLMGatewayModel = z.infer<typeof LLMGatewayModel>;

export const llmgateway = {
  id: "llmgateway",
  name: "LLM Gateway",
  modelsDir: "providers/llmgateway/models",
  async fetchModels() {
    const headers = process.env.LLMGATEWAY_API_KEY
      ? { Authorization: `Bearer ${process.env.LLMGATEWAY_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`LLM Gateway request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return LLMGatewayResponse.parse(raw).data.filter((model) => {
      const output = model.architecture.output_modalities;
      return output.length === 1 && output[0] === "text";
    });
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildLLMGatewayModel(model, context.existing(model.id)),
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

function buildLLMGatewayModel(
  model: LLMGatewayModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = model.supported_parameters.includes("reasoning")
    || model.supported_parameters.includes("include_reasoning");
  const context = model.context_length > 0
    ? model.context_length
    : existing?.limit?.context ?? model.context_length;

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

  // Brand-new model: best-effort translation from the gateway. Capability and
  // modality data are unreliable here and should be hand-reviewed.
  const { input, output } = defaultModalities(model);
  return {
    name: model.name,
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

function defaultModalities(model: LLMGatewayModel) {
  return {
    input: modalities(model.architecture.input_modalities, ["text"]),
    output: modalities(model.architecture.output_modalities, ["text"]),
  };
}
