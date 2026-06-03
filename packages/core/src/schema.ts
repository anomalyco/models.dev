import { z } from "zod";

import { ModelFamily } from "./family";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
);

const ReasoningOption = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("toggle"),
      })
      .strict(),
    z
      .object({
        type: z.literal("effort"),
        values: z.array(
          z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("budget_tokens"),
        min: z
          .number()
          .min(0, "Minimum reasoning budget cannot be negative")
          .optional(),
        max: z
          .number()
          .min(0, "Maximum reasoning budget cannot be negative")
          .optional(),
      })
      .strict(),
  ])
  .refine(
    (data) =>
      data.type !== "budget_tokens" ||
      data.min === undefined ||
      data.max === undefined ||
      data.min <= data.max,
    {
      message:
        "Minimum reasoning budget cannot exceed maximum reasoning budget",
      path: ["min"],
    },
  );

const Cost = z.object({
  input: z.number().min(0, "Input price cannot be negative"),
  output: z.number().min(0, "Output price cannot be negative"),
  reasoning: z.number().min(0, "Reasoning price cannot be negative").optional(),
  cache_read: z
    .number()
    .min(0, "Cache read price cannot be negative")
    .optional(),
  cache_write: z
    .number()
    .min(0, "Cache write price cannot be negative")
    .optional(),
  input_audio: z
    .number()
    .min(0, "Audio input price cannot be negative")
    .optional(),
  output_audio: z
    .number()
    .min(0, "Audio output price cannot be negative")
    .optional(),
});

const CostTier = Cost.extend({
  tier: z
    .object({
      type: z.literal("context").default("context"),
      size: z.number().int().min(0, "Context tier size cannot be negative"),
    })
    .strict(),
}).strict();

const AuthoredCost = Cost.extend({
  context_over_200k: z.never().optional(),
  tiers: z.array(CostTier).optional(),
});

const OutputCost = Cost.extend({
  context_over_200k: Cost.optional(),
  tiers: z.array(CostTier).optional(),
});

const DateString = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, {
  message: "Must be in YYYY-MM or YYYY-MM-DD format",
});

const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

const Modalities = z
  .object({
    input: z.array(Modality),
    output: z.array(Modality),
  })
  .strict();

const LimitBase = z
  .object({
    context: z.number().min(0, "Context window must be positive"),
    input: z.number().min(0, "Input tokens must be positive").optional(),
  })
  .strict();

const ModelLimit = LimitBase.extend({
  output: z.number().min(0, "Output tokens must be positive").optional(),
}).strict();

const ProviderModelLimit = LimitBase.extend({
  output: z.number().min(0, "Output tokens must be positive"),
}).strict();

const UrlString = z.string().url("Must be a valid URL");

export const ModelLink = z
  .object({
    label: z.string().min(1, "Link label cannot be empty").optional(),
    url: UrlString,
    type: z
      .enum([
        "announcement",
        "blog",
        "docs",
        "license",
        "model_card",
        "paper",
        "weights",
        "other",
      ])
      .optional(),
  })
  .strict();

export const ModelWeights = z
  .object({
    label: z.string().min(1, "Weights label cannot be empty").optional(),
    url: UrlString,
    format: z.string().min(1, "Weights format cannot be empty").optional(),
    quantization: z
      .string()
      .min(1, "Weights quantization cannot be empty")
      .optional(),
  })
  .strict();

export const BenchmarkResult = z
  .object({
    name: z.string().min(1, "Benchmark name cannot be empty"),
    score: z.union([z.number(), z.string().min(1)]),
    metric: z.string().min(1, "Benchmark metric cannot be empty").optional(),
    source: UrlString.optional(),
    date: DateString.optional(),
  })
  .strict();

const ModelMetadataBase = z.object({
  id: z.string(),
  name: z.string().min(1, "Model name cannot be empty"),
  family: ModelFamily.optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: DateString.optional(),
  release_date: DateString.optional(),
  last_updated: DateString.optional(),
  modalities: Modalities.optional(),
  open_weights: z.boolean().optional(),
  limit: ModelLimit.optional(),
  license: z.string().min(1, "License cannot be empty").optional(),
  links: z.array(ModelLink).optional(),
  weights: z.array(ModelWeights).optional(),
  benchmarks: z.array(BenchmarkResult).optional(),
});

export const ModelMetadata = ModelMetadataBase.strict();

export type ModelMetadata = z.infer<typeof ModelMetadata>;

const ModelBase = z.object({
  id: z.string(),
  name: z.string().min(1, "Model name cannot be empty"),
  family: ModelFamily.optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  reasoning_options: z.array(ReasoningOption).optional(),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, {
      message: "Must be in YYYY-MM or YYYY-MM-DD format",
    })
    .optional(),
  release_date: DateString,
  last_updated: DateString,
  modalities: Modalities,
  open_weights: z.boolean(),
  limit: ProviderModelLimit,
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  experimental: z
    .object({
      modes: z
        .record(
          z.object({
            cost: Cost.optional(),
            provider: z
              .object({
                body: z.record(JsonValue).optional(),
                headers: z.record(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  provider: z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
      shape: z.enum(["responses", "completions"]).optional(),
      body: z.record(JsonValue).optional(),
      headers: z.record(z.string()).optional(),
    })
    .optional(),
});

function refineModel<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine(
      (data) => {
        return !(
          data.reasoning === false && data.cost?.reasoning !== undefined
        );
      },
      {
        message: "Cannot set cost.reasoning when reasoning is false",
        path: ["cost", "reasoning"],
      },
    )
    .refine(
      (data) => {
        const tiers = data.cost?.tiers;
        if (tiers === undefined) return true;

        const sizes = tiers.map(
          (tier: { tier: { size: number } }) => tier.tier.size,
        );
        return new Set(sizes).size === sizes.length;
      },
      {
        message: "Cost context tiers must not have duplicate sizes",
        path: ["cost", "tiers"],
      },
    );
}

export const ModelShape = z
  .object({
    ...ModelBase.shape,
    cost: OutputCost.optional(),
  })
  .strict();

export const AuthoredModelShape = z
  .object({
    ...ModelBase.shape,
    cost: AuthoredCost.optional(),
  })
  .strict();

export const Model = refineModel(ModelShape);

export const AuthoredModel = refineModel(AuthoredModelShape);

export type Model = z.infer<typeof Model>;

export const Provider = z
  .object({
    id: z.string(),
    env: z.array(z.string()).min(1, "Provider env cannot be empty"),
    npm: z.string().min(1, "Provider npm module cannot be empty"),
    api: z.string().optional(),
    name: z.string().min(1, "Provider name cannot be empty"),
    doc: z
      .string()
      .min(
        1,
        "Please provide a link to the provider documentation where models are listed",
      ),
    models: z.record(Model),
  })
  .strict()
  .refine(
    (data) => {
      const isOpenAI = data.npm === "@ai-sdk/openai";
      const isOpenAIcompatible = data.npm === "@ai-sdk/openai-compatible";
      const isOpenrouter = data.npm === "@openrouter/ai-sdk-provider";
      const isAnthropic = data.npm === "@ai-sdk/anthropic";
      const isKiro = data.npm === "kiro-acp-ai-provider";
      const hasApi = data.api !== undefined;

      return (
        // openai-compatible: must have api
        (isOpenAIcompatible && hasApi) ||
        // openrouter: must have api
        (isOpenrouter && hasApi) ||
        // anthropic: api optional (always allowed)
        isAnthropic ||
        // openai: api optional (always allowed)
        isOpenAI ||
        // kiro: api optional (always allowed)
        isKiro ||
        // all others: must NOT have api
        (!isOpenAI &&
          !isOpenAIcompatible &&
          !isOpenrouter &&
          !isAnthropic &&
          !isKiro &&
          !hasApi)
      );
    },
    {
      message:
        "'api' is required for openai-compatible and openrouter, optional for anthropic, openai, and kiro, forbidden otherwise",
      path: ["api"],
    },
  );

export type Provider = z.infer<typeof Provider>;
