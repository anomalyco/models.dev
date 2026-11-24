import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ModelFamilyValues, type ModelFamily } from "../../family.js";
import type { SyncProvider, SyncedFullModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

// The public catalogue needs no key and lists only models that are routable
// right now, at most 100 per page.
const API_ENDPOINT = "https://api.numes.ai/public/v1/models";
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
// The gateway rejects `max_completion_tokens` above this ceiling, and its
// authenticated `/api/v1/models` caps every model's output at it. The public
// catalogue does not, so the cap is applied here.
const GATEWAY_MAX_OUTPUT = 131_072;
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const PROVIDERS_DIR = path.join(REPO_ROOT, "providers");
const OPENROUTER_MODELS_DIR = path.join(PROVIDERS_DIR, "openrouter", "models");
const LAB_MODELS_DIR = path.join(REPO_ROOT, "models");

const Effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_ORDER = Effort.options;

const Price = z
  .object({
    cost: z.string(),
    currency: z.string(),
    unit: z.string(),
    pricing_basis: z.string(),
  })
  .passthrough();

export const NumesModel = z
  .object({
    compatible_request_id: z.string().min(1),
    name: z.string(),
    // 0 or null: the figure is unknown.
    context_length: z.number().int().nonnegative().nullable(),
    max_output_length: z.number().int().nonnegative().nullable().optional(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    supported_parameters: z.array(z.string()),
    tasks: z.array(z.string()),
    lowest_prices: z.array(Price),
    lowest_output_prices: z.array(Price),
    lowest_cache_read_prices: z.array(Price).nullable().optional(),
    reasoning: z
      .object({
        supported_efforts: z.array(Effort),
        mandatory: z.boolean(),
        supports_max_tokens: z.boolean(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const NumesPage = z
  .object({
    data: z.array(z.unknown()),
    meta: z.object({ next_cursor: z.string().nullable().optional() }).passthrough(),
  })
  .passthrough();

export type NumesModel = z.infer<typeof NumesModel>;
type ReasoningOptions = NonNullable<SyncedFullModel["reasoning_options"]>;

/**
 * Numes is a multi-model relay with an OpenRouter-compatible API. Files are
 * created only for models with a lab file (`base_model`); the rest are reported
 * as missing models so their lab metadata can be researched first. End-to-end
 * encrypted (`:e2ee`) models need the Numes client bridge and are left out. A
 * model missing from one response is not treated as retired, because the
 * public catalogue lists only models that are routable at that moment.
 */
export const numes = {
  id: "numes",
  name: "Numes",
  modelsDir: "providers/numes/models",
  authoritativeHeaders: true,
  deleteMissing: false,
  sourceID(model) {
    return isEncrypted(model) ? undefined : model.compatible_request_id;
  },
  missingModelID(model) {
    return isEncrypted(model) || !isChat(model) ? undefined : model.compatible_request_id;
  },
  missingNotice(paths) {
    return paths.map(
      (file) => `Numes /public/v1/models no longer lists ${file}; review for manual deprecation or removal.`,
    );
  },
  async fetchModels() {
    const data: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Numes models request failed: ${response.status} ${response.statusText}`);
      }
      const body = NumesPage.parse(await response.json());
      data.push(...body.data);
      cursor = body.meta.next_cursor ?? undefined;
      if (cursor === undefined) return { data };
    }
    throw new Error(`Numes models request exceeded ${MAX_PAGES} pages`);
  },
  parseModels(raw) {
    return z.object({ data: z.array(NumesModel) }).parse(raw).data;
  },
  translateModel(model) {
    if (isEncrypted(model) || !isChat(model)) return undefined;
    const id = model.compatible_request_id;
    const baseModel = resolveBaseModel(id);
    if (baseModel === undefined) return undefined;
    const reasoning = reasoningControls(model, id, baseModel);
    const synced = buildNumesModel(model, baseModel, reasoning);
    const v2Set = buildV2Set(baseModel, synced);
    return {
      id,
      model: synced,
      header: reasoning.header,
      ...(v2Set === undefined ? {} : { v2Set }),
    };
  },
} satisfies SyncProvider<NumesModel>;

function isEncrypted(model: NumesModel) {
  return qualifiers(model.compatible_request_id).includes("e2ee");
}

function isChat(model: NumesModel) {
  return model.tasks.includes("chat");
}

function qualifiers(id: string) {
  return id.split(":").slice(1);
}

const MODEL_FAMILIES = new Set<string>(ModelFamilyValues);

const LAB_PREFIX_ALIASES: Record<string, string> = {
  bytedance: "bytedance-seed",
  mindai: "mindlab",
};

const BASE_MODEL_ALIASES: Record<string, string> = {
  "openai/gpt-5.2-chat": "openai/gpt-5.2-chat-latest",
  "qwen/qwen3.5-flash-02-23": "alibaba/qwen3.5-flash",
  "qwen/qwen3.5-plus-02-15": "alibaba/qwen3.5-plus",
  "x-ai/grok-4.20-multi-agent": "xai/grok-4.20-multi-agent-0309",
};

/** The lab file for a Numes ID, else the one OpenRouter's file for the same ID points at. */
export function resolveBaseModel(id: string) {
  const bare = id.replace(/:batch$/, "");
  const withoutFree = bare.replace(/:free$/, "");
  const aliased = BASE_MODEL_ALIASES[withoutFree];
  if (aliased !== undefined && existsSync(path.join(LAB_MODELS_DIR, `${aliased}.toml`))) return aliased;
  const routed = resolveModelMetadataBaseModel(bare);
  if (routed !== undefined) return routed;
  const slash = withoutFree.indexOf("/");
  if (slash > 0) {
    const mappedLab = LAB_PREFIX_ALIASES[withoutFree.slice(0, slash)];
    const slug = withoutFree.slice(slash + 1);
    if (mappedLab !== undefined) {
      for (const candidate of [slug, slug.replaceAll(".", "-")]) {
        const target = `${mappedLab}/${candidate}`;
        if (existsSync(path.join(LAB_MODELS_DIR, `${target}.toml`))) return target;
      }
    }
  }
  const peer = openRouterPeer(bare);
  return typeof peer?.base_model === "string" ? peer.base_model : undefined;
}

function openRouterPeer(id: string): Record<string, any> | undefined {
  const file = path.join(OPENROUTER_MODELS_DIR, `${id}.toml`);
  if (!existsSync(file)) return undefined;
  return Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, any>;
}

export function buildNumesModel(
  model: NumesModel,
  baseModel: string,
  reasoning: { reasoning?: boolean; options?: ReasoningOptions },
) {
  const params = new Set(model.supported_parameters);
  const lab = labFacts(baseModel);
  const input = narrow(lab.modalities?.input, modalities(model.input_modalities));
  const output = narrow(lab.modalities?.output, modalities(model.output_modalities));
  const context = lower(lab.limit?.context, model.context_length || undefined);
  const limit = {
    context,
    // A lab without an output cap takes another relay's cap for the same ID,
    // else the context window. Output never exceeds the host's context.
    output: lower(
      lower(
        lower(lab.limit?.output ?? peerOutput(model.compatible_request_id) ?? context, model.max_output_length || undefined),
        context,
      ),
      GATEWAY_MAX_OUTPUT,
    ),
  };
  const variant = qualifiers(model.compatible_request_id).length > 0;
  const freeFamily = freeModelFamily(model.compatible_request_id, lab.family);
  return factorBaseModel(
    baseModel,
    {
      // Variants (`:free`, `:batch`) keep the catalogue's display name so the
      // picker can tell them apart; plain IDs inherit the lab's name.
      name: variant ? model.name : undefined,
      // Free routes use `<lab-family>-free` (matching OpenRouter) so clients
      // that show only the newest model per family don't hide them behind paid models.
      family: freeFamily,
      attachment: input.some((value) => value !== "text"),
      reasoning: reasoning.reasoning,
      reasoning_options: reasoning.options,
      // A listed parameter may only be forwarded, so the host can turn
      // temperature off but not on.
      temperature: lab.temperature === true && !params.has("temperature") ? false : undefined,
      tool_call: params.has("tools"),
      structured_output: params.has("structured_outputs") || undefined,
      limit,
      modalities: { input, output },
      cost: cost(model),
    },
    limit,
  );
}

/**
 * Controls the catalogue declares win. Without a declaration, a model the lab
 * marks as reasoning takes OpenRouter's controls for the same ID: Numes accepts
 * the same `reasoning` request object.
 */
type LabFacts = {
  family?: string;
  modalities?: { input?: Modality[]; output?: Modality[] };
  limit?: { context?: number; output?: number };
  temperature?: boolean;
  reasoning?: boolean;
};

function freeModelFamily(id: string, labFamily: string | undefined): ModelFamily | undefined {
  if (!qualifiers(id).includes("free") || labFamily === undefined) return undefined;
  const candidate = `${labFamily}-free`;
  return MODEL_FAMILIES.has(candidate) ? (candidate as ModelFamily) : undefined;
}

/** The v1 view of a lab file, as the OpenRouter sync reads it. */
function labFacts(baseModel: string): LabFacts {
  return modelMetadata(baseModel) as LabFacts;
}

export function reasoningControls(model: NumesModel, id: string, baseModel: string) {
  const declared = model.reasoning;
  if (declared === null || declared === undefined) {
    if (labFacts(baseModel).reasoning !== true) return {};
    const bare = id.replace(/:(free|batch)$/, "");
    const openRouter = openRouterPeer(bare)?.capabilities?.reasoning;
    if (openRouter?.supported === false && !model.supported_parameters.includes("reasoning")) {
      return {
        reasoning: false,
        header: `# Reasoning: not supported on this host (not in Numes supported_parameters; matches openrouter/${bare}).`,
      };
    }
    if (openRouter?.supported === true) {
      return peerReasoningControls(openRouter, `openrouter/${bare}`, false);
    }
    const labPeer = labProviderPeer(baseModel);
    if (labPeer?.reasoning?.supported === true) {
      return peerReasoningControls(labPeer.reasoning, labPeer.source, true);
    }
    return {
      reasoning: true,
      options: [] as ReasoningOptions,
      header: "# Reasoning controls: always on (not declared by Numes; no caller control documented on peers).",
    };
  }
  const efforts = sortEfforts(declared.supported_efforts);
  const toggle = !declared.mandatory && !efforts.includes("none");
  const options: ReasoningOptions = [];
  if (toggle) options.push({ type: "toggle" });
  if (efforts.length > 0) options.push({ type: "effort", values: efforts });
  if (declared.supports_max_tokens) options.push({ type: "budget_tokens" });
  return { reasoning: true, options, header: wireHeader(toggle, efforts, declared.supports_max_tokens) };
}

function labProviderPeer(baseModel: string): { source: string; reasoning: Record<string, any> } | undefined {
  const slash = baseModel.indexOf("/");
  if (slash <= 0) return undefined;
  const lab = baseModel.slice(0, slash);
  const slug = baseModel.slice(slash + 1);
  const file = path.join(PROVIDERS_DIR, lab, "models", `${slug}.toml`);
  if (!existsSync(file)) return undefined;
  const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, any>;
  if (parsed?.capabilities?.reasoning === undefined) return undefined;
  return { source: `${lab}/${slug}`, reasoning: parsed.capabilities.reasoning };
}

function peerReasoningControls(reasoning: Record<string, any>, source: string, stripBudgetBounds: boolean) {
  const options: ReasoningOptions = [];
  const efforts = Array.isArray(reasoning.effort) ? sortEfforts(reasoning.effort) : [];
  const toggle = reasoning.toggle === true && !efforts.includes("none");
  const hasBudget = reasoning.budget !== undefined;
  if (toggle) options.push({ type: "toggle" });
  if (efforts.length > 0) options.push({ type: "effort", values: efforts });
  if (hasBudget) options.push(stripBudgetBounds ? { type: "budget_tokens" } : { type: "budget_tokens", ...reasoning.budget });
  if (options.length === 0) {
    return {
      reasoning: true,
      options,
      header: `# Reasoning controls: always on (not declared by Numes; matches ${source}, which exposes no caller control).`,
    };
  }
  return {
    reasoning: true,
    options,
    header: wireHeader(toggle, efforts, hasBudget, source),
  };
}

function wireHeader(toggle: boolean, efforts: string[], budget: boolean, source?: string) {
  if (!toggle && efforts.length === 0 && !budget) {
    return "# Reasoning controls: always on (Numes /public/v1/models declares mandatory = true with no effort or budget controls).";
  }
  const lines = [
    source === undefined
      ? "# Reasoning controls: Numes /public/v1/models `reasoning` declaration for this model."
      : `# Reasoning controls: not declared by Numes; copied from ${source} (Numes forwards the OpenRouter reasoning object).`,
  ];
  if (toggle) lines.push("# Toggle: reasoning.enabled = true|false");
  if (efforts.length > 0) lines.push(`# Effort: reasoning.effort = ${efforts.join("|")}`);
  if (budget) lines.push("# Budget: reasoning.max_tokens (integer reasoning tokens)");
  return lines.join("\n");
}

function sortEfforts(values: readonly string[]) {
  return [...new Set(values)]
    .filter((value): value is z.infer<typeof Effort> => (EFFORT_ORDER as readonly string[]).includes(value))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const result = values
    .map((value) => (value === "file" ? "pdf" : value))
    .filter((value): value is Modality => allowed.has(value as Modality));
  return [...new Set(result.length > 0 ? result : (["text"] as Modality[]))];
}

function peerOutput(id: string): number | undefined {
  const output = openRouterPeer(id.replace(/:(free|batch)$/, ""))?.limit?.output;
  return typeof output === "number" && output > 0 ? output : undefined;
}

/** The host can drop lab modalities but never add one; the lab's order is kept. */
function narrow(lab: Modality[] | undefined, host: Modality[]): Modality[] {
  if (lab === undefined) return host;
  const kept = lab.filter((value) => host.includes(value));
  return kept.length > 0 ? kept : ["text"];
}

function buildV2Set(
  baseModel: string,
  synced: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const lab = readLabToml(baseModel);
  const result: Record<string, unknown> = {
    ...(lab.v2_only === true ? { v2_only: true } : {}),
    ...(exactModalities(lab.modalities, synced.modalities as Partial<Record<"input" | "output", Modality[]>> | undefined) ?? {}),
  };
  const costValue = synced.cost as { cache_read?: number } | undefined;
  if (costValue?.cache_read !== undefined) {
    // The public catalogue publishes discounted cache-read pricing without
    // specifying whether caching is implicit or explicit, so preserve any
    // authored cache details and default to implicit.
    result["capabilities.cache"] = (current: unknown) =>
      current !== null && typeof current === "object" ? current : { implicit: true };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readLabToml(baseModel: string): { v2_only?: boolean; modalities?: Record<string, string[]> } {
  const file = path.join(LAB_MODELS_DIR, `${baseModel}.toml`);
  return Bun.TOML.parse(readFileSync(file, "utf8")) as { v2_only?: boolean; modalities?: Record<string, string[]> };
}

/**
 * v1 patches write generic categories. Where Numes narrows a lab's modalities,
 * write the lab's own exact entries (MIME types) for the categories kept.
 */
function exactModalities(
  lab: Record<string, string[]> | undefined,
  narrowed: Partial<Record<"input" | "output", Modality[]>> | undefined,
) {
  if (narrowed === undefined || lab === undefined) return undefined;
  const result: Record<string, string[]> = {};
  for (const direction of ["input", "output"] as const) {
    const kept = narrowed[direction];
    const exact = lab[direction];
    if (kept === undefined || exact === undefined) continue;
    result[`modalities.${direction}`] = exact.filter((value) => (kept as string[]).includes(category(value)));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function category(value: string): string {
  if (value === "application/pdf") return "pdf";
  const [type] = value.split("/");
  return type ?? value;
}

/** A host figure only ever lowers the lab's limit. */
function lower(lab: number | undefined, host: number | undefined) {
  if (host === undefined) return lab;
  return lab === undefined || host < lab ? host : lab;
}

/**
 * The catalogue lists the lowest current price per meter across a model's
 * offers, which is where Numes' default lowest-price routing band starts.
 */
function cost(model: NumesModel) {
  const input = tokenPrice(model.lowest_prices, "prompt");
  const output = tokenPrice(model.lowest_output_prices, "completion");
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = tokenPrice(model.lowest_cache_read_prices ?? [], "cached_prompt");
  return { input, output, cache_read: cacheRead !== undefined && cacheRead < input ? cacheRead : undefined };
}

function tokenPrice(prices: z.infer<typeof Price>[], type: string) {
  const price = prices.find(
    (item) =>
      (item as { type?: string }).type === type &&
      item.currency === "USD" &&
      item.unit === "token" &&
      item.pricing_basis === "fixed",
  );
  return price === undefined ? undefined : perMillion(price.cost);
}

/** Exact decimal shift from USD per token to USD per million tokens. */
export function perMillion(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;
  const [, whole, fraction = ""] = match;
  const padded = fraction.padEnd(6, "0");
  const shifted = `${whole}${padded.slice(0, 6)}.${padded.slice(6) || "0"}`;
  const result = Number(shifted);
  return Number.isFinite(result) ? result : undefined;
}
