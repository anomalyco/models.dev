#!/usr/bin/env bun

/*
 * A tighter license-audit helper that:
 *   1. Runs license-checker in JSON mode (production deps only).
 *   2. Fails the script (exit 1) if any package’s license isn’t in the allow-list.
 *
 * The allow-list can be overridden via the ALLOWED_LICENSES env var
 * (semicolon-delimited SPDX identifiers).
 */

import { $ } from "bun";

const DEFAULT_ALLOW = [
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "UNKNOWN",
  "UNLICENSED",
];

const allowList = new Set(
  (process.env.ALLOWED_LICENSES ?? DEFAULT_ALLOW.join(";")).split(/\s*;\s*/)
);

const { stdout } = await $`bunx license-checker --json --production`;
const jsonStr = stdout.toString();
interface LicenseInfo {
  licenses: string | string[];
}

const parsed: Record<string, LicenseInfo> = JSON.parse(jsonStr);

const violations: Array<{ pkg: string; license: string | string[] }> = [];

for (const [pkg, info] of Object.entries(parsed)) {
  const licArray = Array.isArray(info.licenses)
    ? info.licenses
    : [info.licenses];
  const bad = licArray.filter((l) => !allowList.has(l));
  if (bad.length) violations.push({ pkg, license: bad.join(", ") });
}

if (violations.length) {
  console.error("\n🚫 Disallowed licenses found:\n");
  for (const v of violations) {
    console.error(`  • ${v.pkg}  →  ${v.license}`);
  }
  console.error("\n✖ License audit failed\n");
  process.exit(1);
}

console.log("✅ License audit passed");
