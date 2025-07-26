import { z } from "zod";

/**
 * Image metadata extracted from Open Graph tags.
 *
 * Normalised so that all related attributes are bundled together.
 */
export const Image = z
  .object({
    /** Absolute URL of the image */
    url: z.string().url(),
    /** Width in pixels, if supplied */
    width: z.coerce.number().int().positive().optional(),
    /** Height in pixels, if supplied */
    height: z.coerce.number().int().positive().optional(),
    /** MIME-type of the image, e.g. `image/png` */
    type: z.string().optional(),
    /** Alternative text, if provided */
    alt: z.string().optional(),
  })
  .strict();
export type Image = z.infer<typeof Image>;

/**
 * Canonical, Open Graph and Twitter card metadata for an article/page.
 *
 * Fields are normalised and flattened so a list of articles can easily be
 * rendered in a compact table.
 */
export const Article = z
  .object({
    /** Page title – prefers `og:title` and falls back to `twitter:title` */
    title: z.string().min(1, "Title cannot be empty"),

    /** One-line summary extracted from `description` or `og:description` */
    description: z.string().min(1, "Description cannot be empty").optional(),

    /** Absolute URL of the page ( `og:url` or canonical `<link>` ) */
    url: z.string().url({ message: "Must be a valid absolute URL" }),

    /** Site/brand name (`og:site_name`) */
    siteName: z.string().optional(),

    /** IETF language tag (`og:locale`) */
    locale: z.string().optional(),

    /** Content type (`og:type`) – e.g. `article`, `website` */
    type: z.string().optional(),

    /** ISO-8601 publication timestamp (`article:published_time`) */
    publishedTime: z
      .string()
      .datetime({ offset: true })
      .optional(),

    /** Author name from `author` or `twitter:data1` */
    author: z.string().optional(),

    /** Facebook page / URL of the publisher (`article:publisher`) */
    publisher: z.string().url().optional(),

    /** Cover/Social image */
    image: Image.optional(),

    /** Twitter card style (`twitter:card`) */
    twitterCard: z
      .enum(["summary", "summary_large_image", "app", "player"])
      .optional(),

    /** Twitter handle of the author (`twitter:creator`) */
    twitterCreator: z.string().optional(),

    /** Twitter handle of the site (`twitter:site`) */
    twitterSite: z.string().optional(),

    /** Estimated reading time in minutes, if supplied */
    readingTimeMinutes: z.number().int().positive().optional(),
  })
  .strict();
export type Article = z.infer<typeof Article>;

/**
 * A convenience schema for displaying rows in a minimal table. It keeps only
 * the most frequently-used columns while maintaining type-safety by deriving
 * from the full `Article` object.
 */
export const ArticleRow = Article.pick({
  title: true,
  author: true,
  publishedTime: true,
  readingTimeMinutes: true,
  url: true,
}).extend({
  siteName: Article.shape.siteName,
});
export type ArticleRow = z.infer<typeof ArticleRow>;
