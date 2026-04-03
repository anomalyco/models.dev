import { z } from "zod";

import { ModelFamily } from "./family";

const Cost = z.object({
  input: z.number().min(0, "Input price cannot be negative"),
  output: z.number().min(0, "Output price cannot be negative"),
  reasoning: z.number().min(0, "Input price cannot be negative").optional(),
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

/**
 * A pricing tier that applies when the total input tokens (input + cache_read)
 * meet or exceed the min_context threshold. Matches OpenRouter's tiered pricing
 * format: https://openrouter.ai/docs/guides/get-started/for-providers
 */
const ContextTier = z.object({
  min_context: z
    .number()
    .int()
    .positive("min_context must be a positive integer (token count)"),
  input: z.number().min(0, "Input price cannot be negative"),
  output: z.number().min(0, "Output price cannot be negative"),
  cache_read: z
    .number()
    .min(0, "Cache read price cannot be negative")
    .optional(),
  cache_write: z
    .number()
    .min(0, "Cache write price cannot be negative")
    .optional(),
});

export const Model = z
  .object({
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
    cost: Cost.extend({
      /**
       * @deprecated Use `context_tiers` instead.
       * Kept for backward compatibility — consumers should merge this into
       * context_tiers if present.
       */
      context_over_200k: Cost.optional(),
      /**
       * Ordered array of pricing tiers that apply when total input tokens
       * (input + cache_read) meet or exceed the tier's min_context threshold.
       * Only the highest matching tier is applied.
       *
       * Example (TOML):
       * ```toml
       * [[cost.context_tiers]]
       * min_context = 200_000
       * input = 2.00
       * output = 6.00
       * cache_read = 0.40
       *
       * [[cost.context_tiers]]
       * min_context = 500_000
       * input = 4.00
       * output = 12.00
       * cache_read = 0.80
       * ```
       */
      context_tiers: z
        .array(ContextTier)
        .max(4, "Maximum 4 context tiers supported")
        .optional(),
    }).optional(),
    limit: z.object({
      context: z.number().min(0, "Context window must be positive"),
      input: z.number().min(0, "Input tokens must be positive").optional(),
      output: z.number().min(0, "Output tokens must be positive"),
    }),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    provider: z
      .object({
        npm: z.string().optional(),
        api: z.string().optional(),
        shape: z.enum(["responses", "completions"]).optional(),
      })
      .optional(),
  })
  .strict()
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
      const tiers = data.cost?.context_tiers;
      if (!tiers || tiers.length < 2) return true;
      // Ensure tiers are sorted by min_context ascending
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i]!.min_context <= tiers[i - 1]!.min_context) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        "context_tiers must be sorted by min_context in ascending order",
      path: ["cost", "context_tiers"],
    },
  );

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
        // all others: must NOT have api
        (!isOpenAI &&
          !isOpenAIcompatible &&
          !isOpenrouter &&
          !isAnthropic &&
          !hasApi)
      );
    },
    {
      message:
        "'api' is required for openai-compatible and openrouter, optional for anthropic and openai, forbidden otherwise",
      path: ["api"],
    },
  );

export type Provider = z.infer<typeof Provider>;
