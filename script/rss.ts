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
import path from "path";
// (Bun currently ships a TOML parser but no serializer, so we keep a tiny helper)
// ---------------------------------------------------------------------------
// Polite scraping constants & utilities -------------------------------------
const USER_AGENT = "spin.dev/rss-bot (+https://natepapes.com)";
const CONCURRENCY_LIMIT = 5;
const CACHE_PATH = path.join(import.meta.dir, "..", ".cache", "rss-cache.json");

type CacheEntry = { etag?: string; lastModified?: string };

let feedCache: Record<string, CacheEntry> = {};
try {
  feedCache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
} catch {
  /* first run – cache will be created when we save later */
}

async function saveCache() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(feedCache, null, 2));
}

/** Simple semaphore enforcing max parallel requests per domain */
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    if (queue.length) queue.shift()!();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const run = () => {
        active++;
        fn().then(res).catch(rej).finally(next);
      };
      active < limit ? run() : queue.push(run);
    });
}

const acquire = createSemaphore(CONCURRENCY_LIMIT);

/** Fetch wrapper adding UA + retry/back-off for 429/503 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 3
): Promise<Response> {
  const opts: RequestInit = {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers as any) },
    redirect: "follow",
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (![429, 503].includes(res.status) || attempt === retries) return res;
    const retryAfter =
      Number(res.headers.get("retry-after")) * 1000 || 2 ** attempt * 1000;
    await new Promise((r) => setTimeout(r, retryAfter));
  }
  throw new Error(`Failed after ${retries + 1} retries → ${url}`);
}

// robots.txt disallow cache per origin
const robotsCache: Record<string, string[]> = {};
async function isAllowed(target: URL): Promise<boolean> {
  const origin = target.origin;
  if (!(origin in robotsCache)) {
    try {
      const res = await fetchWithRetry(`${origin}/robots.txt`);
      if (!res.ok) throw new Error();
      const txt = await res.text();
      const disallow: string[] = [];
      let inGlobal = false;
      for (const line of txt.split("\n")) {
        const trimmed = line.trim();
        if (/^user-agent:\s*\*/i.test(trimmed)) inGlobal = true;
        else if (/^user-agent:/i.test(trimmed)) inGlobal = false;
        else if (inGlobal && /^disallow:/i.test(trimmed)) {
          const parts = trimmed.split(":");
          if (parts[1]) disallow.push(parts[1].trim());
        }
      }
      robotsCache[origin] = disallow;
    } catch {
      robotsCache[origin] = []; // assume allowed if cannot fetch
    }
  }
  const rules = robotsCache[origin] ?? [];
  return rules.every((p) => !target.pathname.startsWith(p));
}
// ---------------------------------------------------------------------------

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

/** Convert an ISO8601 duration (e.g. PT4M13S) to seconds */
function isoDurationToSeconds(iso: string): number | undefined {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return undefined;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// Extract meta tags from the content page using HTMLRewriter (errors bubble up).
async function enrichContent(url: string): Promise<Partial<Content>> {
  const partial: Partial<Content> = {};

  const response = await fetchWithRetry(url);

  const rewriter = new HTMLRewriter()
    .on("meta[name='twitter:data2']", {
      element(el: any) {
        const match = el.getAttribute("content")?.match(/(\d+)/);
        if (match) partial.estimated_time_minutes = Number(match[1]);
      },
    })
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
    .on("meta[property='content:tag']", {
      element(el: any) {
        const tag = el.getAttribute("content");
        if (tag) (partial.tags ??= []).push(tag);
      },
    })
    .on("meta[property='content:published_time']", {
      element(el: any) {
        const content = el.getAttribute("content");
        if (content) partial.created_at = content;
      },
    })
    // YouTube video pages expose duration via og:video:duration (seconds)
    .on("meta[property='og:video:duration']", {
      element(el: any) {
        const secondsStr = el.getAttribute("content");
        const seconds = secondsStr ? Number(secondsStr) : undefined;
        if (seconds && !isNaN(seconds)) {
          partial.estimated_time_minutes = Math.ceil(seconds / 60);
        }
      },
    })
    // Fallback to itemprop=duration such as PT4M13S (ISO)
    .on("meta[itemprop='duration']", {
      element(el: any) {
        const iso = el.getAttribute("content");
        const secs = iso ? isoDurationToSeconds(iso) : undefined;
        if (secs && !isNaN(secs)) {
          partial.estimated_time_minutes = Math.ceil(secs / 60);
        }
      },
    });

  await rewriter.transform(response).arrayBuffer();

  return partial;
}

// Lightweight XML parsing via regex only (throws on malformed feeds).
function parseFeedEntries(xml: string): Array<{
  title: string;
  link: string;
  published: string;
  summary?: string;
  tags?: string[];
  durationSeconds?: number;
}> {
  const items: Array<{
    title: string;
    link: string;
    published: string;
    summary?: string;
    tags?: string[];
    durationSeconds?: number;
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
      (() => {
        throw new Error("Missing <link> in feed entry");
      })();

    const publishedRaw = block
      .match(/<(published|updated|pubDate)[^>]*>([\s\S]*?)<\//)?.[2]
      ?.trim();
    if (!publishedRaw)
      throw new Error("Missing <published>/<pubDate> in feed entry");

    const summary = decodeEntities(
      stripCDATA(
        block.match(/<(summary|description)[^>]*>([\s\S]*?)<\//)?.[2] ?? ""
      )
    );

    const tags: string[] = [];
    const catRegex = /<category[^>]*?(?:\/>|>[\s\S]*?<\/category>)/g;
    const catMatches = block.match(catRegex) || [];
    for (const cat of catMatches) {
      const term = cat.match(/term=["']([^"']+)["']/)?.[1];
      const inner = cat.match(/<category[^>]*>([\s\S]*?)<\/category>/)?.[1];
      const val = term || inner || "";
      if (val.trim()) tags.push(val.trim());
    }

    const durationMatch =
      block.match(/duration=["'](\d+)["']/) ||
      block.match(/<media:content[^>]*duration=["'](\d+)["']/) ||
      block.match(/<yt:duration[^>]*seconds=["'](\d+)["']/);
    const durationSeconds = durationMatch
      ? Number(durationMatch[1])
      : undefined;

    items.push({
      title,
      link,
      published: publishedRaw,
      summary,
      tags,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    });
  }

  if (!items.length)
    throw new Error("No <entry>/<item> elements found in feed");

  return items;
}

// ---------- Main script ----------------------------------------------------

const ROOT = path.join(import.meta.dir, "..", "providers");

// Optional --force flag to re-fetch feeds even if unchanged
const FORCE_REFRESH = process.argv.includes("--force");
// No global deletion; we remove per-provider directory only when feed changed.

const rssConfigPath = path.join(import.meta.dir, "..", "rss", "rss.toml");
const configModule = await import(rssConfigPath, { with: { type: "toml" } });
const configs: Record<string, any> = configModule.default as any;

for (const [providerId, cfg] of Object.entries(configs)) {
  // Ensure required fields
  const providerMeta: Provider = Provider.parse({
    id: providerId.toLowerCase(),
    name: providerId,
    profile: cfg.profile ?? cfg.url ?? "",
    rss: cfg.rss ?? cfg.url ?? "",
  });

  // Fetch & parse feed (ETag/Last-Modified cache) ---------------------------
  console.log(`Fetching feed for ${providerId}…`);

  const cacheEntry = feedCache[providerMeta.rss] ?? {};

  const conditionalHeaders = FORCE_REFRESH
    ? {}
    : {
        ...(cacheEntry.etag ? { "If-None-Match": cacheEntry.etag } : {}),
        ...(cacheEntry.lastModified
          ? { "If-Modified-Since": cacheEntry.lastModified }
          : {}),
      };

  let feedResponse = await fetchWithRetry(providerMeta.rss, {
    headers: conditionalHeaders,
  });

  // If server returned 304 but we are forcing refresh, re-request without
  // conditional headers to obtain the full feed body
  if (feedResponse.status === 304 && FORCE_REFRESH) {
    feedResponse = await fetchWithRetry(providerMeta.rss);
  }

  if (feedResponse.status === 304) {
    console.log("ℹ︎  Feed unchanged (304) – skipping.");
    continue;
  }

  if (!feedResponse.ok)
    throw new Error(
      `Failed to fetch feed (${feedResponse.status}) → ${providerMeta.rss}`
    );

  feedCache[providerMeta.rss] = {
    etag: feedResponse.headers.get("etag") ?? undefined,
    lastModified: feedResponse.headers.get("last-modified") ?? undefined,
  };

  const feedXml = await feedResponse.text();
  const entries = parseFeedEntries(feedXml).slice(0, 30); // limit to 30 most recent

  // If feed is modified, clear existing provider directory to regenerate fresh.
  const providerDir = path.join(ROOT, providerId);

  // remove old provider directory (including provider.toml & content) to avoid stale files
  await fs.rm(providerDir, { recursive: true, force: true });

  // Generate content files (concurrency-guarded) ----------------------------
  const usedSlugs = new Set<string>();

  await Promise.all(
    entries.map((entry) =>
      acquire(async () => {
        const linkURL = new URL(entry.link);
        if (!(await isAllowed(linkURL))) {
          console.warn(`⚠︎  robots.txt disallow – skipping ${entry.link}`);
          return;
        }

        const rawSlug = slugify(entry.title) || slugify(entry.link);
        const contentId = uniqueSlug(rawSlug, usedSlugs);
        usedSlugs.add(contentId);

        const baseContent: Content = Content.parse({
          id: contentId.toLowerCase(),
          title: decodeEntities(entry.title),
          description: decodeEntities(entry.summary ?? ""),
          url: entry.link,
          created_at: entry.published.endsWith("Z")
            ? entry.published
            : new Date(entry.published).toISOString().replace(/\.\d+Z$/, "Z"),
          ...(entry.durationSeconds !== undefined
            ? { estimated_time_minutes: Math.ceil(entry.durationSeconds / 60) }
            : {}),
          ...(entry.tags?.length
            ? { tags: entry.tags.map(decodeEntities) }
            : {}),
        });

        const enriched = await enrichContent(entry.link);

        if (enriched.title) enriched.title = decodeEntities(enriched.title);
        if (enriched.description)
          enriched.description = decodeEntities(enriched.description);

        if (enriched.tags || baseContent.tags) {
          const merged = Array.from(
            new Set([...(baseContent.tags ?? []), ...(enriched.tags ?? [])])
          );
          if (merged.length) baseContent.tags = merged.map(decodeEntities);
          delete (enriched as any).tags;
        }

        const content: Content = Content.parse({ ...baseContent, ...enriched });

        const contentDir = path.join(providerDir, "content");
        await fs.mkdir(contentDir, { recursive: true });
        await fs.writeFile(
          path.join(contentDir, `${contentId}.toml`),
          toTOML(content)
        );
      })
    )
  );

  // Write provider metadata -----------------------------------------------
  await fs.mkdir(providerDir, { recursive: true });
  await fs.writeFile(
    path.join(providerDir, "provider.toml"),
    toTOML(providerMeta)
  );
}

// Persist updated cache once all providers processed
await saveCache();

console.log("✅ providers folder refreshed (polite mode enabled)");
