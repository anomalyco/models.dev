#!/usr/bin/env bun
//
// Regenerate the cloudflare-ai-gateway provider model TOMLs from Cloudflare's own sources,
// with human curation reduced to providers/cloudflare-ai-gateway/curation.toml.
//
// Sources of truth (all live):
//   - Proxied models:  GET /accounts/{id}/ai/catalog/models
//       canonical dotted model_id, name, description, context_length, max_output_tokens,
//       and pricing (flat or context-tiered).
//   - Hosted @cf set:  GET /accounts/{id}/ai/models/search   (discovery only: which @cf
//       Text-Generation models exist).
//   - Hosted @cf data: raw.githubusercontent.com/cloudflare/cloudflare-docs/production/
//       src/content/workers-ai-models/<model>.json  (name, description, context_window,
//       price, function_calling, vision, and schema.input from which reasoning_options
//       are derived).
//
// curation.toml holds only what those sources cannot express: hosted base_model mappings,
// structured_output (a quality judgement — Cloudflare advertises response_format broadly but
// several models do not honour it), proxied reasoning_options, proxied limit divergences, and
// a skip list for catalog ids with no lab file.
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//      CF_AIG_FIXTURE_DIR (optional) — read cached catalog*/hosted* JSON and docs/<model>.json
//      instead of the network.
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
const DOCS_BASE =
  "https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models";

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
// natural id (model_id for catalog, name for hosted). Dedup guards against overlapping
// snapshot files inflating or conflicting the model set.
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

async function loadProxiedAndHostedSet() {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir) {
    return {
      proxied: loadFixtureRows(fixtureDir, "catalog"),
      hostedSet: loadFixtureRows(fixtureDir, "hosted"),
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
  const [proxied, hostedSet] = await Promise.all([
    fetchAllPages(`${base}/catalog/models`, token, 50),
    fetchAllPages(`${base}/models/search`, token, 100),
  ]);
  return { proxied, hostedSet };
}

// Load a docs JSON for a hosted @cf model by its last path segment.
async function loadDocs(cfId: string): Promise<any> {
  const segment = cfId.split("/").pop()!;
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir) {
    const p = path.join(fixtureDir, "docs", `${segment}.json`);
    if (!existsSync(p)) throw new Error(`Missing docs fixture for ${cfId} (${p})`);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  const res = await fetchWithRetry(`${DOCS_BASE}/${segment}.json`);
  if (!res.ok) throw new Error(`Docs fetch failed ${res.status} for ${cfId} (${segment}.json)`);
  return res.json();
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
  const tiers = new Map<number, Record<string, number>>();
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
      if (op!.startsWith("<")) base[field] = value; // lower band = base
      else {
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
  return cost;
}

function hostedCost(docs: any): Record<string, number> | undefined {
  const price = (docs.properties ?? []).find((p: any) => p.property_id === "price")?.value;
  if (!Array.isArray(price)) return undefined;
  const cost: Record<string, number> = {};
  for (const row of price) {
    if (row.unit === "per M input tokens") cost.input = row.price;
    else if (row.unit === "per M output tokens") cost.output = row.price;
    else if (row.unit === "per M cached input tokens") cost.cache_read = row.price;
  }
  return Object.keys(cost).length ? cost : undefined;
}

function hostedProp(docs: any, id: string): string | undefined {
  return (docs.properties ?? []).find((p: any) => p.property_id === id)?.value;
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

  const { proxied, hostedSet } = await loadProxiedAndHostedSet();
  const proxiedTextGen = proxied.filter((m) => m.task === TEXT_GENERATION);
  const hostedTextGen = hostedSet.filter((m) => m.task?.name === TEXT_GENERATION);

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

    const limit: Record<string, number> = {};
    if (cur.limit) Object.assign(limit, cur.limit);
    else {
      if (m.context_length != null) limit.context = m.context_length;
      if (m.max_output_tokens != null) limit.output = m.max_output_tokens;
    }
    if (Object.keys(limit).length) model.limit = limit;

    wanted.set(path.join(MODELS_DIR, `${id}.toml`), formatToml(model as any));
  }

  // --- hosted @cf models ---
  const docsList = await mapLimit(hostedTextGen, 6, async (m) => ({
    cfId: m.name as string,
    docs: await loadDocs(m.name),
  }));
  for (const { cfId, docs } of docsList) {
    const id = `workers-ai/${cfId}`;
    if (skip.has(id)) continue;
    // LoRA adapters are fine-tuning scaffolds, not standalone models. Skip unless a
    // curation entry explicitly maps one.
    if (hostedProp(docs, "lora") === "true" && !curation.models[id]) continue;
    const cur = curation.models[id];
    if (!cur?.base_model) {
      errors.push(`hosted ${id}: missing base_model in curation.toml`);
      continue;
    }
    // name/description inherit from base_model; docs only expose the raw @cf id as "name".
    const model: Record<string, unknown> = { base_model: cur.base_model };

    if (hostedProp(docs, "function_calling") === "true") model.tool_call = true;
    if (hostedProp(docs, "vision") === "true") model.attachment = true;
    if (cur.structured_output !== undefined) model.structured_output = cur.structured_output;

    // reasoning_options: only when the base reasons (schema forbids them otherwise). Derived
    // from the docs input schema; curation may override for the rare model whose docs schema
    // does not describe the reasoning knob.
    if (baseReasoning(cur.base_model)) {
      const ro =
        cur.reasoning_options !== undefined
          ? cur.reasoning_options
          : deriveReasoningOptions(docs.schema?.input);
      if (ro.length === 0 && cur.reasoning_options === undefined) {
        errors.push(
          `hosted ${id}: base ${cur.base_model} has reasoning=true but docs schema exposes ` +
          `no reasoning knob (add reasoning_options to curation.toml)`,
        );
        continue;
      }
      model.reasoning_options = ro;
    }

    const cost = hostedCost(docs);
    if (cost) model.cost = cost;

    const context = hostedProp(docs, "context_window");
    if (context != null) model.limit = { context: Number(context) };

    wanted.set(path.join(MODELS_DIR, `workers-ai/${cfId}.toml`), formatToml(model as any));
  }

  // Guards: a curation model id that no longer appears in the live feeds (warn only).
  const liveIds = new Set<string>([
    ...proxiedTextGen.map((m) => m.model_id),
    ...hostedTextGen.map((m) => `workers-ai/${m.name}`),
  ]);
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
    `cloudflare-ai-gateway: ${wanted.size} model(s) ` +
    `(${proxiedTextGen.length} proxied catalog, ${hostedTextGen.length} hosted @cf; ` +
    `${changed} written/removed, ${skip.size} skipped, ${warnings.length} warning(s)).`,
  );
}

await main();
