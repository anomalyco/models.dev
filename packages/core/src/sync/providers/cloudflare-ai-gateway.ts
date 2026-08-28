import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedBaseModel } from "../index.js";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PROVIDER_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "providers",
  "cloudflare-ai-gateway",
);
const MODELS_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "models");
const CURATION_PATH = path.join(PROVIDER_DIR, "curation.toml");
const TEXT_GENERATION = "Text Generation";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CATALOG_PAGES = 1_000;
const MAX_BACKOFF_DELAY_MS = 8_000;
const MAX_RETRY_DELAY_MS = 60_000;

const NATIVE_NPM: Record<string, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
};

const CatalogEntry = z.object({
  model_id: z.string().refine(isSafeModelID, "model_id must be a safe relative provider/model path"),
  task: z.string(),
  context_length: z.number().int().positive().nullish(),
  pricing: z.record(z.number().nonnegative()).nullish(),
}).passthrough();
const CatalogModel = CatalogEntry.extend({
  task: z.literal(TEXT_GENERATION),
  context_length: z.number().int().positive().nullish(),
  pricing: z.record(z.number().nonnegative()),
});

const CloudflareResponse = z.object({
  success: z.literal(true),
  result: z.array(CatalogEntry),
  result_info: z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total_count: z.number().int().nonnegative(),
    total_pages: z.number().int().positive().optional(),
    count: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

const SourceModel = z.object({
  catalog: CatalogModel,
  schemaInput: z.unknown().optional(),
});

const CuratedModel = z.object({
  base_model: z.string().refine(isSafeModelID, "base_model must be a safe relative provider/model path").optional(),
  structured_output: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOption).optional(),
  limit: z.object({
    context: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  }).strict().optional(),
  interleaved: z.union([
    z.literal(true),
    z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
  ]).optional(),
  note: z.array(z.string().refine((value) => !/[\r\n]/.test(value))).optional(),
}).strict();

const Curation = z.object({
  skip: z.array(z.string()).default([]),
  models: z.record(CuratedModel).default({}),
}).strict();

type CatalogModel = z.infer<typeof CatalogModel>;
type CatalogEntry = z.infer<typeof CatalogEntry>;
type SourceModel = z.infer<typeof SourceModel>;
type CuratedModel = z.infer<typeof CuratedModel>;

const curation = Curation.parse(Bun.TOML.parse(readFileSync(CURATION_PATH, "utf8")));
const skippedModels = new Set(curation.skip);

export const cloudflareAiGateway = {
  id: "cloudflare-ai-gateway",
  name: "Cloudflare AI Gateway",
  modelsDir: "providers/cloudflare-ai-gateway/models",
  preserveDescriptions: false,
  authoritativeHeaders: true,
  async fetchModels() {
    const catalog = CatalogEntry.array().parse(await loadCatalog());
    const catalogIDs = new Set(catalog.map((model) => model.model_id));
    if (catalogIDs.size !== catalog.length) {
      throw new Error("Cloudflare AI Gateway catalog returned duplicate model IDs");
    }
    const textModels = catalog.filter((model) => model.task === TEXT_GENERATION);
    if (textModels.length === 0) {
      throw new Error("Cloudflare AI Gateway catalog returned no Text Generation models");
    }

    const emittedModels = textModels.filter(
      (model) => !model.model_id.startsWith("@cf/") && !skippedModels.has(model.model_id),
    ).map((model) => CatalogModel.parse(model));
    if (emittedModels.length === 0) {
      throw new Error("Cloudflare AI Gateway catalog returned no eligible proxied models");
    }
    const sources = await mapLimit(emittedModels, 6, async (model) => ({
      catalog: model,
      schemaInput: await loadCatalogSchemaInput(model.model_id),
    }));

    const liveIDs = new Set(textModels.map((model) => model.model_id));
    for (const id of Object.keys(curation.models)) {
      if (!liveIDs.has(id)) console.warn(`warning: curation id not in live feed: ${id}`);
    }

    return sources;
  },
  parseModels(raw) {
    return SourceModel.array().parse(raw);
  },
  translateModel(source, context) {
    const id = source.catalog.model_id;
    const curated = curation.models[id] ?? {};
    return {
      id,
      model: buildCloudflareAiGatewayModel(
        source.catalog,
        source.schemaInput,
        curated,
        context.authored(id),
      ),
      header: noteHeader(curated.note),
    };
  },
} satisfies SyncProvider<SourceModel>;

export function buildCloudflareAiGatewayModel(
  catalog: CatalogModel,
  schemaInput: unknown,
  curated: CuratedModel = {},
  existing?: ExistingModel,
): SyncedBaseModel {
  const id = catalog.model_id;
  const baseModel = curated.base_model ?? resolveBaseModel(id);
  if (baseModel === undefined) {
    throw new Error(`${id}: no lab file and no curated base_model; add it to skip or map it`);
  }

  const model: SyncedBaseModel = { base_model: baseModel };
  if (curated.structured_output !== undefined) {
    model.structured_output = curated.structured_output;
  }
  if (curated.interleaved !== undefined) model.interleaved = curated.interleaved;

  if (baseReasoning(baseModel)) {
    const derived = deriveReasoningOptions(schemaInput);
    const reasoningOptions = curated.reasoning_options ?? (derived.length > 0 ? derived : undefined);
    if (reasoningOptions === undefined) {
      throw new Error(
        `${id}: base ${baseModel} reasons but the catalog schema and curation provide no reasoning_options`,
      );
    }
    model.reasoning_options = reasoningOptions;
  }

  model.cost = proxiedCost(catalog.pricing, id);

  const limit = {
    ...(catalog.context_length == null && existing?.limit?.context === undefined
      ? {}
      : { context: catalog.context_length ?? existing?.limit?.context }),
    ...curated.limit,
  };
  if (Object.keys(limit).length > 0) model.limit = limit;

  const npm = NATIVE_NPM[id.split("/")[0]!];
  if (npm !== undefined) model.provider = { npm };
  return model;
}

export function deriveReasoningOptions(
  schemaInput: unknown,
): NonNullable<SyncedBaseModel["reasoning_options"]> {
  let hasToggle = false;
  let effortValues: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default">
    | undefined;

  const EffortValues = z.array(z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "default",
  ]));

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (key !== "properties" || value === null || typeof value !== "object") {
        visit(value);
        continue;
      }

      for (const [property, rawSchema] of Object.entries(value)) {
        const propertySchema = rawSchema as Record<string, unknown>;
        if (property === "enable_thinking" || property === "thinking") hasToggle = true;
        if (property === "effort" || property === "reasoning_effort") {
          const candidates = [propertySchema, ...arrayValue(propertySchema.anyOf), ...arrayValue(propertySchema.oneOf)];
          for (const candidate of candidates) {
            const parsed = EffortValues.safeParse(candidate.enum);
            if (parsed.success) effortValues = parsed.data;
          }
        }
        visit(rawSchema);
      }
    }
  };
  visit(schemaInput);

  const options: NonNullable<SyncedBaseModel["reasoning_options"]> = [];
  if (hasToggle) options.push({ type: "toggle" });
  if (effortValues !== undefined) options.push({ type: "effort", values: effortValues });
  return options;
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [];
}

async function loadCatalog() {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir !== undefined) return loadFixtureRows(fixtureDir, "catalog");

  const { accountID, token } = credentials();
  const pages: Array<z.infer<typeof CloudflareResponse>> = [];
  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    const url = new URL(`${API_BASE}/${accountID}/ai/catalog/models`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const { response, json } = await fetchJsonWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`Cloudflare AI Gateway catalog request failed: ${response.status} ${response.statusText}`);
    }
    const body = CloudflareResponse.parse(json);
    pages.push(body);
    const expectedPages = catalogPageCount(pages[0]!);
    if (expectedPages > MAX_CATALOG_PAGES) throw new Error(`Invalid Cloudflare AI Gateway catalog page count: ${expectedPages}`);
    if (page === expectedPages) return validateCatalogPages(pages, "Cloudflare AI Gateway catalog");
  }
  throw new Error("Cloudflare AI Gateway catalog exceeded the pagination safety limit");
}

async function loadCatalogSchemaInput(id: string): Promise<unknown> {
  const fixtureDir = process.env.CF_AIG_FIXTURE_DIR;
  if (fixtureDir !== undefined) {
    const file = path.join(fixtureDir, "schema", `${id.replaceAll("/", "_")}.json`);
    if (!existsSync(file)) return undefined;
    return z.object({
      success: z.literal(true),
      result: z.object({ schema: z.object({ input: z.unknown().optional() }).passthrough() }).passthrough(),
    }).passthrough().parse(JSON.parse(readFileSync(file, "utf8"))).result.schema.input;
  }

  const { accountID, token } = credentials();
  const { response, json } = await fetchJsonWithRetry(
    `${API_BASE}/${accountID}/ai/catalog/models/${id.split("/").map(encodeURIComponent).join("/")}/schema`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Cloudflare AI Gateway schema request failed for ${id}: ${response.status} ${response.statusText}`);
  }
  return z.object({
    success: z.literal(true),
    result: z.object({ schema: z.object({ input: z.unknown().optional() }).passthrough() }).passthrough(),
  }).passthrough().parse(json).result.schema.input;
}

function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN
    ?? process.env.CLOUDFLARE_PRODUCTION_API_TOKEN;
  const accountID = process.env.CLOUDFLARE_ACCOUNT_ID
    ?? process.env.CLOUDFLARE_PRODUCTION_ACCOUNT_ID_AI_GATEWAY_SANDBOX;
  if (!token || !accountID) {
    throw new Error(
      "Cloudflare AI Gateway sync requires Cloudflare API token and account ID credentials",
    );
  }
  return { accountID, token };
}

function loadFixtureRows(directory: string, prefix: string): unknown[] {
  const pages = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((file) => CloudflareResponse.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8"))))
    .sort((a, b) => a.result_info.page - b.result_info.page);
  return validateCatalogPages(pages, `Cloudflare AI Gateway fixtures in ${directory}`);
}

function catalogPageCount(page: z.infer<typeof CloudflareResponse>) {
  const calculated = Math.max(1, Math.ceil(page.result_info.total_count / page.result_info.per_page));
  if (page.result_info.total_pages !== undefined && page.result_info.total_pages !== calculated) {
    throw new Error("Invalid Cloudflare AI Gateway catalog pagination: total_pages does not match total_count");
  }
  return page.result_info.total_pages ?? calculated;
}

function validateCatalogPages(pages: Array<z.infer<typeof CloudflareResponse>>, source: string) {
  const first = pages[0];
  if (first === undefined) throw new Error(`${source} contained no pages`);
  const expectedPages = catalogPageCount(first);
  if (pages.length !== expectedPages) {
    throw new Error(`${source} contains ${pages.length}/${expectedPages} pages`);
  }

  const models: CatalogEntry[] = [];
  const ids = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (page.result_info.page !== index + 1) {
      throw new Error(`${source} expected page ${index + 1}, got ${page.result_info.page}`);
    }
    if (
      page.result_info.total_count !== first.result_info.total_count
      || page.result_info.per_page !== first.result_info.per_page
      || catalogPageCount(page) !== expectedPages
    ) {
      throw new Error(`${source} pagination changed while reading pages`);
    }
    if (page.result_info.count !== undefined && page.result_info.count !== page.result.length) {
      throw new Error(`${source} result count mismatch on page ${page.result_info.page}`);
    }
    if (page.result.length > page.result_info.per_page) {
      throw new Error(`${source} page ${page.result_info.page} exceeds per_page`);
    }
    for (const model of page.result) {
      if (ids.has(model.model_id)) throw new Error(`${source} returned duplicate model ID ${model.model_id}`);
      ids.add(model.model_id);
      models.push(model);
    }
  }
  if (models.length !== first.result_info.total_count) {
    throw new Error(`${source} pagination ended at ${models.length}/${first.result_info.total_count}`);
  }
  return models;
}

async function fetchJsonWithRetry(
  url: string | URL,
  init: RequestInit,
  attempts = 5,
): Promise<{ response: Response; json?: unknown }> {
  let delay = 500;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
          await response.body?.cancel();
          await waitForRetry(retryDelay(response, delay), init.signal);
          delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
          continue;
        }
        await response.body?.cancel();
        return { response };
      }
      try {
        return { response, json: await response.json() };
      } catch (error) {
        if (attempt === attempts) throw error;
      }
    } catch (error) {
      if (init.signal?.aborted || attempt === attempts) throw error;
    }
    await waitForRetry(delay, init.signal);
    delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
  }
  throw new Error("Cloudflare AI Gateway request exhausted retries");
}

function retryDelay(response: Response, fallback: number) {
  const value = response.headers.get("retry-after");
  if (value === null) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_DELAY_MS)
    : fallback;
}

function waitForRetry(delay: number, signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function mapLimit<T, R>(items: T[], limit: number, transform: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await transform(items[index]!);
    }
  }));
  return results;
}

const FLAT_PRICING_KEYS: Record<string, "input" | "output" | "cache_read" | "cache_write"> = {
  "Input tokens (per 1M)": "input",
  "Output tokens (per 1M)": "output",
  "Cached input tokens (per 1M)": "cache_read",
  "Cache creation tokens (per 1M)": "cache_write",
};
const TIERED_PRICING_KEY = /^(Input|Output|Cached input)\s*(<=?|>=?)\s*(\d+)k\s*\(per 1M\)$/;
const TIERED_PRICING_FIELDS = {
  Input: "input",
  Output: "output",
  "Cached input": "cache_read",
} as const;

function proxiedCost(pricing: Record<string, number>, id: string): NonNullable<SyncedBaseModel["cost"]> {
  const cost: NonNullable<SyncedBaseModel["cost"]> = {};
  for (const [key, value] of Object.entries(pricing)) {
    const flatField = FLAT_PRICING_KEYS[key];
    if (flatField !== undefined) {
      cost[flatField] = value;
      continue;
    }
    const tier = TIERED_PRICING_KEY.exec(key);
    if (tier !== null) {
      const field = TIERED_PRICING_FIELDS[tier[1] as keyof typeof TIERED_PRICING_FIELDS];
      if (tier[2]!.startsWith("<")) cost[field] = value;
      continue;
    }
    throw new Error(`${id}: unmapped pricing key "${key}"`);
  }
  if (cost.input === undefined || cost.output === undefined) {
    throw new Error(`${id}: catalog pricing must include input and output rates`);
  }
  return cost;
}

function isSafeModelID(id: string) {
  if (path.isAbsolute(id) || id.includes("\\")) return false;
  const segments = id.split("/");
  return segments.length >= 2
    && segments.every((segment) => /^[A-Za-z0-9@._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function resolveBaseModel(id: string) {
  if (labFileExists(id)) return id;
  const dashed = id.replaceAll(".", "-");
  return labFileExists(dashed) ? dashed : undefined;
}

function labFileExists(id: string) {
  return existsSync(path.join(MODELS_ROOT, `${id}.toml`));
}

function baseReasoning(id: string) {
  const file = path.join(MODELS_ROOT, `${id}.toml`);
  return existsSync(file) && z.object({ reasoning: z.boolean().optional() }).passthrough()
    .parse(Bun.TOML.parse(readFileSync(file, "utf8"))).reasoning === true;
}

function noteHeader(note: string[] | undefined) {
  return note === undefined || note.length === 0
    ? undefined
    : `${note.map((line) => `# ${line}`).join("\n")}\n`;
}
