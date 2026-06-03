#!/usr/bin/env bun

/**
 * Generates Ambient model TOML files from https://api.ambient.xyz/v1/models.
 *
 * Emits `base_model` TOMLs that inherit upstream metadata
 * (family, release_date, knowledge, capabilities) from the canonical
 * provider model, and override only the fields Ambient's API reports:
 * cost, limit, modalities.
 *
 * Flags:
 *   --dry-run  Preview generated TOMLs without writing files.
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const API_ENDPOINT = "https://api.ambient.xyz/v1/models";

// Allowlist for the initial rollout.
const ALLOWLIST = new Set<string>([
  "zai-org/GLM-5.1-FP8",
  "moonshotai/kimi-k2.6",
]);

// Maps Ambient model IDs to canonical model metadata IDs in this repo.
const BASE_MODEL_MAP: Record<string, string> = {
  "zai-org/GLM-5.1-FP8": "zai/glm-5.1",
  "moonshotai/kimi-k2.6": "moonshotai/kimi-k2.6",
};

const Pricing = z
  .object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  })
  .passthrough();

const AmbientModel = z
  .object({
    id: z.string(),
    name: z.string(),
    context_length: z.number(),
    max_output_length: z.number(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    pricing: Pricing,
  })
  .passthrough();

const AmbientResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(AmbientModel),
  })
  .passthrough();

const ALLOWED_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

function modalities(values: string[]): string[] {
  return values
    .map((v) => v.toLowerCase())
    .filter((v) => ALLOWED_MODALITIES.has(v));
}

function perMTok(price: string): number {
  const n = parseFloat(price);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid price: ${price}`);
  }
  // Round to 6 decimals to absorb float noise from per-token strings.
  return Math.round(n * 1_000_000 * 1_000_000) / 1_000_000;
}

function formatToml(
  model: z.infer<typeof AmbientModel>,
  baseModel: string,
): string {
  const lines: string[] = [];
  lines.push(`base_model = "${baseModel}"`);
  lines.push("");

  lines.push("[cost]");
  lines.push(`input = ${perMTok(model.pricing.prompt)}`);
  lines.push(`output = ${perMTok(model.pricing.completion)}`);
  if (model.pricing.input_cache_read !== undefined) {
    lines.push(`cache_read = ${perMTok(model.pricing.input_cache_read)}`);
  }
  if (model.pricing.input_cache_write !== undefined) {
    lines.push(`cache_write = ${perMTok(model.pricing.input_cache_write)}`);
  }
  lines.push("");

  lines.push("[limit]");
  lines.push(`context = ${model.context_length}`);
  lines.push(`output = ${model.max_output_length}`);
  lines.push("");

  const input = modalities(model.input_modalities);
  const output = modalities(model.output_modalities);
  lines.push("[modalities]");
  lines.push(`input = [${input.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${output.map((m) => `"${m}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const outDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "providers",
    "ambient",
    "models",
  );

  const res = await fetch(API_ENDPOINT);
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const parsed = AmbientResponse.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Invalid Ambient response:", parsed.error.issues);
    process.exit(1);
  }

  const selected = parsed.data.data.filter((m) => ALLOWLIST.has(m.id));
  const missing = [...ALLOWLIST].filter(
    (id) => !selected.some((m) => m.id === id),
  );
  if (missing.length > 0) {
    console.error(`Allowlisted models missing from API: ${missing.join(", ")}`);
    process.exit(1);
  }

  let count = 0;
  for (const model of selected) {
    const baseModel = BASE_MODEL_MAP[model.id];
    if (!baseModel) {
      console.error(`No BASE_MODEL_MAP entry for ${model.id}; skipping`);
      continue;
    }
    const filePath = path.join(outDir, `${model.id}.toml`);
    const toml = formatToml(model, baseModel);
    if (dryRun) {
      console.log(`--- ${path.relative(process.cwd(), filePath)} ---`);
      console.log(toml);
    } else {
      await mkdir(path.dirname(filePath), { recursive: true });
      await Bun.write(filePath, toml);
    }
    count++;
  }

  console.log(
    `${dryRun ? "Previewed" : "Wrote"} ${count} model file(s) under providers/ambient/models/`,
  );
}

await main();
