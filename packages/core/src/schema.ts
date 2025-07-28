import { z } from "zod";

export const Model = z
  .object({
    id: z.string().toLowerCase(),
    name: z.string().min(1, "Model name cannot be empty"),
    attachment: z.boolean(),
    reasoning: z.boolean(),
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
        cache_read: z
          .number()
          .min(0, "Cache read price cannot be negative")
          .optional(),
        cache_write: z
          .number()
          .min(0, "Cache write price cannot be negative")
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number().min(0, "Context window must be positive"),
      output: z.number().min(0, "Output tokens must be positive"),
    }),
  })
  .strict();

export type Model = z.infer<typeof Model>;

export const Provider = z
  .object({
    id: z.string().toLowerCase(),
    env: z.array(z.string()).min(1, "Provider env cannot be empty"),
    npm: z.string().min(1, "Provider npm module cannot be empty"),
    api: z.string().optional(),
    name: z.string().min(1, "Provider name cannot be empty"),
    icon: z.string().optional(),
    iconUrl: z.string().optional(),
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
