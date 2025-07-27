#!/usr/bin/env bun

import path from "path";
import Parser from "rss-parser";
import ogs from "open-graph-scraper";
import { mkdir } from "fs/promises";
import { Article } from "spin.dev";

/**
 * ogs: github
 *  example:
 * <meta name="twitter:image" content="https://github.githubassets.com/assets/gist-og-image-54fd7dc0713e.png" /><meta name="twitter:site" content="@github" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="dexec.sh" /><meta name="twitter:description" content="dexec.sh. GitHub Gist: instantly share code, notes, and snippets." />
 * <meta property="og:image" content="https://github.githubassets.com/assets/gist-og-image-54fd7dc0713e.png" /><meta property="og:image:alt" content="dexec.sh. GitHub Gist: instantly share code, notes, and snippets." /><meta property="og:site_name" content="Gist" /><meta property="og:type" content="article" /><meta property="og:title" content="dexec.sh" /><meta property="og:url" content="https://gist.github.com/papes1ns/060ee5ddd32bf89c8c8607dc0d81b308" /><meta property="og:description" content="dexec.sh. GitHub Gist: instantly share code, notes, and snippets." /><meta property="article:author" content="262588213843476" /><meta property="article:publisher" content="262588213843476" />
 */

/**
 * ogs: atomicobject
 * example:
 * <meta property="og:locale" content="en_US" />
 * <meta property="og:type" content="article" />
 * <meta property="og:title" content="Aurora MySQL 8 Upgrade: Using the AWS Blue/Green Style" />
 * <meta property="og:description" content="Upgrade database with AWS RDS going from Aurora MySQL 5.7 to 8.0 using Blue/Green deployment. No downtime. No more RDS Extended Support." />
 * <meta property="og:url" content="https://spin.atomicobject.com/aurora-mysql-8-aws-blue-green/" />
 * <meta property="og:site_name" content="Atomic Spin" />
 * <meta property="article:publisher" content="https://www.facebook.com/atomicobject" />
 * <meta property="article:published_time" content="2025-02-12T13:00:51+00:00" />
 * <meta property="article:modified_time" content="2025-02-12T19:52:56+00:00" />
 * <meta property="og:image" content="https://spin.atomicobject.com/wp-content/uploads/papes-graphic.jpg" />
 * <meta property="og:image:width" content="1531" />
 * <meta property="og:image:height" content="796" />
 * <meta property="og:image:type" content="image/jpeg" />
 * <meta name="author" content="Nathan Papes" />
 * <meta name="twitter:card" content="summary_large_image" />
 * <meta name="twitter:creator" content="@atomicobject" />
 * <meta name="twitter:site" content="@atomicobject" />
 * <meta name="twitter:label1" content="Written by" />
 * <meta name="twitter:data1" content="Nathan Papes" />
 * <meta name="twitter:label2" content="Est. reading time" />
 * <meta name="twitter:data2" content="7 minutes" />
*/

type FeedItem = Parser.Item & { isoDate?: string };

type Translator = (params: {
  item: FeedItem;
  og: any;
  defaultArticle: Partial<Article> & { url: string };
}) => Partial<Article>;

// Translator registry keyed by providerId
const translators: Record<string, Translator> = {
  github: ({ item, og, defaultArticle }) => {
    const link = defaultArticle.url;
    // Gist/GitHub URL pattern – id is last path segment
    const id = (link as string).split("/").pop() ?? slugify(item.title ?? "untitled");

    // Use OG/Twitter title first, then RSS title, then ID as fallback
    const title = (og.ogTitle as string) || (og.twitterTitle as string) || item.title || id;

    // Use OG/Twitter description first, then RSS description
    const desc = (og.ogDescription as string) || (og.twitterDescription as string) || item.contentSnippet || undefined;

    // Add language tag based on file extension if available (e.g. foo.rb -> ruby)
    let tags: string[] | undefined;
    if (item.title?.includes(".")) {
      const ext = item.title!.split(".").pop()?.toLowerCase();
      if (ext && ext.length <= 5) tags = [ext];
    }

    return { id, title, description: desc, tags };
  },
  atomicobject: ({ item, og, defaultArticle }) => {
    // Extract reading time from Twitter meta data (e.g., "7 minutes")
    const twitterReadingTime = (og as any).twitterData2 as string;
    let reading_time: string | undefined;
    
    if (twitterReadingTime) {
      // Extract just the number from "7 minutes" -> "7"
      const match = twitterReadingTime.match(/(\d+)/);
      reading_time = match ? match[1] : undefined;
    }

    // Use article published/modified times if available
    const articlePublished = (og as any).articlePublishedTime as string;
    const articleModified = (og as any).articleModifiedTime as string;
    
    let created_at: string | undefined;
    let updated_at: string | undefined;
    
    if (articlePublished) {
      created_at = new Date(articlePublished).toISOString();
    }
    if (articleModified) {
      updated_at = new Date(articleModified).toISOString();
    }

    return { 
      reading_time,
      ...(created_at && { created_at }),
      ...(updated_at && { updated_at })
    };
  },
};

// Utility to create URL/file-safe slugs
function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Very small TOML serializer (handles string, number, array, boolean)
function toToml(obj: Record<string, any>): string {
  return Object.entries(obj)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k} = [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      }
      return `${k} = ${JSON.stringify(v)}`;
    })
    .join("\n");
}

// Recursively fetch Atom/RSS feeds following rel="next" links
async function fetchFeedRecursive(parser: Parser, url: string, visited = new Set<string>()): Promise<Parser.Item[]> {
  if (visited.has(url)) return [];
  visited.add(url);
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch {
    return [];
  }
  const items: Parser.Item[] = feed.items ?? [];

  // rss-parser exposes feed.next for atom rel="next" links; otherwise inspect atom:link
  const nextUrl = (feed as any).next ?? extractNextLink(feed as any);
  if (typeof nextUrl === "string" && nextUrl.length > 0) {
    const more = await fetchFeedRecursive(parser, nextUrl, visited);
    items.push(...more);
  }
  return items;
}

function extractNextLink(feed: any): string | undefined {
  const links = feed["atom:link"];
  if (!links) return undefined;
  const linkArr = Array.isArray(links) ? links : [links];
  for (const l of linkArr) {
    if (l.$?.rel === "next" && l.$?.href) return l.$.href as string;
  }
  return undefined;
}

(async () => {
  const providersDir = path.join(import.meta.dir, "..", "providers");

  // Scan for both provider.toml and legacy providor.toml
  for await (const providerFile of new Bun.Glob("*/provider*.toml").scan({
    cwd: providersDir,
    absolute: true,
  })) {
    const providerDir = path.dirname(providerFile);
    const providerId = path.basename(providerDir);
    console.log(`Processing provider ${providerFile}/${providerId}`);

    const providerConfig = await import(providerFile, { with: { type: "toml" } }).then((m) => m.default);
    const feedUrl: string | undefined = providerConfig.url;

    if (!feedUrl) {
      console.warn(`Provider ${providerId} TOML missing url – skipping`);
      continue;
    }

    // Use recursive RSS/Atom feed parsing for all providers
    const parser = new Parser();
    const feedItems = await fetchFeedRecursive(parser, feedUrl);

    for (const item of feedItems) {
      const linkRaw = item.link ?? item.guid;
      if (!linkRaw) continue;
      const link = linkRaw as string;

      // Scrape open-graph metadata
      const { result: og } = await ogs({ url: link }).catch((e) => (
        console.log(`Unable to scrape open-graph metadata for ${link}:`, e),
        { result: ({} as any) }
      ));

      const titleBase = (og.ogTitle as string) || item.title || "Untitled";

      // Base fields common to all providers
      const createdISO = (item.isoDate as string) || (item.pubDate as string) || new Date().toISOString();

      // Attempt to get a meaningful description; undefined if empty
      const maybeDesc = (og.ogDescription as string) || item.contentSnippet;

      const baseArticle: Partial<Article> & { url: string } = {
        id: slugify(titleBase),
        title: titleBase,
        description: maybeDesc?.trim() ? maybeDesc : undefined,
        url: link,
        created_at: createdISO,
        updated_at: createdISO,
        tags: (item.categories as string[]) ?? undefined,
      };

      // Merge in provider-specific overrides
      const translator = translators[providerId] ?? (() => ({}));
      const providerPatch = translator({ item, og, defaultArticle: baseArticle });

      const contentObj: Partial<Article> = {
        ...baseArticle,
        ...providerPatch,
      };

      // Ensure tags is at least an empty array
      if (contentObj.tags === undefined) {
        contentObj.tags = [];
      }

      // Calculate reading time (as string) only if not provided by translator
      if (contentObj.reading_time === undefined && contentObj.description) {
        const words = contentObj.description.split(/\s+/);
        const readingMinutes = Math.max(1, Math.ceil(words.length / 200));
        contentObj.reading_time = readingMinutes.toString();
      }

      const parsed = Article.safeParse(contentObj);
      if (!parsed.success) {
        console.error(`Article validation failed for ${link}:`, parsed.error.issues);
        continue;
      }

      const contentDir = path.join(providerDir, "content");
      await mkdir(contentDir, { recursive: true });
      const filename = `${createdISO.split("T")[0]}_${slugify(titleBase)}.toml`;
      await Bun.write(path.join(contentDir, filename), toToml(parsed.data));
      console.log(`Saved ${providerId}/${filename}`);
    }
  }
})();