/**
 * RFC 9309-compliant robots.txt parsing and path matching utilities.
 * Reference: https://www.rfc-editor.org/rfc/rfc9309.html
 */

export type RobotsRule = {
  type: "allow" | "disallow";
  pattern: string;
  regex: RegExp;
  length: number; // used for longest-match precedence
};

export type ParsedRobots = {
  rules: RobotsRule[];
};

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(pattern: string): { regex: RegExp; length: number } {
  let anchorToEnd = false;
  let raw = pattern.trim();

  if (raw.endsWith("$")) {
    anchorToEnd = true;
    raw = raw.slice(0, -1);
  }

  // Convert path-pattern to regex: wildcards (*) match any char seq.
  // We also match from the beginning of the path, and optionally anchor to end.
  const escaped = escapeRegexLiteral(raw).replace(/\*/g, ".*");
  const source = `^${escaped}${anchorToEnd ? "$" : ""}`;
  const regex = new RegExp(source);

  // For precedence, RFC uses longest match; we approximate by pattern length
  // excluding a trailing '$' if present.
  const length = raw.length;
  return { regex, length };
}

function normalizeUserAgentToken(userAgent: string): string {
  // Extract a product token from a full UA string (e.g. "merln/rss(...)" -> "merln").
  const token = (userAgent.split("/")[0] || userAgent).trim();
  return token;
}

/**
 * Parse robots.txt and return rules relevant to the provided userAgent.
 *
 * Group selection rules implemented:
 * - Accumulate rules for any group where User-agent matches our product token
 *   (case-insensitive) or the full UA string. If none match specifically,
 *   fall back to the groups with User-agent: *.
 * - If neither specific nor global groups exist, there are no applicable rules.
 *
 * Rule semantics:
 * - Support Allow and Disallow (case-insensitive).
 * - Empty Disallow means allow everything (ignored as a rule).
 * - Patterns support '*' wildcard and '$' end-anchor per common practice and RFC 9309.
 */
export function parseRobots(
  robotsTxt: string,
  userAgent: string
): ParsedRobots {
  const lines = robotsTxt.split(/\r?\n/);

  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let currentGroup: Group | null = null;

  const ourToken = normalizeUserAgentToken(userAgent).toLowerCase();
  const ourFull = userAgent.toLowerCase();

  for (const rawLine of lines) {
    const lineWithoutComment = (() => {
      const hashIndex = rawLine.indexOf("#");
      return (hashIndex >= 0 ? rawLine.slice(0, hashIndex) : rawLine).trim();
    })();
    if (!lineWithoutComment) continue;

    const uaMatch = lineWithoutComment.match(/^user-agent\s*:\s*(.+)$/i);
    if (uaMatch) {
      const token = (uaMatch[1] ?? "").trim();
      if (!token) continue;
      // If we already started a group AND it has rules, this UA starts a new group.
      if (!currentGroup || currentGroup.rules.length > 0) {
        currentGroup = { agents: [], rules: [] };
        groups.push(currentGroup);
      }
      currentGroup.agents.push(token);
      continue;
    }

    // A rule must follow at least one user-agent line; otherwise skip
    if (!currentGroup) continue;

    const allowMatch = lineWithoutComment.match(/^allow\s*:\s*(.*)$/i);
    if (allowMatch) {
      const pattern = (allowMatch[1] ?? "").trim();
      if (!pattern) continue;
      const { regex, length } = compilePattern(pattern);
      currentGroup.rules.push({ type: "allow", pattern, regex, length });
      continue;
    }

    const disallowMatch = lineWithoutComment.match(/^disallow\s*:\s*(.*)$/i);
    if (disallowMatch) {
      const pattern = (disallowMatch[1] ?? "").trim();
      // Empty Disallow means allow all → ignore as a rule
      if (!pattern) continue;
      const { regex, length } = compilePattern(pattern);
      currentGroup.rules.push({ type: "disallow", pattern, regex, length });
      continue;
    }

    // Ignore other directives (Sitemap, Crawl-delay, etc.)
  }

  const specificRules: RobotsRule[] = [];
  const globalRules: RobotsRule[] = [];

  for (const g of groups) {
    const agents = g.agents.map((a) => a.toLowerCase());
    const isGlobal = agents.includes("*");
    const isSpecific = agents.some((a) => a === ourToken || a === ourFull);

    if (isSpecific) specificRules.push(...g.rules);
    else if (isGlobal) globalRules.push(...g.rules);
  }

  if (specificRules.length) return { rules: specificRules };
  if (globalRules.length) return { rules: globalRules };
  return { rules: [] };
}

/**
 * Determine if a given path (including optional query string) is allowed.
 * Implements longest-match precedence: select the matching rule with the
 * greatest length; on ties, an Allow rule wins.
 */
export function isPathAllowed(
  robotsTxt: string,
  pathWithQuery: string,
  userAgent: string
): boolean {
  const { rules } = parseRobots(robotsTxt, userAgent);
  if (!rules.length) return true;

  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (rule.regex.test(pathWithQuery)) {
      if (!best) best = rule;
      else if (rule.length > best.length) best = rule;
      else if (rule.length === best.length && rule.type === "allow")
        best = rule;
    }
  }

  if (!best) return true;
  return best.type === "allow";
}
