import { z } from "zod";

export const Article = z
  .object({
    id: z.string().toLowerCase(),
    title: z.string().min(1, "Article title cannot be empty"),
    description: z.string().min(1, "Article description cannot be empty").optional(),
    url: z.string().url("Must be a valid URL"),
    created_at: z.string(),
    updated_at: z.string(),
    reading_time: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type Article = z.infer<typeof Article>;

export const Provider = z
  .object({
    id: z.string().toLowerCase(),
    name: z.string().min(1, "Provider name cannot be empty"),
    url: z.string().url("Must be a valid URL"),
    articles: z.record(Article).optional(),
    next_page_url: z.string().url("Must be a valid URL").optional(),
  })
  .strict();

export type Provider = z.infer<typeof Provider>;
