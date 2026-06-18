#!/usr/bin/env bun

/**
 * Syncs deAPI model entries against the live deAPI model catalog.
 *
 * deAPI exposes an OpenAI-compatible endpoint (`GET /v1/models`) that lists the
 * served model IDs but no per-model metadata (no pricing, context window or
 * modalities). This script therefore reconciles the *set* of models: it
 * scaffolds a stub TOML for any model served by the API but missing locally,
 * and warns about local files that the API no longer serves. Provider-specific
 * metadata (modalities, limits, pricing, dates) is curated by hand because the
 * API does not provide it.
 *
 * Usage:
 *   DEAPI_API_KEY=<key> bun run deapi:generate
 *   bun run deapi:generate --token <key> --base-url https://oai.deapi.ai/v1
 *
 * Flags:
 *   --dry-run:   Preview changes without writing files
 *   --new-only:  Only create stubs for new models (never touch existing files)
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const newOnly = args.includes("--new-only");

const token = flag("token") ?? process.env.DEAPI_API_KEY;
const baseUrl = (
  flag("base-url") ??
  process.env.DEAPI_BASE_URL ??
  "https://oai.deapi.ai/v1"
).replace(/\/$/, "");

if (!token) {
  console.error("Usage: DEAPI_API_KEY=<key> bun run deapi:generate");
  process.exit(1);
}

const MODELS_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "providers",
  "deapi",
  "models",
);

// ---------------------------------------------------------------------------
// API schema
// ---------------------------------------------------------------------------

const ModelsResponse = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
});

// The deAPI catalog only exposes model IDs, so a new entry starts as a stub
// that a maintainer fills in by hand (matches the repo's existing convention).
function stubToml(id: string): string {
  return `# TODO: fill in details for ${id}\nname = "${id}"\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `${dryRun ? "[DRY RUN] " : ""}${newOnly ? "[NEW ONLY] " : ""}Fetching deAPI models from ${baseUrl}/models...`,
  );

  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    console.error(await res.text().catch(() => ""));
    process.exit(1);
  }

  const parsed = ModelsResponse.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModelIds = parsed.data.data.map((m) => m.id);

  const existingFiles = new Set<string>();
  try {
    for await (const f of new Bun.Glob("*.toml").scan({ cwd: MODELS_DIR })) {
      existingFiles.add(f);
    }
  } catch {
    // directory may not exist yet
  }

  console.log(
    `Found ${apiModelIds.length} models in API, ${existingFiles.size} existing files\n`,
  );

  const apiFiles = new Set<string>();
  let created = 0;
  let unchanged = 0;

  for (const id of apiModelIds) {
    const filename = `${id}.toml`;
    apiFiles.add(filename);
    const filePath = path.join(MODELS_DIR, filename);

    if (existsSync(filePath)) {
      unchanged++;
      continue;
    }

    created++;
    if (dryRun) {
      console.log(`[DRY RUN] Would create stub: ${filename}`);
    } else {
      await mkdir(MODELS_DIR, { recursive: true });
      await Bun.write(filePath, stubToml(id));
      console.log(`Created stub: ${filename}  (fill in metadata by hand)`);
    }
  }

  const orphaned: string[] = [];
  if (!newOnly) {
    for (const file of existingFiles) {
      if (!apiFiles.has(file)) {
        orphaned.push(file);
        console.log(`Warning: Orphaned file (not served by API): ${file}`);
      }
    }
  }

  console.log("");
  console.log(
    `Summary: ${created}${dryRun ? " would be" : ""} created, ${unchanged} unchanged, ${orphaned.length} orphaned`,
  );
}

await main();
