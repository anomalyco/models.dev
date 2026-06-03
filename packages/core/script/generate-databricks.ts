#!/usr/bin/env bun

/**
 * Generates Databricks model TOML files from the Foundation Model API endpoint.
 *
 * Each Databricks endpoint exposes a model from another provider (Anthropic,
 * OpenAI, Google, etc.), so the generated TOML uses base_model to inherit
 * provider-agnostic metadata from models.dev.
 *
 * Usage:
 *   DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run databricks:generate
 *   bun run databricks:generate --workspace <host> --token <pat>
 *
 * Flags:
 *   --dry-run: Preview changes without writing files
 *   --new-only: Only create new models, skip updating existing ones
 */

import { z } from "zod";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const newOnly = args.includes("--new-only");

const host = flag("workspace") ?? process.env.DATABRICKS_HOST;
const token = flag("token") ?? process.env.DATABRICKS_TOKEN;

if (!host || !token) {
  console.error(
    "Usage: DATABRICKS_HOST=<host> DATABRICKS_TOKEN=<pat> bun run databricks:generate",
  );
  process.exit(1);
}

const workspace = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "providers");
const MODELS_DIR = path.join(PROVIDERS_DIR, "databricks", "models");

// ---------------------------------------------------------------------------
// API schemas
// ---------------------------------------------------------------------------

const FoundationModel = z
  .object({
    ai_gateway_v2_supported: z.boolean().optional(),
    api_types: z.array(z.string()).optional(),
  })
  .passthrough();

const ServedEntity = z
  .object({
    foundation_model: FoundationModel.optional(),
  })
  .passthrough();

const Endpoint = z
  .object({
    name: z.string(),
    config: z
      .object({
        served_entities: z.array(ServedEntity).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const FoundationModelsResponse = z
  .object({
    endpoints: z.array(Endpoint),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Canonical resolution: map a Databricks endpoint name to a models.dev entry
// ---------------------------------------------------------------------------

const PREFIX_TO_PROVIDER: [string, string][] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "google"],
  ["mistral-", "mistral"],
  ["mixtral-", "mistral"],
];

type Resolution =
  | { type: "base_model"; from: string }
  | { type: "inline"; content: string }
  | null;

async function resolveCanonical(endpointName: string): Promise<Resolution> {
  const bare = endpointName.replace(/^databricks-/, "");

  // Models in provider subdirectories may not have provider-agnostic metadata
  // yet, so inline when no model-only entry exists.
  if (bare.startsWith("gpt-oss-")) {
    const p = path.join(PROVIDERS_DIR, "openrouter", "models", "openai", `${bare}.toml`);
    if (existsSync(p)) {
      return { type: "inline", content: await readFile(p, "utf8") };
    }
  }

  // Meta Llama: "meta-llama-3-3-70b-instruct" → "llama-3.3-70b-instruct"
  if (bare.startsWith("meta-llama-") || bare.startsWith("llama-")) {
    const llamaId = bare
      .replace(/^meta-llama-/, "llama-")
      .replace(/^(llama-\d+)-(\d+)-/, "$1.$2-");
    const p = path.join(PROVIDERS_DIR, "llama", "models", `${llamaId}.toml`);
    if (existsSync(p)) return { type: "base_model", from: `llama/${llamaId}` };
  }

  for (const [prefix, provider] of PREFIX_TO_PROVIDER) {
    if (!bare.startsWith(prefix)) continue;

    const exact = path.join(PROVIDERS_DIR, provider, "models", `${bare}.toml`);
    if (existsSync(exact)) return { type: "base_model", from: `${provider}/${bare}` };

    // Try with hyphens-as-dots in version (e.g. gpt-5-4 → gpt-5.4)
    const dotted = bare.replace(/^((?:[a-z]+-)+\d+)-(\d)/, "$1.$2");
    if (dotted !== bare) {
      const dottedExact = path.join(PROVIDERS_DIR, provider, "models", `${dotted}.toml`);
      if (existsSync(dottedExact)) return { type: "base_model", from: `${provider}/${dotted}` };
    }

    // Fuzzy: longest filename that shares a prefix with bare or its dotted form
    const candidates = [bare, ...(dotted !== bare ? [dotted] : [])];
    const files: string[] = [];
    try {
      for await (const f of new Bun.Glob("*.toml").scan({
        cwd: path.join(PROVIDERS_DIR, provider, "models"),
      })) {
        files.push(f);
      }
    } catch {
      // provider directory may not exist
    }
    const match = files
      .map((f) => f.replace(/\.toml$/, ""))
      .filter((id) => candidates.some((c) => id.startsWith(c) || c.startsWith(id)))
      .sort((a, b) => b.length - a.length)[0];
    if (match) return { type: "base_model", from: `${provider}/${match}` };
  }

  return null;
}

function formatToml(resolution: Resolution, endpointName: string): string {
  if (resolution?.type === "base_model") {
    return `base_model = "${resolution.from}"\n`;
  }
  if (resolution?.type === "inline") {
    return resolution.content;
  }
  return `# TODO: fill in details for ${endpointName}\nname = "${endpointName}"\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const IGNORE_PREFIXES = [
  "databricks-llama-",
  "databricks-meta-llama-",
  "databricks-qwen",
  "databricks-gemma-",
];

async function main() {
  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching Databricks foundation-models...`,
  );

  const url = `https://${workspace}/api/2.0/serving-endpoints:foundation-models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    console.error(await res.text().catch(() => ""));
    process.exit(1);
  }

  const json = await res.json();
  const parsed = FoundationModelsResponse.safeParse(json);
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const endpoints = parsed.data.endpoints.filter(
    (e) =>
      !IGNORE_PREFIXES.some((p) => e.name.startsWith(p)) &&
      e.config?.served_entities?.some(
        (se) =>
          se.foundation_model?.ai_gateway_v2_supported === true &&
          se.foundation_model?.api_types?.includes("mlflow/v1/chat/completions"),
      ),
  );

  const existingFiles = new Set<string>();
  try {
    for await (const f of new Bun.Glob("*.toml").scan({ cwd: MODELS_DIR })) {
      existingFiles.add(f);
    }
  } catch {
    // directory may not exist yet
  }

  console.log(
    `Found ${endpoints.length} models in API, ${existingFiles.size} existing files\n`,
  );

  const apiModelIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const ep of endpoints) {
    const filename = `${ep.name}.toml`;
    apiModelIds.add(filename);
    const filePath = path.join(MODELS_DIR, filename);

    const resolution = await resolveCanonical(ep.name);
    const newContent = formatToml(resolution, ep.name);
    const tag = resolution?.type === "base_model" ? `base_model ${resolution.from}` : resolution?.type ?? "stub";

    const existed = existsSync(filePath);
    if (!existed) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${filename}  →  ${tag}`);
      } else {
        await mkdir(MODELS_DIR, { recursive: true });
        await Bun.write(filePath, newContent);
        console.log(`Created: ${filename}  →  ${tag}`);
      }
      continue;
    }

    if (newOnly) {
      unchanged++;
      continue;
    }

    const existingContent = await readFile(filePath, "utf8");
    if (existingContent === newContent) {
      unchanged++;
      continue;
    }

    updated++;
    if (dryRun) {
      console.log(`[DRY RUN] Would update: ${filename}  →  ${tag}`);
    } else {
      await Bun.write(filePath, newContent);
      console.log(`Updated: ${filename}  →  ${tag}`);
    }
  }

  const orphaned: string[] = [];
  for (const file of existingFiles) {
    if (!apiModelIds.has(file)) {
      orphaned.push(file);
      console.log(`Warning: Orphaned file (not in API): ${file}`);
    }
  }

  console.log("");
  if (dryRun) {
    console.log(
      `Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  } else {
    console.log(
      `Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned.length} orphaned`,
    );
  }
}

await main();
