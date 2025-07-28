import { z } from "zod";

// Normalised Content schema used throughout the project.
export const Content = z
  .object({
    id: z.string().toLowerCase(),
    title: z.string(),
    description: z.string().optional(),
    url: z.string().url("Must be a valid URL"),
    /** ISO-8601 timestamp of publish date */
    created_at: z.string(),
    /** Estimated reading time in minutes */
    reading_time_minutes: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type Content = z.infer<typeof Content>;

// Provider metadata – loosely based on RSS, but includes profile & rss urls.
export const Provider = z
  .object({
    id: z.string().toLowerCase(),
    name: z.string(),
    profile: z.string().url("Must be a valid URL"),
    rss: z.string().url("Must be a valid URL"),
    contents: z.record(Content).optional(),
  })
  .strict();

export type Provider = z.infer<typeof Provider>;
