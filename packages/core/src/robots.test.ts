import { isPathAllowed, parseRobots } from "@merln/core/src/robots.ts";
import { describe, expect, test } from "bun:test";

const USER_AGENT = "merln/rss (+https://natepapes.com)";

describe("RFC 9309 robots matcher", () => {
  test("longest match (RFC example) and allow precedence", () => {
    const robots = `User-Agent: merln
Allow: /example/page/
Disallow: /example/page/disallowed.gif`;

    expect(isPathAllowed(robots, "/example/page/ok", USER_AGENT)).toBe(true);
    expect(
      isPathAllowed(robots, "/example/page/disallowed.gif", USER_AGENT)
    ).toBe(false);
  });

  test("empty Disallow means allow all for that agent", () => {
    const robots = `User-agent: merln\nDisallow:`;
    expect(isPathAllowed(robots, "/anything", USER_AGENT)).toBe(true);
  });

  test("fallback to global rules when no specific group", () => {
    const robots = `User-agent: Googlebot\nDisallow: /google-only/\n\nUser-agent: *\nDisallow: /admin/`;
    const { rules } = parseRobots(robots, USER_AGENT);
    expect(rules.length).toBe(1);
    expect(isPathAllowed(robots, "/admin/panel", USER_AGENT)).toBe(false);
    expect(isPathAllowed(robots, "/public", USER_AGENT)).toBe(true);
  });

  test("wildcard * and end-anchor $", () => {
    const robots = `User-Agent: *\nDisallow: *.gif$\nAllow: /publications/`;
    expect(isPathAllowed(robots, "/img/pic.gif", USER_AGENT)).toBe(false);
    expect(isPathAllowed(robots, "/img/pic.gifv", USER_AGENT)).toBe(true);
    expect(isPathAllowed(robots, "/publications/x", USER_AGENT)).toBe(true);
  });

  test("match by full UA string if provided", () => {
    const robots = `User-agent: ${USER_AGENT}\nDisallow: /special/`;
    expect(isPathAllowed(robots, "/special/x", USER_AGENT)).toBe(false);
  });
});

describe("Provider robots policies", () => {
  const youtubeRobots = `# robots.txt file for YouTube
User-agent: Mediapartners-Google*
Disallow:

User-agent: *
Disallow: /api/
Disallow: /comment
Disallow: /feeds/videos.xml
Disallow: /file_download
Disallow: /get_video
Disallow: /get_video_info
Disallow: /get_midroll_info
Disallow: /live_chat
Disallow: /login
Disallow: /qr
Disallow: /results
Disallow: /signup
Disallow: /t/terms
Disallow: /timedtext_video
Disallow: /verify_age
Disallow: /watch_ajax
Disallow: /watch_fragments_ajax
Disallow: /watch_popup
Disallow: /watch_queue_ajax
Disallow: /youtubei/
`;

  const githubRobots = `User-agent: *
Disallow: /*/*/commits/
Disallow: /*/raw/
Disallow: /gist/
Disallow: /search$
Disallow: /*.atom$`;

  const atomicRobots = `Crawl-delay: 10
User-agent: *
Disallow:
Sitemap: https://spin.atomicobject.com/sitemap_index.xml`;

  test("YouTube: typical video page allowed; certain APIs disallowed", () => {
    expect(isPathAllowed(youtubeRobots, "/watch?v=abc", USER_AGENT)).toBe(true);
    expect(isPathAllowed(youtubeRobots, "/feeds/videos.xml", USER_AGENT)).toBe(
      false
    );
    expect(
      isPathAllowed(youtubeRobots, "/youtubei/v1/browse", USER_AGENT)
    ).toBe(false);
  });

  test("GitHub: block raw, commits list, gist path, and anchored search", () => {
    expect(isPathAllowed(githubRobots, "/org/repo/commits/", USER_AGENT)).toBe(
      false
    );
    expect(isPathAllowed(githubRobots, "/foo/raw/", USER_AGENT)).toBe(false);
    expect(isPathAllowed(githubRobots, "/gist/", USER_AGENT)).toBe(false);
    expect(isPathAllowed(githubRobots, "/search", USER_AGENT)).toBe(false);
    expect(isPathAllowed(githubRobots, "/papes1ns", USER_AGENT)).toBe(true);
  });

  test("Atomic Object: allow all for *", () => {
    expect(isPathAllowed(atomicRobots, "/anything", USER_AGENT)).toBe(true);
  });
});
