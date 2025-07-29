#!/usr/bin/env bun

/**
 * Generate the `providers/` folder from the configuration in `rss/rss.toml`.
 *
 * For each provider we:
 *   1. Fetch the Atom/RSS feed.
 *   2. Parse entries (title, link, published date, summary).
 *   3. Fetch the content URL and extract Open-Graph / Twitter meta-tags for
 *      reading time and tags using Bun's HTMLRewriter API – see
 *      https://bun.sh/guides/html-rewriter/extract-links .
 *   4. Materialise a `provider.toml` and individual `content/<content>.toml`
 *      files so the rest of the build pipeline (generate.ts, render.tsx, etc.)
 *      can remain unchanged.
 */

import { Content, Provider } from "@spin.dev/core";
import fs from "fs/promises";
import { cpus } from "os";
import path from "path";

// ---------- Helpers --------------------------------------------------------

/** Simple slug generator – lowercase, alphanumeric & hyphens only */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Ensure slug is unique within a given Set; append numeric suffixes if needed */
function uniqueSlug(base: string, existing: Set<string>): string {
  let candidate = base || "content";
  let i = 1;
  while (existing.has(candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

/** Very small TOML serialiser for our limited use-case */
function toTOML(obj: Record<string, unknown>): string {
  return (
    Object.entries(obj)
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key} = ${JSON.stringify(value)}`;
        if (typeof value === "string")
          return `${key} = ${JSON.stringify(value)}`;
        return `${key} = ${value}`;
      })
      .join("\n") + "\n"
  );
}

/** Remove wrapping CDATA markers from a string */
function stripCDATA(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gis, "$1").trim();
}

/** Decode HTML entities (e.g. &amp; &#039;) to plain text */
function decodeEntities(str: string): string {
  if (!str) return "";
  // Prefer DOMParser if available (in Bun it usually is)
  try {
    if (typeof (globalThis as any).DOMParser !== "undefined") {
      const doc = new (globalThis as any).DOMParser().parseFromString(
        str,
        "text/html"
      );
      return doc.documentElement.textContent || "";
    }
  } catch {}
  // Fallback – minimal replacements
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'");
}

// Extract meta tags from the content page using HTMLRewriter.
async function enrichContent(url: string): Promise<Partial<Content>> {
  const partial: Partial<Content> = {};

  try {
    const response = await fetch(url, { redirect: "follow" });

    const rewriter = new HTMLRewriter()
      // Twitter card – reading time e.g. "7 minutes"
      .on("meta[name='twitter:data2']", {
        element(el: any) {
          const content = el.getAttribute("content") || "";
          const match = content.match(/(\d+)/);
          if (match) partial.reading_time_minutes = Number(match[1]);
        },
      })
      // OG title / description
      .on("meta[property='og:title']", {
        element(el: any) {
          const content = el.getAttribute("content");
          if (content) partial.title = content;
        },
      })
      .on("meta[property='og:description']", {
        element(el: any) {
          const content = el.getAttribute("content");
          if (content) partial.description = content;
        },
      })
      // Tags (multiple) - not used currently but could be in the future
      .on("meta[property='content:tag']", {
        element(el: any) {
          const tag = el.getAttribute("content");
          if (tag) {
            (partial.tags ??= []).push(tag);
          }
        },
      })
      // Published time (ISO) – OpenGraph Content extension
      .on("meta[property='content:published_time']", {
        element(el: any) {
          const content = el.getAttribute("content");
          if (content) partial.created_at = content;
        },
      });

    // Consume body to completion so the rewriter runs.
    await rewriter.transform(response).arrayBuffer();
  } catch (err) {
    console.warn(`Failed to enrich content ${url}:`, err);
  }

  return partial;
}

// Naïve XML parsing using DOMParser (available in Bun). Fallback to regex if
// DOMParser is unavailable (e.g. older Bun versions).
function parseFeedEntries(xml: string): Array<{
  title: string;
  link: string;
  published: string;
  summary?: string;
  tags?: string[];
}> {
  if (typeof (globalThis as any).DOMParser !== "undefined") {
    const doc = new (globalThis as any).DOMParser().parseFromString(
      xml,
      "application/xml"
    );
    const entries = Array.from(doc.querySelectorAll("entry, item"));
    return entries.map((el: any) => {
      const title = decodeEntities(
        stripCDATA(el.querySelector("title")?.textContent ?? "")
      );
      let link = "";
      const linkEl = el.querySelector("link") as any;
      if (linkEl) {
        link = linkEl.getAttribute("href") || linkEl.textContent || "";
      }
      const published =
        el.querySelector("published, pubDate, updated")?.textContent?.trim() ||
        new Date().toISOString();
      const summary = decodeEntities(
        stripCDATA(el.querySelector("summary, description")?.textContent ?? "")
      );

      // Extract categories as tags
      const tagNodes = Array.from(el.querySelectorAll("category"));
      const tags = tagNodes
        .map((c: any) => (c.getAttribute("term") || c.textContent || "").trim())
        .filter(Boolean);

      return { title, link, published, summary, tags };
    });
  }

  // Very small regex fallback – not perfect but works for simple feeds.
  const items: Array<{
    title: string;
    link: string;
    published: string;
    summary?: string;
    tags?: string[];
  }> = [];
  const entryRegex = /<(entry|item)[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml))) {
    const block = match[2] as string;
    const title = decodeEntities(
      stripCDATA(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "")
    );
    const link =
      block.match(/<link[^>]*href=["']([^"']+)["']/)?.[1] ||
      block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ||
      "";
    const published =
      block
        .match(/<(published|updated|pubDate)[^>]*>([\s\S]*?)<\//)?.[2]
        ?.trim() || new Date().toISOString();
    const summary = decodeEntities(
      stripCDATA(
        block.match(/<(summary|description)[^>]*>([\s\S]*?)<\//)?.[2] ?? ""
      )
    );

    // Extract categories
    const tags: string[] = [];
    const catRegex = /<category[^>]*?(?:\/>|>[\s\S]*?<\/category>)/g;
    const catMatches = block.match(catRegex) || [];
    for (const cat of catMatches) {
      const term = cat.match(/term=["']([^"']+)["']/)?.[1];
      const inner = cat.match(/<category[^>]*>([\s\S]*?)<\/category>/)?.[1];
      const val = term || inner || "";
      if (val.trim()) tags.push(val.trim());
    }

    items.push({ title, link, published, summary, tags });
  }
  return items;
}

// ---------- Main script ----------------------------------------------------

const ROOT = path.join(import.meta.dir, "..", "providers");
await fs.rm(ROOT, { recursive: true, force: true });

const rssConfigPath = path.join(import.meta.dir, "..", "rss", "rss.toml");
const configModule = await import(rssConfigPath, { with: { type: "toml" } });
const configs: Record<string, any> = configModule.default as any;

for (const [providerId, cfg] of Object.entries(configs)) {
  // Ensure required fields
  const providerMeta: Provider = {
    id: providerId.toLowerCase(),
    name: providerId,
    profile: cfg.profile ?? cfg.url ?? "",
    rss: cfg.rss ?? cfg.url ?? "",
  } as Provider;

  // Fetch & parse feed ------------------------------------------------------
  console.log(`Fetching feed for ${providerId}…`);
  const feedResponse = await fetch(providerMeta.rss, { redirect: "follow" });
  const feedXml = await feedResponse.text();
  const entries = parseFeedEntries(feedXml).slice(0, 30); // limit to 30 most recent

  // Concurrent feeders
  const concurrency = Math.max(5, cpus().length - 1);
  const queue: Promise<void>[] = [];

  const usedSlugs = new Set<string>();

  for (const entry of entries) {
    const task = (async () => {
      const rawSlug = slugify(entry.title) || slugify(entry.link);
      const contentId = uniqueSlug(rawSlug, usedSlugs);
      usedSlugs.add(contentId);

      const baseContent: Content = {
        id: contentId.toLowerCase(),
        title: decodeEntities(entry.title),
        description: decodeEntities(entry.summary ?? ""),
        url: entry.link,
        created_at: entry.published.endsWith("Z")
          ? entry.published
          : new Date(entry.published).toISOString().replace(/\.\d+Z$/, "Z"), // ISO-8601 string
        // Include initial tags parsed from feed
        ...(entry.tags && entry.tags.length
          ? { tags: entry.tags.map(decodeEntities) }
          : {}),
      } as Content;

      const enriched = await enrichContent(entry.link);

      // Decode any entities in enriched text fields
      if (enriched.title) enriched.title = decodeEntities(enriched.title);
      if (enriched.description)
        enriched.description = decodeEntities(enriched.description);

      // Merge tags from enrichment and feed
      if (enriched.tags || baseContent.tags) {
        const merged = Array.from(
          new Set([...(baseContent.tags ?? []), ...(enriched.tags ?? [])])
        );
        if (merged.length) baseContent.tags = merged.map(decodeEntities);
        // Remove tags from enriched to avoid duplication when spreading below
        delete (enriched as any).tags;
      }

      const content: Content = { ...baseContent, ...enriched } as Content;

      // Write content TOML ---------------------------------------------------
      const contentDir = path.join(ROOT, providerId, "content");
      await fs.mkdir(contentDir, { recursive: true });
      await fs.writeFile(
        path.join(contentDir, `${contentId}.toml`),
        toTOML(content)
      );
    })();

    queue.push(task);

    if (queue.length >= concurrency) {
      await Promise.race(
        queue.map((p) => p.then(() => queue.splice(queue.indexOf(p), 1)))
      );
    }
  }

  await Promise.all(queue); // flush remaining

  // Write provider metadata -----------------------------------------------
  const providerDir = path.join(ROOT, providerId);
  await fs.mkdir(providerDir, { recursive: true });
  await fs.writeFile(
    path.join(providerDir, "provider.toml"),
    toTOML(providerMeta)
  );
}

console.log("✅ providers folder refreshed");
