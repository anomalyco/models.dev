import { z } from "zod";
import { describeModel } from "../../describe.js";
import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.kilo.ai/api/gateway/models";

export const KiloModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  description: z.string().optional(),
  hugging_face_id: z.string().nullable().optional(),
  knowledge_cutoff: z.string().nullable().optional(),
  context_length: z.number(),
  architecture: z.object({
    modality: z.string().optional(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    tokenizer: z.string().optional(),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  top_provider: z.object({
    context_length: z.number().nullable(),
    max_completion_tokens: z.number().nullable(),
    is_moderated: z.boolean().optional(),
  }),
  supported_parameters: z.array(z.string()),
  opencode: z
    .object({
      variants: z
        .record(
          z.object({
            reasoning: z
              .object({
                enabled: z.boolean(),
                effort: z.string().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const KiloResponse = z.object({
  data: z.array(KiloModel),
}).passthrough();

export type KiloModel = z.infer<typeof KiloModel>;

export const kilo = {
  id: "kilo",
  name: "Kilo",
  modelsDir: "providers/kilo/models",
  async fetchModels() {
    const headers = process.env.KILO_API_KEY
      ? { Authorization: `Bearer ${process.env.KILO_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Kilo request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return KiloResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // Kilo serves deprecated/unavailable routes as degraded stubs:
    // negative pricing (`"-1"`) and an empty `supported_parameters` array. Syncing
    // those would wrongly flip `reasoning`/`tool_call`/`structured_output` to false
    // and strip `reasoning_options`. Leave the authored file untouched instead, and
    // skip the model entirely when we have nothing to preserve.
    if (isUnavailable(model)) {
      const authored = context.authored(model.id);
      return authored === undefined ? undefined : { id: model.id, model: authored as SyncedModel };
    }
    return {
      id: model.id,
      model: buildKiloModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<KiloModel>;

function isUnavailable(model: KiloModel) {
  return (
    model.supported_parameters.length === 0 ||
    Number(model.pricing.prompt) < 0 ||
    Number(model.pricing.completion) < 0
  );
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

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[], fallback: Modality[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => value.toLowerCase())
    .map((value) => value === "file" ? "pdf" : value)
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : fallback)];
}

function inferFamily(model: KiloModel, name: string) {
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

export function buildKiloModel(
  model: KiloModel,
  existing: ExistingModel | undefined,
  baseModel?: string,
): SyncedModel {
  const params = new Set(model.supported_parameters);
  const name = model.name;
  const apiDescription = model.description?.replaceAll(/\s+/g, " ").trim();
  const input = modalities(model.architecture.input_modalities, ["text"]);
  const output = modalities(model.architecture.output_modalities, ["text"]);
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  const reasoning = params.has("reasoning") || params.has("include_reasoning");
  const reasoning_options = reasoning
    ? KiloReasoningOptions(model.opencode) ?? existing?.reasoning_options
    : undefined;
  const context = model.top_provider.context_length ?? model.context_length;
  const family = inferFamily(model, name);
  const releaseDate = dateFromTimestamp(model.created);
  const familyValue = existing?.family === "o" && family !== "o"
    ? family
    : (existing?.family ?? family);
  const attachment = input.some((value) => value !== "text");
  const toolCall = params.has("tools") || params.has("tool_choice");
  const structuredOutput = params.has("structured_outputs");
  const knowledge = model.knowledge_cutoff?.slice(0, 10) ?? existing?.knowledge;
  const openWeights = Boolean(model.hugging_face_id);
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: reasoning ? price(model.pricing.internal_reasoning) : undefined,
        cache_read: price(model.pricing.input_cache_read),
        cache_write: price(model.pricing.input_cache_write),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.top_provider.max_completion_tokens ?? existing?.limit?.output ?? context,
  };
  const canonical = existing?.base_model ?? baseModel ?? resolveCanonicalBaseModel(model.id);

  if (canonical !== undefined) {
    return factorBaseModel(
      canonical,
      {
        name: baseModel !== undefined || model.id.endsWith(":free") ? name : undefined,
        description: existing?.description ?? apiDescription ?? describeModel({
          id: model.id,
          name,
          family: familyValue,
          reasoning,
          tool_call: toolCall,
          structured_output: structuredOutput,
          open_weights: openWeights,
          limit,
          modalities: { input, output },
        }),
        attachment,
        reasoning,
        reasoning_options,
        temperature: params.has("temperature"),
        tool_call: toolCall,
        structured_output: structuredOutput,
        status: existing?.status,
        interleaved: existing?.interleaved,
        limit,
        modalities: { input, output },
        cost,
      },
      limit,
      existing?.base_model === canonical ? existing.base_model_omit : undefined,
    );
  }

  return {
    name,
    description: existing?.description ?? apiDescription ?? describeModel({
      id: model.id,
      name,
      family: familyValue,
      reasoning,
      tool_call: toolCall,
      structured_output: structuredOutput,
      open_weights: openWeights,
      limit,
      modalities: { input, output },
    }),
    family: familyValue,
    release_date: releaseDate,
    last_updated: releaseDate,
    attachment,
    reasoning,
    reasoning_options,
    temperature: params.has("temperature"),
    tool_call: toolCall,
    structured_output: structuredOutput,
    knowledge,
    open_weights: openWeights,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function KiloReasoningOptions(opencode: KiloModel["opencode"]): SyncedFullModel["reasoning_options"] {
  if (opencode?.variants === undefined) return undefined;

  const options: NonNullable<SyncedFullModel["reasoning_options"]> = [];
  const variants = Object.entries(opencode.variants);

  if (variants.length === 0) return undefined;

  const reasoningEffortOrder = new Map<string, number>([
    ["none", 0],
    ["minimal", 1],
    ["low", 2],
    ["medium", 3],
    ["high", 4],
    ["xhigh", 5],
    ["max", 6],
  ]);

  const efforts = variants
    .filter(([, variant]) => variant.reasoning?.enabled === true)
    .map(([, variant]) => variant.reasoning?.effort)
    .filter((effort): effort is string => effort !== undefined);
  const hasNone = variants.some(([, variant]) => variant.reasoning?.enabled === false);
  const allEfforts = [...new Set(hasNone ? [...efforts, "none"] : efforts)];

  if (allEfforts.length > 0) {
    const orderedEfforts = allEfforts.sort((a, b) => {
      const order = (reasoningEffortOrder.get(a) ?? Number.MAX_SAFE_INTEGER)
        - (reasoningEffortOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
      return order;
    });
    options.push({
      type: "effort",
      values: orderedEfforts as Array<string | null>,
    });
  }

  return options.length > 0 ? options : undefined;
}
