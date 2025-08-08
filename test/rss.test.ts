import { describe, expect, test } from "bun:test";

const USER_AGENT = "merln/rss-bot (+https://natepapes.com)";

function parseRobotsTxt(robotsTxt: string): string[] {
  const ourAgent = USER_AGENT.split("/")[0] || "merln";

  const specificDisallow: string[] = [];
  const globalDisallow: string[] = [];

  let currentAgent = "";
  let inOurAgent = false;
  let inGlobal = false;
  let foundOurAgent = false;
  let foundGlobalAgent = false;

  for (const line of robotsTxt.split("\n")) {
    const trimmed = line.trim();

    // Check for User-agent directive
    const userAgentMatch = trimmed.match(/^user-agent:\s*(.+)$/i);
    if (userAgentMatch && userAgentMatch[1]) {
      currentAgent = userAgentMatch[1].toLowerCase();
      inOurAgent =
        currentAgent === ourAgent.toLowerCase() ||
        currentAgent === USER_AGENT.toLowerCase();
      inGlobal = currentAgent === "*";

      if (inOurAgent) foundOurAgent = true;
      if (inGlobal) foundGlobalAgent = true;
    }
    // Process Disallow rules
    else if (/^disallow:/i.test(trimmed)) {
      const parts = trimmed.split(":");
      if (parts.length > 1 && parts[1] !== undefined) {
        const path = parts[1].trim();
        // Only add non-empty disallow rules (empty means "allow everything")
        if (path !== "") {
          if (inOurAgent) {
            specificDisallow.push(path);
          } else if (inGlobal) {
            globalDisallow.push(path);
          }
        }
      }
    }
  }

  // Use specific rules if we found our agent, otherwise fall back to global rules if found
  if (foundOurAgent) {
    return specificDisallow;
  } else if (foundGlobalAgent) {
    return globalDisallow;
  } else {
    return []; // No applicable rules found
  }
}

function isPathAllowed(robotsTxt: string, targetPath: string): boolean {
  const disallowRules = parseRobotsTxt(robotsTxt);
  return disallowRules.every((rule) => !targetPath.startsWith(rule));
}

describe("Robots.txt Parser", () => {
  describe("parseRobotsTxt", () => {
    test("should use global rules when no specific rules exist", () => {
      const robotsTxt = `User-agent: *
Disallow: /admin/
Disallow: /private/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/admin/", "/private/"]);
    });

    test("should prioritize specific rules for our agent over global rules", () => {
      const robotsTxt = `User-agent: *
Disallow: /admin/

User-agent: merln
Disallow: /api/
Disallow: /secret/

User-agent: Googlebot
Disallow: /temp/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/api/", "/secret/"]);
    });

    test("should match full USER_AGENT string", () => {
      const robotsTxt = `User-agent: *
Disallow: /admin/

User-agent: merln/rss-bot (+https://natepapes.com)
Disallow: /special/

User-agent: Googlebot
Disallow: /temp/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/special/"]);
    });

    test("should fall back to global rules when no specific rules for our agent", () => {
      const robotsTxt = `User-agent: Googlebot
Disallow: /google-only/

User-agent: *
Disallow: /admin/
Disallow: /private/

User-agent: Bingbot
Disallow: /bing-only/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/admin/", "/private/"]);
    });

    test("should return empty array when no rules apply", () => {
      const robotsTxt = `User-agent: Googlebot
Disallow: /google-only/

User-agent: Bingbot
Disallow: /bing-only/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual([]);
    });

    test("should handle case-insensitive user-agent matching", () => {
      const robotsTxt = `User-agent: *
Disallow: /admin/

User-agent: MERLN
Disallow: /case-test/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/case-test/"]);
    });

    test("should handle empty disallow rules correctly", () => {
      const robotsTxt = `User-agent: merln
Disallow:

User-agent: *
Disallow: /admin/`;

      const rules = parseRobotsTxt(robotsTxt);
      // Empty disallow means "allow all" for that specific agent
      // Since we found a specific agent but no valid disallow rules, we should allow everything
      expect(rules).toEqual([]);
    });

    test("should handle AtomicObject robots.txt format", () => {
      const robotsTxt = `Crawl-delay: 10
# START YOAST BLOCK
# ---------------------------
User-agent: *
Disallow:

Sitemap: https://spin.atomicobject.com/sitemap_index.xml
# ---------------------------
# END YOAST BLOCK`;

      const rules = parseRobotsTxt(robotsTxt);
      // Empty disallow for * means allow everything
      expect(rules).toEqual([]);
    });
  });

  describe("isPathAllowed", () => {
    const robotsTxt = `User-agent: *
Disallow: /admin/
Disallow: /private/

User-agent: merln
Disallow: /api/
Disallow: /secret/`;

    test("should disallow paths that match specific rules", () => {
      expect(isPathAllowed(robotsTxt, "/api/users")).toBe(false);
      expect(isPathAllowed(robotsTxt, "/secret/config")).toBe(false);
    });

    test("should allow paths that don't match any rules", () => {
      expect(isPathAllowed(robotsTxt, "/public/info")).toBe(true);
      expect(isPathAllowed(robotsTxt, "/blog/post")).toBe(true);
    });

    test("should allow paths that match global rules but not specific rules", () => {
      // Global rules disallow /admin/, but our specific rules don't
      expect(isPathAllowed(robotsTxt, "/admin/panel")).toBe(true);
      expect(isPathAllowed(robotsTxt, "/private/data")).toBe(true);
    });

    test("should handle exact path matches", () => {
      expect(isPathAllowed(robotsTxt, "/api")).toBe(true); // doesn't start with /api/
      expect(isPathAllowed(robotsTxt, "/api/")).toBe(false); // exact match
    });
  });

  describe("Edge Cases", () => {
    test("should handle malformed robots.txt", () => {
      const robotsTxt = `Some random text
User-agent
Disallow without colon
User-agent: *
Disallow: /admin/`;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual(["/admin/"]);
    });

    test("should handle robots.txt with only whitespace", () => {
      const robotsTxt = `   
      
      `;

      const rules = parseRobotsTxt(robotsTxt);
      expect(rules).toEqual([]);
    });

    test("should handle multiple user-agent blocks", () => {
      const robotsTxt = `User-agent: merln
Disallow: /first/

User-agent: *
Disallow: /global/

User-agent: merln
Disallow: /second/`;

      const rules = parseRobotsTxt(robotsTxt);
      // Should collect all rules for our agent
      expect(rules).toEqual(["/first/", "/second/"]);
    });
  });
});
