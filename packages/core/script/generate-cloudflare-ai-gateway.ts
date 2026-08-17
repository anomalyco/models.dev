#!/usr/bin/env bun
//
// Regenerate the cloudflare-ai-gateway provider model TOMLs from Cloudflare's canonical
// catalog, using providers/cloudflare-ai-gateway/overrides.toml as the sole human-curation
// layer. Single command; replaces the legacy 01/02/03 bash pipeline.
//
// Sources of truth:
//   - Proxied catalog:  GET /accounts/{id}/ai/catalog/models   (canonical dotted model_id + pricing)
//   - Hosted (@cf/*):   GET /accounts/{id}/ai/models/search    (name @cf/..., properties[].price)
// overrides.toml supplies base_model targets + every field the catalog cannot express.
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//      CF_AIG_FIXTURE_DIR (optional) — read cached catalog*/hosted* JSON instead of the network.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bun run cloudflare-ai-gateway:generate
//   bun run cloudflare-ai-gateway:generate --check     # fail if the tree would change

import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { z } from "zod";
import { formatToml } from "../src/sync/index.ts";

const PROVIDER_DIR = path.join(
  import.meta.dirname, "..", "..", "..", "providers", "cloudflare-ai-gateway",
);
const MODELS_DIR = path.join(PROVIDER_DIR, "models");
const OVERRIDES_PATH = path.join(PROVIDER_DIR, "overrides.toml");

const TEXT_GENERATION = "Text Generation";

// ---------------------------------------------------------------------------
// overrides.toml schema
// ---------------------------------------------------------------------------
const Override = z
  .object({
    base_model: z.string().min(1),
    cost_source: z.enum(["catalog", "manual"]),
    base_model_omit: z.array(z.string()).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    release_date: z.string().optional(),
    last_updated: z.string().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    attachment: z.boolean().optional(),
    reasoning_options: z.array(z.any()).optional(),
    interleaved: z.any().optional(),
    limit: z.any().optional(),
    modalities: z.any().optional(),
    provider: z.any().optional(),
    cost: z.any().optional(),
  })
  .strict();

const Overrides = z
  .object({
    skip: z.array(z.string()).default([]),
    models: z.record(Override),
  })
  .strict();

// ---------------------------------------------------------------------------
// Cloudflare API fetch (with fixture fallback)
// ---------------------------------------------------------------------------
async function fetchAllPages(url: string, token: string, perPage: number) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`${url}?page=${page}&per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
    }
    const json: any = await res.json();
    out.push(...(json.result ?? []));
    const total = json.result_info?.total_count ?? out.length;
    if (out.length >= total || (json.result ?? []).length === 0) break;
  }
  return out;
}

function loadFixture(dir: string, prefix: string): any[] {
  const out: any[] = [];
  for (const f of readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
    const j = JSON.parse(require("node:fs").readFileSync(path.join(dir, f), "utf8"));
    out.push(...(j.result ?? []));
  }
  return out;
}

async function loadCatalogAndHosted() {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir) {
    return {
      proxied: loadFixture(fixtureDir, "catalog"),
      hosted: loadFixture(fixtureDir, "hosted"),
    };
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (or CF_AIG_FIXTURE_DIR for offline runs).",
    );
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai`;
  const [proxied, hosted] = await Promise.all([
    fetchAllPages(`${base}/catalog/models`, token, 50),
    fetchAllPages(`${base}/models/search`, token, 100),
  ]);
  return { proxied, hosted };
}

// ---------------------------------------------------------------------------
// Pricing → schema cost
// ---------------------------------------------------------------------------
const FLAT_KEYS: Record<string, string> = {
  "Input tokens (per 1M)": "input",
  "Output tokens (per 1M)": "output",
  "Cached input tokens (per 1M)": "cache_read",
  "Cache creation tokens (per 1M)": "cache_write",
};
// tiered: "Input <=200k (per 1M)" / "Input >200k (per 1M)" etc.
const TIER_RE = /^(Input|Output|Cached input)\s*(<=?|>=?)\s*(\d+)k\s*\(per 1M\)$/;
const TIER_FIELD: Record<string, string> = {
  Input: "input",
  Output: "output",
  "Cached input": "cache_read",
};

function proxiedCost(pricing: Record<string, number>, id: string) {
  const base: Record<string, number> = {};
  const tiers = new Map<number, Record<string, number>>();
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(pricing)) {
    if (FLAT_KEYS[key]) {
      base[FLAT_KEYS[key]] = value;
      continue;
    }
    const m = key.match(TIER_RE);
    if (m) {
      const [, label, op, sizeK] = m;
      const size = Number(sizeK) * 1000;
      const field = TIER_FIELD[label!]!;
      if (op!.startsWith("<")) {
        base[field] = value; // base band = lower context
      } else {
        const t = tiers.get(size) ?? {};
        t[field] = value;
        tiers.set(size, t);
      }
      continue;
    }
    warnings.push(`${id}: unmapped pricing key "${key}"`);
  }
  const cost: Record<string, unknown> = { ...base };
  if (tiers.size > 0) {
    cost.tiers = [...tiers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([size, band]) => ({ tier: { type: "context", size }, ...band }));
  }
  return { cost, warnings };
}

function hostedPrice(properties: any[]): Record<string, number> | undefined {
  const price = properties?.find((p) => p.property_id === "price")?.value;
  if (!Array.isArray(price)) return undefined;
  const cost: Record<string, number> = {};
  for (const row of price) {
    if (row.unit === "per M input tokens") cost.input = row.price;
    else if (row.unit === "per M output tokens") cost.output = row.price;
  }
  return Object.keys(cost).length ? cost : undefined;
}

// ---------------------------------------------------------------------------
// Build one model object for formatToml
// ---------------------------------------------------------------------------
function buildModel(
  id: string,
  ov: z.infer<typeof Override>,
  proxiedById: Map<string, any>,
  hostedByName: Map<string, any>,
  errors: string[],
  warnings: string[],
) {
  const model: Record<string, unknown> = { base_model: ov.base_model };
  if (ov.base_model_omit) model.base_model_omit = ov.base_model_omit;
  for (const k of ["name", "description", "release_date", "last_updated", "status",
                   "structured_output", "temperature", "tool_call", "attachment"] as const) {
    if (ov[k] !== undefined) model[k] = ov[k];
  }
  if (ov.reasoning_options !== undefined) model.reasoning_options = ov.reasoning_options;
  if (ov.interleaved !== undefined) model.interleaved = ov.interleaved;

  // cost
  if (ov.cost_source === "manual") {
    if (ov.cost === undefined) {
      errors.push(`${id}: cost_source="manual" but no [cost] in overrides`);
    } else {
      model.cost = ov.cost;
    }
  } else {
    // catalog
    const proxied = proxiedById.get(id);
    if (proxied) {
      const { cost, warnings: w } = proxiedCost(proxied.pricing ?? {}, id);
      warnings.push(...w);
      if (Object.keys(cost).length === 0) {
        errors.push(`${id}: cost_source="catalog" but catalog pricing is empty`);
      }
      model.cost = cost;
    } else {
      const hosted = hostedByName.get(id.replace(/^workers-ai\//, ""));
      const cost = hosted ? hostedPrice(hosted.properties) : undefined;
      if (!cost) {
        errors.push(`${id}: cost_source="catalog" but id not found in catalog or hosted feed`);
      } else {
        model.cost = cost;
      }
    }
  }

  if (ov.limit !== undefined) model.limit = ov.limit;
  if (ov.modalities !== undefined) model.modalities = ov.modalities;
  if (ov.provider !== undefined) model.provider = ov.provider;
  return model;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function walkToml(dir: string): string[] {
  if (!require("node:fs").existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? walkToml(p) : p.endsWith(".toml") ? [p] : [];
  });
}

async function main() {
  const check = process.argv.includes("--check");

  const overridesRaw = Bun.TOML.parse(
    require("node:fs").readFileSync(OVERRIDES_PATH, "utf8"),
  );
  const parsed = Overrides.safeParse(overridesRaw);
  if (!parsed.success) {
    console.error("Invalid overrides.toml:", parsed.error.issues);
    process.exit(1);
  }
  const overrides = parsed.data;

  const { proxied, hosted } = await loadCatalogAndHosted();
  const proxiedById = new Map(proxied.map((m) => [m.model_id, m]));
  const hostedByName = new Map(hosted.map((m) => [m.name, m]));

  // Inclusion set: proxied Text Generation + hosted @cf Text Generation
  const catalogTextGen = new Set<string>();
  for (const m of proxied) if (m.task === TEXT_GENERATION) catalogTextGen.add(m.model_id);
  for (const m of hosted) {
    if (m.task?.name === TEXT_GENERATION) catalogTextGen.add(`workers-ai/${m.name}`);
  }

  const skip = new Set(overrides.skip);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Hard-fail: a Text-Generation catalog model that is neither mapped nor skipped.
  for (const id of catalogTextGen) {
    if (!overrides.models[id] && !skip.has(id)) {
      errors.push(`Unmapped catalog Text-Generation model: ${id} (add to [models] or skip)`);
    }
  }
  // Warn: an override id absent from the live catalog (possible delisting).
  for (const id of Object.keys(overrides.models)) {
    if (!catalogTextGen.has(id)) warnings.push(`override id not in live catalog: ${id}`);
  }

  // Build files
  const wanted = new Map<string, string>(); // absolute path -> content
  for (const [id, ov] of Object.entries(overrides.models)) {
    const model = buildModel(id, ov, proxiedById, hostedByName, errors, warnings);
    const content = formatToml(model as any);
    wanted.set(path.join(MODELS_DIR, `${id}.toml`), content);
  }

  if (errors.length > 0) {
    console.error("Errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);

  // Determine current on-disk generator-owned files
  const existing = new Set(walkToml(MODELS_DIR));
  const wantedPaths = new Set(wanted.keys());

  let changed = 0;
  const toRemove = [...existing].filter((p) => !wantedPaths.has(p));

  if (check) {
    // report-only
    for (const [p, content] of wanted) {
      const cur = existing.has(p)
        ? require("node:fs").readFileSync(p, "utf8")
        : undefined;
      if (cur !== content) { console.error(`would change: ${path.relative(MODELS_DIR, p)}`); changed++; }
    }
    for (const p of toRemove) { console.error(`would remove: ${path.relative(MODELS_DIR, p)}`); changed++; }
    if (changed > 0) { console.error(`--check: ${changed} file(s) out of date`); process.exit(1); }
    console.log("--check: up to date");
    return;
  }

  for (const [p, content] of wanted) {
    const cur = existing.has(p) ? require("node:fs").readFileSync(p, "utf8") : undefined;
    if (cur !== content) { await Bun.write(p, content); changed++; }
  }
  for (const p of toRemove) { require("node:fs").rmSync(p); changed++; }

  console.log(
    `cloudflare-ai-gateway: ${wanted.size} model(s) (${changed} written/removed, ` +
    `${skip.size} skipped, ${warnings.length} warning(s)).`,
  );
}

await main();
