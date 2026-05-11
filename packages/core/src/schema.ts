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

const Cost = z
  .object({
    input: z.number().min(0, "Input price cannot be negative"),
    output: z.number().min(0, "Output price cannot be negative"),
    reasoning: z
      .number()
      .min(0, "Reasoning price cannot be negative")
      .optional(),
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
  context: z
    .object({
      min: z.number().min(0, "Context tier minimum cannot be negative").optional(),
      max: z.number().min(0, "Context tier maximum cannot be negative").optional(),
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

const ModelBase = z.object({
  id: z.string(),
  name: z.string().min(1, "Model name cannot be empty"),
  family: ModelFamily.optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
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
  release_date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, {
    message: "Must be in YYYY-MM or YYYY-MM-DD format",
  }),
  last_updated: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, {
    message: "Must be in YYYY-MM or YYYY-MM-DD format",
  }),
  modalities: z.object({
    input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
  }),
  open_weights: z.boolean(),
  limit: z.object({
    context: z.number().min(0, "Context window must be positive"),
    input: z.number().min(0, "Input tokens must be positive").optional(),
    output: z.number().min(0, "Output tokens must be positive"),
  }),
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
        return !(data.reasoning === false && data.cost?.reasoning !== undefined);
      },
      {
        message: "Cannot set cost.reasoning when reasoning is false",
        path: ["cost", "reasoning"],
      },
    )
    .refine(
      (data) => {
        return (
          data.cost?.tiers?.every((tier: { context: { min?: number; max?: number } }) => {
            const { min, max } = tier.context;
            return min !== undefined || max !== undefined;
          }) ?? true
        );
      },
      {
        message: "Cost tiers must include at least one context bound",
        path: ["cost", "tiers"],
      },
    )
    .refine(
      (data) => {
        return (
          data.cost?.tiers?.every((tier: { context: { min?: number; max?: number } }) => {
            const { min, max } = tier.context;
            return min === undefined || max === undefined || min < max;
          }) ?? true
        );
      },
      {
        message: "Cost tier context min must be less than max",
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
