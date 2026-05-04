#!/usr/bin/env bun

/**
 * Fetches Databricks ai_gateway_v2 endpoints and generates TOML files
 * under providers/databricks/models/.
 *
 * Usage:
 *   DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run generate-databricks.ts
 *   bun run generate-databricks.ts --workspace <host> --token <pat> [--dump]
 */

import path from "node:path";
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : undefined; };
const DUMP = args.includes("--dump");

const host = flag("workspace") ?? process.env.DATABRICKS_HOST;
const token = flag("token") ?? process.env.DATABRICKS_TOKEN;

if (!host || !token) {
  console.error("Usage: DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run generate-databricks.ts");
  process.exit(1);
}

const workspace = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..");

// ---------------------------------------------------------------------------
// Canonical lookup
// ---------------------------------------------------------------------------

const PREFIX_TO_PROVIDER: [string, string][] = [
  ["claude-",   "anthropic"],
  ["gpt-",      "openai"],
  ["gemini-",   "google"],
  ["mistral-",  "mistral"],
  ["mixtral-",  "mistral"],
];

async function findCanonical(endpointName: string): Promise<string | null> {
  let bare = endpointName.replace(/^databricks-/, "");

  // GPT OSS: extend from openrouter
  if (bare.startsWith("gpt-oss-")) {
    const p = path.join(PROVIDERS_DIR, "openrouter", "models", "openai", `${bare}.toml`);
    if (existsSync(p)) return `openrouter/openai/${bare}`;
  }

  // Meta Llama: "meta-llama-3-3-70b-instruct" → "llama-3.3-70b-instruct"
  if (bare.startsWith("meta-llama-") || bare.startsWith("llama-")) {
    const llamaId = bare
      .replace(/^meta-llama-/, "llama-")
      .replace(/^(llama-\d+)-(\d+)-/, "$1.$2-");
    const p = path.join(PROVIDERS_DIR, "llama", "models", `${llamaId}.toml`);
    if (existsSync(p)) return `llama/${llamaId}`;
  }

  for (const [prefix, provider] of PREFIX_TO_PROVIDER) {
    if (!bare.startsWith(prefix)) continue;
    const exact = path.join(PROVIDERS_DIR, provider, "models", `${bare}.toml`);
    if (existsSync(exact)) return `${provider}/${bare}`;
    // Also try with hyphens-as-dots for version numbers (e.g. gpt-5-4 → gpt-5.4)
    const dotted = bare.replace(/^((?:[a-z]+-)+\d+)-(\d)/, "$1.$2");
    if (dotted !== bare) {
      const dottedExact = path.join(PROVIDERS_DIR, provider, "models", `${dotted}.toml`);
      if (existsSync(dottedExact)) return `${provider}/${dotted}`;
    }
    // Fuzzy: find longest filename that shares a prefix with bare or its dotted form
    const files = await readdir(path.join(PROVIDERS_DIR, provider, "models")).catch(() => []);
    const candidates = [bare, ...(dotted !== bare ? [dotted] : [])];
    const match = files
      .filter(f => f.endsWith(".toml"))
      .map(f => f.replace(/\.toml$/, ""))
      .filter(id => candidates.some(c => id.startsWith(c) || c.startsWith(id)))
      .sort((a, b) => b.length - a.length)[0];
    if (match) return `${provider}/${match}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const url = `https://${workspace}/api/2.0/serving-endpoints:foundation-models`;
console.log(`Fetching: ${url}`);

const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(await res.text().catch(() => ""));
  process.exit(1);
}

const json = await res.json() as { endpoints: Array<{ name: string; tags?: { key: string; value: string }[]; config?: { served_entities?: Array<{ foundation_model?: { ai_gateway_v2_supported?: boolean; api_types?: string[] } }> } }> };

if (DUMP) { console.log(JSON.stringify(json, null, 2)); process.exit(0); }

const IGNORE_PREFIXES = ["databricks-llama-", "databricks-meta-llama-", "databricks-qwen", "databricks-gemma-"];

const endpoints = json.endpoints.filter(e =>
  !IGNORE_PREFIXES.some(p => e.name.startsWith(p)) &&
  e.config?.served_entities?.some((se: any) =>
    se.foundation_model?.ai_gateway_v2_supported === true &&
    se.foundation_model?.api_types?.includes("mlflow/v1/chat/completions")
  )
);
console.log(`${endpoints.length} ai_gateway_v2 endpoint(s)`);

const outDir = path.join(PROVIDERS_DIR, "databricks", "models");
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) {
  if (f.endsWith(".toml")) await rm(path.join(outDir, f), { force: true });
}

let extended = 0, stubbed = 0;
for (const ep of endpoints) {
  const canonical = await findCanonical(ep.name);
  const toml = canonical
    ? `[extends]\nfrom = "${canonical}"\n`
    : `# TODO: fill in details for ${ep.name}\nname = "${ep.name}"\n`;
  await writeFile(path.join(outDir, `${ep.name}.toml`), toml, "utf8");
  console.log(`  ${ep.name}  →  ${canonical ?? "stub"}`);
  if (canonical) extended++; else stubbed++;
}

console.log(`\nWrote ${endpoints.length} file(s): ${extended} with extends, ${stubbed} stubs`);
