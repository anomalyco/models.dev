import { z } from "zod";

import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.aiand.com/v1/models";

// Maps ai& org prefixes to the canonical org prefix used by resolveCanonicalBaseModel.
const CANONICAL_ORG_ALIASES: Record<string, string> = {
  "zai-org": "zhipuai",
  "moonshotai": "moonshotai",
};

const AiandPricing = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  internal_reasoning: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

export const AiandModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }).optional(),
  pricing: AiandPricing.optional(),
  context_length: z.number().optional(),
  supported_parameters: z.array(z.string()).optional(),
  structured_outputs: z.boolean().optional(),
}).passthrough();

export const AiandResponse = z.object({
  data: z.array(AiandModel),
}).passthrough();

export type AiandModel = z.infer<typeof AiandModel>;

// ai& model IDs use the form "org/model-id" (e.g. "zai-org/glm-5.2").
// Split into [org, modelId] parts.
function splitModelId(id: string): { org: string; modelId: string } | undefined {
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  return { org: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function resolveAiandBaseModel(model: AiandModel): string | undefined {
  const parts = splitModelId(model.id);
  if (parts === undefined) return undefined;
  const canonicalOrg = CANONICAL_ORG_ALIASES[parts.org] ?? parts.org;
  return resolveCanonicalBaseModel(`${canonicalOrg}/${parts.modelId}`);
}

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

function nonZeroPrice(value: string | undefined) {
  const result = price(value);
  return result !== undefined && result > 0 ? result : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((v) => v.toLowerCase())
    .map((v) => (v === "file" ? "pdf" : v))
    .filter((v): v is Modality => allowed.has(v as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function defaultModalities(model: AiandModel) {
  const input = model.architecture?.input_modalities ?? ["text"];
  const output = model.architecture?.output_modalities ?? ["text"];
  return {
    input: modalities(input, ["text"]),
    output: modalities(output, ["text"]),
  };
}

function inferFamily(model: AiandModel, name: string) {
  const kimiFamily = inferKimiFamily(model.id, name);
  if (kimiFamily !== undefined) return kimiFamily;
  const parts = splitModelId(model.id);
  const target = `${parts?.modelId ?? model.id} ${name}`.toLowerCase();
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

// ai& documents reasoning_effort with values: none | minimal | low | medium | high | xhigh.
// When the API lists "reasoning_effort" in supported_parameters we emit this option list.
const AIAND_REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

function buildReasoningOptions(supportedParams: string[]) {
  if (!supportedParams.includes("reasoning_effort")) return undefined;
  return [
    {
      type: "effort" as const,
      values: [...AIAND_REASONING_EFFORT_VALUES],
    },
  ];
}

export function buildAiandModel(
  model: AiandModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const params = model.supported_parameters ?? [];
  const reasoning = params.includes("reasoning_effort");
  const contextLength = model.context_length ?? 0;
  const context = contextLength > 0
    ? contextLength
    : existing?.limit?.context ?? contextLength;

  const prompt = price(model.pricing?.prompt);
  const completion = price(model.pricing?.completion);

  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning
          ? nonZeroPrice(model.pricing?.internal_reasoning) ?? existing?.cost?.reasoning
          : existing?.cost?.reasoning,
        cache_read: nonZeroPrice(model.pricing?.input_cache_read) ?? existing?.cost?.cache_read,
        cache_write: nonZeroPrice(model.pricing?.input_cache_write) ?? existing?.cost?.cache_write,
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  const limit = {
    context,
    input: existing?.limit?.input,
    output: existing?.limit?.output ?? context,
  };

  // Existing factored model: refresh cost + limit, preserve authored overrides.
  if (existing?.base_model !== undefined) {
    return factorBaseModel(
      existing.base_model,
      {
        attachment: existing.attachment,
        description: existing.description,
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
      description: existing.description,
      family: existing.family,
      release_date: existing.release_date
        ?? (model.created ? dateFromTimestamp(model.created) : undefined),
      last_updated: existing.last_updated
        ?? (model.created ? dateFromTimestamp(model.created) : undefined),
      attachment: existing.attachment ?? false,
      reasoning: existing.reasoning ?? reasoning,
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

  // New model: attempt to factor against canonical base.
  const canonical = resolveAiandBaseModel(model);
  if (canonical !== undefined) {
    const factoredLimit = { context, input: undefined, output: undefined };
    const factoredModel = factorBaseModel(canonical, { limit: factoredLimit, cost }, factoredLimit);
    // Attach reasoning_options when the live API signals reasoning_effort support.
    if (reasoning && !Array.isArray((factoredModel as any).reasoning_options)) {
      return {
        ...factoredModel,
        reasoning: true,
        reasoning_options: buildReasoningOptions(params),
      };
    }
    return factoredModel;
  }

  // Brand-new model with no canonical base: best-effort standalone entry.
  const { input, output } = defaultModalities(model);
  const reasoningOptions = buildReasoningOptions(params);
  return {
    name: model.name,
    description: describeModel({
      id: model.id,
      name: model.name,
      family: inferFamily(model, model.name),
      reasoning,
      tool_call: params.includes("tools") || params.includes("tool_choice"),
      structured_output: model.structured_outputs ?? false,
      open_weights: false,
      limit,
      modalities: { input, output },
    }),
    family: inferFamily(model, model.name),
    release_date: model.created ? dateFromTimestamp(model.created) : undefined,
    last_updated: model.created ? dateFromTimestamp(model.created) : undefined,
    attachment: input.some((v) => v !== "text"),
    reasoning,
    temperature: params.includes("temperature"),
    tool_call: params.includes("tools") || params.includes("tool_choice"),
    structured_output: model.structured_outputs ?? false,
    open_weights: false,
    cost,
    limit,
    modalities: { input, output },
    ...(reasoningOptions ? { reasoning_options: reasoningOptions } : {}),
  } satisfies SyncedFullModel;
}

export const aiand = {
  id: "aiand",
  name: "ai&",
  modelsDir: "providers/aiand/models",
  async fetchModels() {
    const apiKey = process.env.AIAND_API_KEY;
    if (!apiKey) {
      throw new Error("AIAND_API_KEY environment variable is not set");
    }
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`ai& request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AiandResponse.parse(raw).data.filter((model) => {
      const output = model.architecture?.output_modalities ?? ["text"];
      return output.includes("text");
    });
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildAiandModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<AiandModel>;
