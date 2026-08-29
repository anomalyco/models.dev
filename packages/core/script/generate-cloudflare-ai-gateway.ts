#!/usr/bin/env bun
//
// Regenerate the cloudflare-ai-gateway provider model TOMLs from Cloudflare's own sources,
// with human curation reduced to providers/cloudflare-ai-gateway/curation.toml.
//
// Scope: proxied third-party models only (anthropic, openai, google, xai, alibaba, deepseek,
// moonshotai, …). Cloudflare's own Workers AI (@cf/...) models are a different pathway — hosted
// on Cloudflare, CF-token auth, model agreements — and live in their own provider,
// providers/cloudflare-workers-ai, so they are deliberately not mirrored here.
//
// Source of truth (live):
//   - GET /accounts/{id}/ai/catalog/models — canonical dotted model_id, name, description,
//       context_length, max_output_tokens, and pricing (flat or context-tiered).
//
// curation.toml holds only what that source cannot express: structured_output (a quality
// judgement — Cloudflare advertises response_format broadly but several models do not honour
// it), reasoning_options (the catalog has no reasoning schema), limit divergences, and a skip
// list for catalog ids with no lab file (or not reachable via unified billing).
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//      CF_AIG_FIXTURE_DIR (optional) — read cached catalog* JSON instead of the network.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bun run cloudflare-ai-gateway:generate
//   bun run cloudflare-ai-gateway:generate --check     # fail if the tree would change

import path from "node:path";
import { readdirSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { formatToml } from "../src/sync/index.ts";

const PROVIDER_DIR = path.join(
  import.meta.dirname, "..", "..", "..", "providers", "cloudflare-ai-gateway",
);
const MODELS_DIR = path.join(PROVIDER_DIR, "models");
const MODELS_ROOT = path.join(import.meta.dirname, "..", "..", "..", "models");
const CURATION_PATH = path.join(PROVIDER_DIR, "curation.toml");

const TEXT_GENERATION = "Text Generation";

// Proxied providers that Cloudflare fronts with a *native* passthrough route rather than the
// gateway's generic OpenAI-compatible transform: Anthropic keeps the Messages API, OpenAI keeps
// the Responses API. Advertise each model's native SDK so consumers route to the endpoint that
// serves it best instead of falling back to the provider default (ai-gateway-provider). Other
// third-party providers Cloudflare only exposes over the compat route inherit that default.
// https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
// https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
const NATIVE_NPM: Record<string, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
};
function nativeNpm(id: string): string | undefined {
  return NATIVE_NPM[id.split("/")[0]!];
}

// ---------------------------------------------------------------------------
// curation.toml schema
// ---------------------------------------------------------------------------
const ReasoningOption = z.record(z.any());
const CuratedModel = z
  .object({
    base_model: z.string().min(1).optional(),
    structured_output: z.boolean().optional(),
    reasoning_options: z.array(ReasoningOption).optional(),
    limit: z.record(z.number()).optional(),
    interleaved: z
      .union([z.literal(true), z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict()])
      .optional(),
    // Leading `#` comment lines, e.g. a toggle/effort wire-path note (AGENTS.md requires one
    // for every `toggle` reasoning option) or a source citation. Rendered verbatim above the
    // generated fields so hand-verified host behavior survives every regeneration.
    note: z.array(z.string()).optional(),
  })
  .strict();

const Curation = z
  .object({
    skip: z.array(z.string()).default([]),
    models: z.record(CuratedModel).default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Fetch (with fixture fallback)
// ---------------------------------------------------------------------------
async function fetchAllPages(url: string, token: string, perPage: number) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`${url}?page=${page}&per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
    const json: any = await res.json();
    out.push(...(json.result ?? []));
    const total = json.result_info?.total_count ?? out.length;
    if (out.length >= total || (json.result ?? []).length === 0) break;
  }
  return out;
}

// Fetch with retry on 429/5xx. raw.githubusercontent.com rate-limits bursts, so honour
// Retry-After when present and otherwise back off exponentially. Returns the Response;
// callers decide how to treat a final !ok (throw vs. tolerate).
async function fetchWithRetry(url: string, init?: RequestInit, tries = 5): Promise<Response> {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500) || attempt >= tries) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay;
    await new Promise((r) => setTimeout(r, wait));
    delay = Math.min(delay * 2, 8000);
  }
}

// Run async tasks with bounded concurrency to avoid tripping rate limits.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// Load rows from every fixture file whose name starts with prefix, de-duplicated by their
// catalog model_id. Dedup guards against overlapping snapshot files inflating the model set.
function loadFixtureRows(dir: string, prefix: string): any[] {
  const byId = new Map<string, any>();
  for (const f of readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
    for (const row of JSON.parse(readFileSync(path.join(dir, f), "utf8")).result ?? []) {
      const key = row.model_id ?? row.name ?? JSON.stringify(row);
      byId.set(key, row);
    }
  }
  return [...byId.values()];
}

async function loadProxied() {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir) return loadFixtureRows(fixtureDir, "catalog");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (or CF_AIG_FIXTURE_DIR for offline runs).",
    );
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai`;
  return fetchAllPages(`${base}/catalog/models`, token, 50);
}

// Load the per-model catalog schema for a proxied model. The list endpoint omits `schema`;
// the single-model schema endpoint returns schema.input, from which reasoning_options are
// derivable for OpenAI-compatible providers (xai, alibaba, openai). Providers whose schema
// is their native shape (google, anthropic, deepseek, moonshotai) return no reasoning
// property — those fall back to curation.toml. Returns schema.input or undefined.
async function loadCatalogSchemaInput(id: string): Promise<unknown> {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir) {
    const p = path.join(fixtureDir, "schema", `${id.replace(/\//g, "_")}.json`);
    if (!existsSync(p)) return undefined; // schema is optional per-model
    return JSON.parse(readFileSync(p, "utf8")).result?.schema?.input;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN!;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const res = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/catalog/models/${id}/schema`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return undefined; // treat missing schema as "not derivable"
  return ((await res.json()) as any).result?.schema?.input;
}

// Read the `reasoning` flag from a base lab file (models/<base>.toml). A base model that
// declares reasoning=true MUST carry reasoning_options in the provider file (schema validates
// this), so we hard-fail when neither the catalog schema nor curation can supply them.
function baseReasoning(base: string): boolean {
  const p = path.join(MODELS_ROOT, `${base}.toml`);
  if (!existsSync(p)) return false;
  return (Bun.TOML.parse(readFileSync(p, "utf8")) as any).reasoning === true;
}

// ---------------------------------------------------------------------------
// Pricing → cost
// ---------------------------------------------------------------------------
const FLAT_KEYS: Record<string, string> = {
  "Input tokens (per 1M)": "input",
  "Output tokens (per 1M)": "output",
  "Cached input tokens (per 1M)": "cache_read",
  "Cache creation tokens (per 1M)": "cache_write",
};
const TIER_RE = /^(Input|Output|Cached input)\s*(<=?|>=?)\s*(\d+)k\s*\(per 1M\)$/;
const TIER_FIELD: Record<string, string> = {
  Input: "input",
  Output: "output",
  "Cached input": "cache_read",
};

function proxiedCost(pricing: Record<string, number>, id: string, warnings: string[]) {
  const base: Record<string, number> = {};
  for (const [key, value] of Object.entries(pricing)) {
    if (FLAT_KEYS[key]) {
      base[FLAT_KEYS[key]] = value;
      continue;
    }
    const m = key.match(TIER_RE);
    if (m) {
      const [, label, op] = m;
      const field = TIER_FIELD[label!]!;
      // Cloudflare AI Gateway entries don't carry tiered pricing (unsupported here). Fold the
      // lower/default-context band (op "<") into the flat rate and drop the higher-context bands.
      if (op!.startsWith("<")) base[field] = value;
      continue;
    }
    warnings.push(`${id}: unmapped pricing key "${key}"`);
  }
  return { ...base };
}

// Derive reasoning_options from a docs schema.input by walking every named property.
function deriveReasoningOptions(schemaInput: unknown): Array<Record<string, unknown>> {
  let hasToggle = false;
  let effortValues: string[] | undefined;

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
          if (propName === "enable_thinking" || propName === "thinking") hasToggle = true;
          if (propName === "effort" || propName === "reasoning_effort") {
            let enumVals: string[] | undefined = propSchema?.enum;
            if (!enumVals) {
              for (const branch of [...(propSchema?.anyOf ?? []), ...(propSchema?.oneOf ?? [])]) {
                if (Array.isArray(branch?.enum)) enumVals = branch.enum;
              }
            }
            if (enumVals) effortValues = enumVals;
          }
          visit(propSchema);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(schemaInput);

  const opts: Array<Record<string, unknown>> = [];
  if (hasToggle) opts.push({ type: "toggle" });
  if (effortValues) opts.push({ type: "effort", values: effortValues });
  return opts;
}

// Prepend curated leading `#` comment lines (a toggle/effort wire-path note, a source
// citation, etc.) above the generated content. AGENTS.md requires one for every `toggle`
// reasoning option since sync strips mid-file comments on every regeneration.
function withNote(note: string[] | undefined, content: string): string {
  if (!note || note.length === 0) return content;
  return `${note.map((line) => `# ${line}`).join("\n")}\n\n${content}`;
}

// ---------------------------------------------------------------------------
// base_model resolution
// ---------------------------------------------------------------------------
function labFileExists(id: string): boolean {
  return existsSync(path.join(MODELS_ROOT, `${id}.toml`));
}
function autoResolveBase(catalogId: string): string | null {
  if (labFileExists(catalogId)) return catalogId;
  const dashed = catalogId.replace(/\./g, "-");
  if (labFileExists(dashed)) return dashed;
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function walkToml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? walkToml(p) : p.endsWith(".toml") ? [p] : [];
  });
}

async function main() {
  const check = process.argv.includes("--check");

  const parsed = Curation.safeParse(Bun.TOML.parse(readFileSync(CURATION_PATH, "utf8")));
  if (!parsed.success) {
    console.error("Invalid curation.toml:", parsed.error.issues);
    process.exit(1);
  }
  const curation = parsed.data;
  const skip = new Set(curation.skip);
  const errors: string[] = [];
  const warnings: string[] = [];

  const proxied = await loadProxied();
  const proxiedTextGen = proxied.filter((m) => m.task === TEXT_GENERATION);

  const wanted = new Map<string, string>(); // absolute path -> content

  // Fetch per-model schemas up front for the proxied models we'll actually emit, with bounded
  // concurrency so the catalog/docs endpoints don't rate-limit us.
  const proxiedEmit = proxiedTextGen.filter((m) => !skip.has(m.model_id));
  const schemaInputs = new Map<string, unknown>();
  await mapLimit(proxiedEmit, 6, async (m) => {
    schemaInputs.set(m.model_id, await loadCatalogSchemaInput(m.model_id));
  });

  // --- proxied models ---
  for (const m of proxiedTextGen) {
    const id: string = m.model_id;
    if (skip.has(id)) continue;
    const cur = curation.models[id] ?? {};
    const base = cur.base_model ?? autoResolveBase(id);
    if (!base) {
      errors.push(`proxied ${id}: no lab file and no curation base_model (add to skip or map it)`);
      continue;
    }
    // name/description are inherited from base_model (models.dev's canonical copy);
    // the catalog only carries Cloudflare's own casing/marketing variants.
    const model: Record<string, unknown> = { base_model: base };
    if (cur.structured_output !== undefined) model.structured_output = cur.structured_output;
    if (cur.interleaved !== undefined) model.interleaved = cur.interleaved;

    // reasoning_options: only meaningful when the base actually reasons. The catalog schema
    // advertises reasoning_effort for some non-reasoning models (gpt-4.1, gpt-4o) — schema
    // acceptance is not capability, so gate on the base's reasoning flag. When the base does
    // reason, prefer the per-model catalog schema, then curation, and fail loudly if neither
    // supplies a shape (the schema requires reasoning_options whenever reasoning=true).
    if (baseReasoning(base)) {
      const derivedRo = deriveReasoningOptions(schemaInputs.get(id));
      if (cur.reasoning_options !== undefined) model.reasoning_options = cur.reasoning_options;
      else if (derivedRo.length > 0) model.reasoning_options = derivedRo;
      else {
        errors.push(
          `proxied ${id}: base ${base} has reasoning=true but no reasoning_options ` +
          `(catalog schema exposes none; add reasoning_options to curation.toml)`,
        );
        continue;
      }
    }

    const cost = proxiedCost(m.pricing ?? {}, id, warnings);
    if (Object.keys(cost).length === 0) errors.push(`proxied ${id}: catalog pricing empty`);
    model.cost = cost;

    // limit.output: the catalog's max_output_tokens is not a reliable ceiling — verified wrong
    // against lab/first-party for gpt-5, gpt-5.5, and claude-haiku-4.5 (all understated by
    // 4-8x). Only context_length has checked out, so that's all we auto-derive; output is
    // either curated explicitly or left to inherit from base_model.
    const limit: Record<string, number> = {};
    if (m.context_length != null) limit.context = m.context_length;
    if (cur.limit) Object.assign(limit, cur.limit); // curation overrides/adds (e.g. served output)
    if (Object.keys(limit).length) model.limit = limit;

    const npm = nativeNpm(id);
    if (npm) model.provider = { npm };

    wanted.set(path.join(MODELS_DIR, `${id}.toml`), withNote(cur.note, formatToml(model as any)));
  }

  // Guards: a curation model id that no longer appears in the live feed (warn only).
  const liveIds = new Set<string>(proxiedTextGen.map((m) => m.model_id));
  for (const id of Object.keys(curation.models)) {
    if (!liveIds.has(id)) warnings.push(`curation id not in live feed: ${id}`);
  }

  if (errors.length > 0) {
    console.error("Errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);

  const existing = new Set(walkToml(MODELS_DIR));
  const wantedPaths = new Set(wanted.keys());
  const toRemove = [...existing].filter((p) => !wantedPaths.has(p));

  if (check) {
    let changed = 0;
    for (const [p, content] of wanted) {
      const cur = existing.has(p) ? readFileSync(p, "utf8") : undefined;
      if (cur !== content) { console.error(`would change: ${path.relative(MODELS_DIR, p)}`); changed++; }
    }
    for (const p of toRemove) { console.error(`would remove: ${path.relative(MODELS_DIR, p)}`); changed++; }
    if (changed > 0) { console.error(`--check: ${changed} file(s) out of date`); process.exit(1); }
    console.log("--check: up to date");
    return;
  }

  let changed = 0;
  for (const [p, content] of wanted) {
    const cur = existing.has(p) ? readFileSync(p, "utf8") : undefined;
    if (cur !== content) { await Bun.write(p, content); changed++; }
  }
  for (const p of toRemove) { rmSync(p); changed++; }

  console.log(
    `cloudflare-ai-gateway: ${wanted.size} proxied model(s) ` +
    `(${changed} written/removed, ${skip.size} skipped, ${warnings.length} warning(s)).`,
  );
}

await main();
