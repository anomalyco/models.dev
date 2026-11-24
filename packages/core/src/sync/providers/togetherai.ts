import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// /v1/models states each model's live serverless price (USD per 1M tokens), cached-input price and
// served context window. It can't say which models are serverless: it also lists dedicated-only and
// retired models, many still with their old prices (e.g. zai-org/GLM-5.1, retired 2026-07-10). So
// the serverless chat table in the docs decides which models are in the catalog, and the scheduled
// deprecations table decides which are deprecated.
const MODELS_ENDPOINT = "https://api.together.xyz/v1/models";
export const SERVERLESS_DOC = "https://docs.together.ai/docs/serverless-models.md";
export const DEPRECATIONS_DOC = "https://docs.together.ai/docs/deprecations.md";

// The chat table has listed 25 to 30 models; far fewer means the page changed shape.
const MIN_SERVERLESS_CHAT_MODELS = 10;

const Price = z.number().finite().nonnegative();

export const TogetherModel = z.object({
  id: z.string().min(1),
  type: z.string(),
  context_length: z.number().int().nonnegative().nullish(),
  pricing: z.object({
    input: Price.nullish(),
    output: Price.nullish(),
    cached_input: Price.nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const TogetherResponse = z.array(TogetherModel);

export type TogetherModel = z.infer<typeof TogetherModel>;

export interface ServerlessRow {
  toolCalling: boolean;
  structuredOutput: boolean;
}

export interface TogetherSource {
  id: string;
  /** The /v1/models row. Absent when the docs list a serverless model the API doesn't. */
  api?: TogetherModel;
  /** Listed in the docs' serverless chat table. */
  serverless?: ServerlessRow;
  /** Listed in the docs' scheduled deprecations table. */
  deprecated: boolean;
}

export interface TogetherRaw {
  models: unknown;
  serverless: string;
  deprecations: string;
}

const skipReasons = new Map<string, string>();
const missingIDs = new Set<string>();

export const togetherai = {
  id: "togetherai",
  name: "Together AI",
  modelsDir: "providers/togetherai/models",
  // Only serverless models are reported when skipped; the API's other chat rows are not offered.
  sourceID(model) {
    return model.serverless === undefined ? undefined : model.id;
  },
  missingModelID(model) {
    return missingIDs.has(model.id) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Together AI serverless models were not created:`,
      ...ids.map((id) => `\`${id}\`: ${skipReasons.get(id) ?? "skipped"}`),
    ];
  },
  async fetchModels(): Promise<TogetherRaw> {
    return fetchTogether(process.env.TOGETHER_API_KEY);
  },
  parseModels(raw) {
    return parseTogether(raw as TogetherRaw);
  },
  translateModel(model, context) {
    const id = model.id;
    const existing = context.existing(id);

    // Off the serverless table: retired, or a dedicated-only model. A model Together has scheduled for
    // removal keeps its file (marked deprecated) while it's still listed.
    if (model.serverless === undefined && !(model.deprecated && existing !== undefined)) return undefined;

    if (model.api === undefined) {
      const v2 = context.v2?.(id);
      if (v2 === undefined) return skip(id, "on the docs page but not in /v1/models, so there is no price to write");
      console.warn(`Together AI: ${id} is on the docs page but not in /v1/models; its file is kept as is`);
      return { id, v2 };
    }

    const input = model.api.pricing?.input;
    const output = model.api.pricing?.output;
    if (input == null || output == null) {
      if (existing === undefined) return skip(id, "/v1/models lists no token price");
      throw new Error(`Together AI model ${id} has no token price in /v1/models`);
    }

    if (existing !== undefined) {
      const built = buildTogetherModel(model, existing);
      // The v1 view reduces MIME types to generic kinds, so a hand-authored format list can match the lab's and be
      // factored away; keep the file's own modalities so the patch leaves its formats alone.
      const modalities = context.authored(id)?.modalities;
      return {
        id,
        model: modalities === undefined ? built : { ...built, modalities } as SyncedModel,
        v2Set: cacheV2Set(model, context.v2?.(id)),
      };
    }

    const baseModel = resolveTogetherBaseModel(id);
    if (baseModel === undefined) {
      missingIDs.add(id);
      return skip(id, "no `models/` lab file matches this ID; add one, then the host file");
    }
    if (modelMetadata(baseModel).reasoning === true) {
      throw new MissingReasoningOptionsError(
        id,
        `Together AI lists no reasoning controls; probe this route and author capabilities.reasoning before creating it (lab file ${baseModel})`,
      );
    }
    return {
      id,
      model: buildTogetherModel(model, { base_model: baseModel }, true),
      v2Set: cacheV2Set(model, undefined),
    };
  },
} satisfies SyncProvider<TogetherSource>;

export async function fetchTogether(key: string | undefined, fetcher: typeof fetch = fetch): Promise<TogetherRaw> {
  if (!key) throw new Error("TOGETHER_API_KEY is required to sync Together AI");
  const [models, serverless, deprecations] = await Promise.all([
    fetcher(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } }).then((response) => {
      if (!response.ok) throw new Error(`Together AI models request failed: ${response.status} ${response.statusText}`);
      return response.json();
    }),
    fetchText(SERVERLESS_DOC, fetcher),
    fetchText(DEPRECATIONS_DOC, fetcher),
  ]);
  return { models, serverless, deprecations };
}

async function fetchText(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Together AI docs request failed: ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

export function parseTogether(raw: TogetherRaw): TogetherSource[] {
  const models = TogetherResponse.parse(raw.models);
  if (models.length === 0) throw new Error("Together AI /v1/models returned no models; refusing to sync");
  const byID = new Map<string, TogetherModel>();
  for (const model of models) {
    if (byID.has(model.id)) throw new Error(`Together AI /v1/models lists ${model.id} twice`);
    byID.set(model.id, model);
  }

  const serverless = parseServerlessChatTable(raw.serverless);
  const deprecated = parseScheduledDeprecations(raw.deprecations);

  const sources: TogetherSource[] = [];
  for (const model of models) {
    if (model.type !== "chat") continue;
    sources.push({ id: model.id, api: model, serverless: serverless.get(model.id), deprecated: deprecated.has(model.id) });
  }
  for (const [id, row] of serverless) {
    if (byID.get(id)?.type === "chat") continue;
    sources.push({ id, serverless: row, deprecated: deprecated.has(id) });
  }
  return sources;
}

// The "Chat models" table on https://docs.together.ai/docs/serverless-models.md, keyed by its
// "API model string" column.
export function parseServerlessChatTable(markdown: string) {
  const rows = tableRows(section(markdown, "Chat models"), "API model string");
  if (rows === undefined) throw new Error(`Together AI: no chat table with an "API model string" column in ${SERVERLESS_DOC}`);
  const result = new Map<string, ServerlessRow>();
  for (const row of rows) {
    const id = row["API model string"]?.replaceAll("`", "").trim();
    if (!id) continue;
    if (result.has(id)) throw new Error(`Together AI: ${id} is listed twice in the serverless chat table`);
    result.set(id, {
      toolCalling: /^yes$/i.test(row["Function calling"] ?? ""),
      structuredOutput: /^yes$/i.test(row["Structured outputs"] ?? ""),
    });
  }
  if (result.size < MIN_SERVERLESS_CHAT_MODELS) {
    throw new Error(`Together AI: the serverless chat table lists only ${result.size} models; refusing to sync`);
  }
  return result;
}

// The "Scheduled deprecations" table on https://docs.together.ai/docs/deprecations.md. An empty
// table is valid; a missing one is not.
export function parseScheduledDeprecations(markdown: string) {
  const rows = tableRows(section(markdown, "Scheduled deprecations"), "Model");
  if (rows === undefined) throw new Error(`Together AI: no scheduled deprecations table in ${DEPRECATIONS_DOC}`);
  return new Set(rows.map((row) => row.Model?.replaceAll("`", "").trim()).filter((id): id is string => Boolean(id)));
}

function section(markdown: string, heading: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

// The first table in the lines whose header has the column, as one record per row.
function tableRows(lines: string[], column: string) {
  const start = lines.findIndex((line) => line.trim().startsWith("|") && cells(line).includes(column));
  if (start === -1) return undefined;
  const header = cells(lines[start]!);
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const values = cells(line);
    rows.push(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
  }
  return rows;
}

function cells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

// Prices, the cached-input price and the context window come from /v1/models; status from the
// deprecations page. Everything else in the file is hand-authored and kept.
export function buildTogetherModel(model: TogetherSource, existing: ExistingModel, created = false): SyncedModel {
  const api = model.api!;
  const { base_model: baseModel, base_model_omit: baseModelOmit, ...current } = existing;
  const cached = api.pricing?.cached_input;
  const cost = {
    ...current.cost,
    input: round(api.pricing!.input!),
    output: round(api.pricing!.output!),
    // A model without a cached-input price bills cached tokens at the full input price.
    cache_read: cached == null ? undefined : round(cached),
  };
  // A context of 0 or null means the row doesn't state one.
  const context = api.context_length ? api.context_length : current.limit?.context;
  const limit = { ...current.limit, ...(context === undefined ? {} : { context }) };
  const status = model.deprecated
    ? "deprecated" as const
    : current.status === "deprecated" ? undefined : current.status;

  const values = {
    ...current,
    cost,
    limit,
    status,
    // A new file takes the docs' tool and structured output columns; an existing file keeps its own.
    ...(created && model.serverless !== undefined
      ? {
          tool_call: model.serverless.toolCalling ? undefined : false,
          structured_output: model.serverless.structuredOutput || undefined,
        }
      : {}),
  } as SyncedFullModel;

  return baseModel === undefined ? values : factorBaseModel(baseModel, values, limit, baseModelOmit);
}

// Together caches prompt prefixes automatically and routes on `prompt_cache_key`
// (https://docs.together.ai/docs/inference/chat/prompt-caching), so a model with a cached-input price gets
// those capabilities when its file has none. Authored cache details are kept.
function cacheV2Set(model: TogetherSource, current: Record<string, unknown> | undefined) {
  if (model.api?.pricing?.cached_input == null) return undefined;
  const capabilities = current?.capabilities as Record<string, unknown> | undefined;
  if (capabilities?.cache !== undefined) return undefined;
  return { "capabilities.cache": { implicit: true }, "capabilities.prompt_cache_key": true };
}

// Together uses Hugging Face organisations; map them to the catalog's lab directories.
const LAB_PREFIXES: Record<string, string> = {
  "deepseek-ai": "deepseek",
  "elorian-labs": "elorian-labs",
  google: "google",
  "meta-llama": "meta",
  "meta-models": "meta",
  MiniMaxAI: "minimax",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  nvidia: "nvidia",
  openai: "openai",
  "Prism-ML": "prism-ml",
  Qwen: "alibaba",
  reflection: "reflection",
  "ricursive-ai": "ricursiveai",
  tencent: "tencent",
  thinkingmachines: "thinkingmachines",
  "zai-org": "zhipuai",
};

export function resolveTogetherBaseModel(id: string) {
  const [org, ...rest] = id.split("/");
  const lab = org === undefined ? undefined : LAB_PREFIXES[org];
  if (lab === undefined || rest.length === 0) return undefined;
  const name = rest.join("/");
  // `-fast` IDs are a faster deployment of the same model (DeepSeek-V4.1-Flash-1017-fast).
  for (const candidate of new Set([name, name.replace(/-fast$/i, ""), name.replace(/^NVIDIA-/i, "")])) {
    const match = resolveModelMetadataBaseModel(`${lab}/${candidate}`);
    if (match?.startsWith(`${lab}/`)) return match;
  }
  return undefined;
}

function skip(id: string, reason: string) {
  skipReasons.set(id, reason);
  console.warn(`Together AI: skipped ${id}: ${reason}`);
  return undefined;
}

// The API's prices carry float artifacts (0.25999999999999995); six decimals keeps exact rates like 0.07125.
function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
