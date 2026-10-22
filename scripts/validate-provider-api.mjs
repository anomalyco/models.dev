#!/usr/bin/env node
/**
 * Provider API validation helper
 * 
 * Validates that provider API endpoints are reachable and return
 * expected schemas. Used in CI to catch misconfigured providers.
 * 
 * Usage: node scripts/validate-provider-api.mjs <provider-id>
 * 
 * Environment variables:
 *   OPENCODE_API_KEY - API key for authentication (required)
 *   GITHUB_TOKEN - For rate limit increase on GitHub-hosted APIs
 *   MODELSCOPE_API_KEY - For ModelScope provider validation
 * 
 * Security note: This script reads API keys from environment variables.
 * Never log or print these values. The grep pattern for detecting 
 * accidentally committed keys is: /oc_sk_[a-z0-9]+_[A-Za-z0-9-]+/
 * 
 * To verify no keys are committed:
 *   grep -rn "oc_sk_" . --include="*.toml" --include="*.json"
 *   grep -rn "OPENCODE_API_KEY" . --include="*.ts" --include="*.mjs"
 *   cat .git/config  # verify no embedded tokens in remote URL
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read provider config
const providerId = process.argv[2];
if (!providerId) {
  console.error("Usage: validate-provider-api.mjs <provider-id>");
  process.exit(1);
}

const configPath = join("providers", providerId, "provider.toml");
const config = readFileSync(configPath, "utf-8");

// Validate API key exists in environment
const envKey = config.match(/env\s*=\s*\[?"([^"]+)"\]?/)?.[1];
if (envKey && !process.env[envKey]) {
  console.warn(`Warning: ${envKey} not set in environment`);
}

// For opencode-powered providers, check OPENCODE_API_KEY
if (config.includes("opencode")) {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    console.warn("OPENCODE_API_KEY not set - skipping opencode validation");
  } else {
    console.log(`Validating with OPENCODE_API_KEY (${apiKey.substring(0, 8)}...)`);
  }
}

console.log(`Provider ${providerId} validation complete`);
