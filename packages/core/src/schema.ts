import { z } from "zod";

export const Model = z
  .object({
    id: z.string(),
    name: z.string().min(1, "Model name cannot be empty"),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    cost: z.object({
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
    }),
    limit: z.object({
      context: z.number().min(0, "Context window must be positive"),
      output: z.number().min(0, "Output tokens must be positive"),
    }),
  })
  .strict();

export type Model = z.infer<typeof Model>;

export const Provider = z
  .object({
    id: z.string(),
    env: z.array(z.string()).min(1, "Provider env cannot be empty"),
    npm: z.string().min(1, "Provider npm module cannot be empty").optional(),
    name: z.string().min(1, "Provider name cannot be empty"),
    models: z.record(Model),
  })
  .strict();
export type Provider = z.infer<typeof Provider>;
