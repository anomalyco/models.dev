import { z } from "zod";

export const Model = z
  .object({
    id: z.string(),
    name: z.string().min(1, "Model name cannot be empty"),
    attachment: z.boolean(),
    reasoning: z.union([
      z.boolean(),
      z.object({
        supported: z.boolean(),
        controllable: z.boolean().optional(),
        type: z.enum(["effort", "budget"]).optional(),
        effort_levels: z.array(z.string()).optional(),
        budget_range: z.object({
          min: z.number(),
          max: z.number(),
          dynamic: z.number().optional(),
          off: z.number().optional(),
        }).optional(),
        default: z.union([z.string(), z.number()]).optional(),
      }).refine((data) => {
        if (!data.supported) return true;
        if (data.type === "effort" && !data.effort_levels?.length) return false;
        if (data.type === "budget" && !data.budget_range) return false;
        return true;
      }, {
        message: "effort_levels required for type 'effort', budget_range required for type 'budget'"
      }),
    ]),
    temperature: z.boolean(),
    tool_call: z.boolean(),
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
    cost: z
      .object({
        input: z.number().min(0, "Input price cannot be negative"),
        output: z.number().min(0, "Output price cannot be negative"),
        reasoning: z
          .number()
          .min(0, "Input price cannot be negative")
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
      })
      .optional(),
    limit: z.object({
      context: z.number().min(0, "Context window must be positive"),
      output: z.number().min(0, "Output tokens must be positive"),
    }),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    provider: z
      .object({
        npm: z.string().optional(),
        api: z.string().optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (data) => {
      const reasoningSupported = typeof data.reasoning === "boolean" 
        ? data.reasoning 
        : data.reasoning.supported;
      return !(reasoningSupported === false && data.cost?.reasoning !== undefined);
    },
    {
      message: "Cannot set cost.reasoning when reasoning is not supported",
      path: ["cost", "reasoning"],
    }
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
        "Please provide a link to the provider documentation where models are listed"
      ),
    models: z.record(Model),
  })
  .strict()
  .refine(
    (data) => {
      return (
        (data.npm === "@ai-sdk/openai-compatible" && data.api !== undefined) ||
        (data.npm !== "@ai-sdk/openai-compatible" && data.api === undefined)
      );
    },
    {
      message:
        "'api' field is required if and only if npm is '@ai-sdk/openai-compatible'",
      path: ["api"],
    }
  );
export type Provider = z.infer<typeof Provider>;
