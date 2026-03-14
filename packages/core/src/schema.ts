import { z } from "zod";

import { ModelFamily } from "./family";

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Validates that a YYYY-MM or YYYY-MM-DD date string represents a real
 * calendar date (rejects impossible dates like 2024-02-31).
 */
function isRealDate(value: string): boolean {
  const parts = value.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (month < 1 || month > 12) return false;
  if (parts.length === 3) {
    const day = parseInt(parts[2], 10);
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day < 1 || day > daysInMonth) return false;
  }
  return true;
}

/**
 * Normalises a YYYY-MM or YYYY-MM-DD string to a plain numeric tuple
 * [year, month, day] so two dates with different precisions can be compared.
 * YYYY-MM is treated as the first of that month.
 */
function toDateTuple(value: string): [number, number, number] {
  const parts = value.split("-");
  return [
    parseInt(parts[0], 10),
    parseInt(parts[1], 10),
    parts.length > 2 ? parseInt(parts[2], 10) : 1,
  ];
}

function compareDates(a: string, b: string): number {
  const [ay, am, ad] = toDateTuple(a);
  const [by, bm, bd] = toDateTuple(b);
  if (ay !== by) return ay - by;
  if (am !== bm) return am - bm;
  return ad - bd;
}

// ── Date schema (reusable) ────────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, {
    message: "Must be in YYYY-MM or YYYY-MM-DD format",
  })
  .refine(isRealDate, {
    message: "Date is not a valid calendar date",
  });

// ── Cost schema ───────────────────────────────────────────────────────────────

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

// ── Model schema ──────────────────────────────────────────────────────────────

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
    knowledge: dateString.optional(),
    release_date: dateString,
    last_updated: dateString,
    modalities: z
      .object({
        input: z
          .array(z.enum(["text", "audio", "image", "video", "pdf"]))
          .min(1, "At least one input modality is required"),
        output: z
          .array(z.enum(["text", "audio", "image", "video", "pdf"]))
          .min(1, "At least one output modality is required"),
      })
      .strict(),
    open_weights: z.boolean(),
    cost: Cost.extend({
      context_over_200k: Cost.optional(),
    }).optional(),
    limit: z
      .object({
        context: z.number().min(0, "Context window must be non-negative"),
        input: z.number().min(0, "Input token limit must be non-negative").optional(),
        output: z.number().min(0, "Output token limit must be non-negative"),
      })
      .strict(),
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
      if (!data.release_date || !data.last_updated) return true;
      return compareDates(data.last_updated, data.release_date) >= 0;
    },
    {
      message: "last_updated cannot be earlier than release_date",
      path: ["last_updated"],
    },
  );

export type Model = z.infer<typeof Model>;

// ── Provider schema ───────────────────────────────────────────────────────────

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
