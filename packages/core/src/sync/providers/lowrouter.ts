import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ReasoningOption } from "../../schema.js";
import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { MissingReasoningOptionsError } from "../missing-reasoning-options.js";
import { factorBaseModel, modelMetadata, resolveCanonicalBaseModel, resolveModelMetadataBaseModel } from "./openrouter.js";

// LowRouter is a router: an `auto/<creator>/<model>` ID resolves to one of several
// provider/region routes per request. Everything below is copied from LowRouter's
// public catalog; the module holds no LowRouter-specific table or rule.
//
// `?currency=usd` returns each route's stored quote in USD for USD-billed routes and
// converts EUR-billed routes at LowRouter's monthly ECB fixing, stated in an `fx` object.
const API_ENDPOINT = "https://api.lowrouter.ai/v1/models?currency=usd";
const ROOT_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..");

const Fx = z.object({
  rate: z.number().optional(),
  as_of: z.string().optional(),
  fixing: z.string().optional(),
}).passthrough();

const Pricing = z.object({
  currency: z.string(),
  prompt_per_1m_tokens: z.number().nonnegative(),
  completion_per_1m_tokens: z.number().nonnegative(),
  cache_read_per_1m_tokens: z.number().nonnegative().optional(),
  cache_write_per_1m_tokens: z.number().nonnegative().optional(),
}).passthrough();

const Reasoning = {
  reasoning_effort: z.array(z.string()).optional(),
  reasoning_mode: z.string().optional(),
  reasoning_effort_probed_at: z.string().optional(),
};

const Region = z.object({
  locode: z.string(),
  pricing: Pricing.optional(),
  fx: z.array(Fx).optional(),
  upstream_model_id: z.string().optional(),
  ...Reasoning,
}).passthrough();

export const LowRouterModel = z.object({
  id: z.string().min(1),
  modality: z.string().optional(),
  lifecycle: z.string().optional(),
  endpoints: z.array(z.string()).optional(),
  capabilities: z.object({
    function_calling: z.boolean().optional(),
  }).passthrough().optional(),
  fx: z.array(Fx).optional(),
  auto_routing: z.object({
    candidates: z.array(z.string()),
    default_routes: z.array(z.string()).optional(),
    routing_reason: z.string().optional(),
    ...Reasoning,
  }).passthrough().optional(),
  regions: z.array(Region).optional(),
}).passthrough();

export const LowRouterResponse = z.object({
  data: z.array(LowRouterModel),
}).passthrough();

export type LowRouterModel = z.infer<typeof LowRouterModel>;

/** Pinned entries (`provider/creator/model`) by ID, for per-route data. */
export type LowRouterCatalog = Map<string, LowRouterModel>;

/** The unscoped auto IDs: `auto/<creator>/<model>`, nothing after. */
export function isAutoID(id: string) {
  return id.startsWith("auto/") && id.split("/").length === 3;
}

/** Listed for chat, not deprecated, and served on chat completions, per LowRouter's own flags. */
export function isCatalogTarget(model: LowRouterModel) {
  return isAutoID(model.id)
    && (model.modality ?? "chat") === "chat"
    && model.lifecycle !== "deprecated"
    && (model.endpoints ?? []).includes("chat.completions");
}

export function catalogFromResponse(models: LowRouterModel[]): LowRouterCatalog {
  const pinned: LowRouterCatalog = new Map();
  for (const model of models) {
    if (!model.id.startsWith("auto/") && !model.id.startsWith("alias/")) pinned.set(model.id, model);
  }
  return pinned;
}

let catalog: LowRouterCatalog = new Map();

export const lowrouter = {
  id: "lowrouter",
  name: "LowRouter",
  modelsDir: "providers/lowrouter/models",
  deleteMissing: true,
  // Reasoning models LowRouter publishes no controls for are listed in the sync report;
  // they are gaps in LowRouter's catalog, not missing models to research here.
  trackMissingModels: false,
  // The generated lines are rewritten on every sync so they never disagree with the
  // figures; hand-written evidence below them is carried over (see evidenceBlock).
  authoritativeHeaders: true,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`LowRouter models request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const models = LowRouterResponse.parse(raw).data;
    catalog = catalogFromResponse(models);
    return models.filter(isCatalogTarget);
  },
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    return ids.length === 0
      ? []
      : [`Skipped ${ids.length} LowRouter auto ID(s) with no lab metadata or no default-route pricing: ${ids.join(", ")}`];
  },
  translateModel(model, context) {
    const built = buildLowRouterModel(model, catalog, context.existing(model.id));
    return built && { id: model.id, ...built };
  },
} satisfies SyncProvider<LowRouterModel>;

function route(catalog: LowRouterCatalog, id: string) {
  const parts = id.split("/");
  const locode = parts[3] ?? "global";
  const entry = catalog.get(parts.slice(0, 3).join("/"));
  const region = entry?.regions?.find((candidate) => candidate.locode === locode);
  return { provider: parts[0] ?? "", locode, region, fx: region?.fx ?? entry?.fx ?? [] };
}

/**
 * Resolve `base_model` through the lab's own entry in this repo, keyed by the ID LowRouter
 * sends upstream on a first-party route: `providers/mistral/models/ministral-3b-2512.toml`
 * declares `base_model = "mistral/ministral-3-3b-instruct-2512"`. LowRouter's provider slug for
 * a lab's own API is the lab's provider directory here. Falls back to the shared name match.
 */
export function resolveLowRouterBaseModel(model: LowRouterModel, catalog: LowRouterCatalog, root = ROOT_DIR) {
  const [, creator, name] = model.id.split("/");
  const routes = [...(model.auto_routing?.default_routes ?? []), ...(model.auto_routing?.candidates ?? [])];
  for (const id of routes) {
    const candidate = route(catalog, id);
    const upstream = candidate.region?.upstream_model_id;
    if (upstream === undefined || !/^[a-z0-9][a-z0-9._-]*$/i.test(upstream)) continue;
    if (!/^[a-z0-9-]+$/.test(candidate.provider)) continue;
    const labEntry = path.join(root, "providers", candidate.provider, "models", `${upstream}.toml`);
    if (!existsSync(labEntry)) continue;
    const { base_model: base } = Bun.TOML.parse(readFileSync(labEntry, "utf8")) as { base_model?: string };
    const resolved = base ?? resolveModelMetadataBaseModel(upstream);
    if (resolved !== undefined) return resolved;
  }
  return resolveCanonicalBaseModel(`${creator}/${name}`);
}

const EVIDENCE_START = /^# (Effort|Reasoning|Limit|Tool calls|Long-context|Anthropic (accepts|exposes|rejects))/;

/** Hand-written reasoning/limit evidence at the end of an existing file's header. */
export function evidenceBlock(fileText: string | undefined): string[] {
  if (fileText === undefined) return [];
  const header: string[] = [];
  for (const line of fileText.split("\n")) {
    if (!line.startsWith("#")) break;
    header.push(line);
  }
  const start = header.findIndex((line) => EVIDENCE_START.test(line));
  return start === -1 ? [] : header.slice(start);
}

const REQUEST_PARAMETERS_DOCS = "# https://lowrouter.ai/docs/guides/request-parameters";
const SYNCED_REASONING = /^# (Effort: reasoning_effort = \S+ as LowRouter publishes it|Reasoning: LowRouter publishes no reasoning control)/;

/**
 * Split off the reasoning provenance a previous sync wrote (its line, wrapped, through the docs
 * link). Options under such a line came from LowRouter, not an author, so they are refreshed.
 */
export function syncedReasoning(evidence: string[]): { synced: boolean; evidence: string[] } {
  const end = evidence.indexOf(REQUEST_PARAMETERS_DOCS);
  if (!SYNCED_REASONING.test(evidence[0] ?? "") || end === -1) return { synced: false, evidence };
  return { synced: true, evidence: evidence.slice(end + 1) };
}

function existingFile(autoID: string) {
  const file = path.join(ROOT_DIR, lowrouter.modelsDir, `${autoID}.toml`);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function wrapComments(lines: string[], width = 108) {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width + 2) {
      out.push(line);
      continue;
    }
    let rest = line.slice(2);
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      const at = cut > 0 ? cut : width;
      out.push(`# ${rest.slice(0, at)}`);
      rest = rest.slice(at).trimStart();
    }
    if (rest.length > 0) out.push(`# ${rest}`);
  }
  return out;
}

export function buildLowRouterModel(
  model: LowRouterModel,
  catalog: LowRouterCatalog,
  existing: ExistingModel | undefined,
  fileText = existingFile(model.id),
): { model: SyncedModel; header: string } | undefined {
  const routing = model.auto_routing;
  const defaultID = routing?.default_routes?.[0];
  if (routing === undefined || defaultID === undefined) return undefined;
  const chosen = route(catalog, defaultID);
  const pricing = chosen.region?.pricing;
  if (pricing === undefined) return undefined;
  if (pricing.currency !== "USD") {
    throw new Error(`LowRouter ${model.id}: expected USD pricing from ${API_ENDPOINT}, got ${pricing.currency}`);
  }

  const canonical = existing?.base_model ?? resolveLowRouterBaseModel(model, catalog);
  if (canonical === undefined) return undefined;

  // Reasoning controls: authored options are kept by the runner; otherwise LowRouter's
  // published, probed list for the default route, from one source (the route, else the
  // auto entry), refreshed on every sync as the default route moves. A reasoning model
  // with neither is reported, never given an empty list.
  const { synced, evidence } = syncedReasoning(evidenceBlock(fileText));
  const authoredOptions = synced ? undefined : existing?.reasoning_options;
  const source = chosen.region?.reasoning_effort !== undefined ? chosen.region : routing;
  const published = source.reasoning_effort;
  let reasoningOptions: SyncedModel["reasoning_options"] | undefined;
  let reasoningLine: string | undefined;
  if (authoredOptions === undefined) {
    if (published === undefined) {
      if (modelMetadata(canonical).reasoning === true) {
        throw new MissingReasoningOptionsError(model.id, "LowRouter publishes no reasoning_effort for its default route yet");
      }
    } else if (published.length === 0) {
      reasoningOptions = [];
      reasoningLine = `# Reasoning: LowRouter publishes no reasoning control for this route (reasoning_mode ${source.reasoning_mode ?? "unsupported"}).`;
    } else {
      // Parsed against the catalog schema, so a value LowRouter publishes that the schema does not know fails loudly.
      reasoningOptions = [ReasoningOption.parse({ type: "effort", values: published })];
      const probed = source.reasoning_effort_probed_at ? `, probed ${source.reasoning_effort_probed_at.slice(0, 10)}` : "";
      reasoningLine = `# Effort: reasoning_effort = ${published.join("|")} as LowRouter publishes it for this route (reasoning_mode ${source.reasoning_mode ?? "unknown"}${probed}).`;
    }
  }

  // Authored limits win; otherwise the lab's limit is inherited.
  const limit = existing?.limit;
  const cost = {
    input: pricing.prompt_per_1m_tokens,
    output: pricing.completion_per_1m_tokens,
    // Cache prices come only from the route the header cites, so a route without them never
    // keeps the previous route's figures.
    cache_read: pricing.cache_read_per_1m_tokens,
    cache_write: pricing.cache_write_per_1m_tokens,
    reasoning: existing?.cost?.reasoning,
    tiers: existing?.cost?.tiers,
  };

  const [fx] = chosen.fx;
  const conversion = fx?.rate !== undefined
    ? `that route bills in EUR, converted at ${fx.rate} USD/EUR (ECB ${fx.fixing ?? "monthly"} fixing, ${fx.as_of ?? "date not stated"})`
    : "that route bills in USD, so this is its USD quote as the API returns it, with no currency conversion";
  const header = [
    `# Source: ${API_ENDPOINT} (synced). This ID has ${routing.candidates.length} route(s).`,
    `# Cost is the route LowRouter's default routing profile resolves to (${routing.routing_reason ?? "default"}): ${chosen.provider}, ${chosen.locode} endpoint;`,
    `# ${conversion}.`,
    "# Another route can serve a request (the key's routing policy, or a failover); usage.cost on the",
    "# response carries the amount debited.",
  ];
  // A freshly written reasoning list keeps its provenance line even when the carried-over
  // evidence only covers limits or tool calls.
  const reasoningLines = reasoningLine === undefined || evidence.some((line) => /^# (Effort|Reasoning):/.test(line))
    ? evidence
    : [reasoningLine, REQUEST_PARAMETERS_DOCS, ...evidence];

  return {
    model: factorBaseModel(canonical, {
      reasoning_options: reasoningOptions,
      tool_call: model.capabilities?.function_calling,
      status: existing?.status,
      interleaved: existing?.interleaved,
      limit,
      cost,
    }, limit, existing?.base_model_omit),
    header: wrapComments([...header, ...reasoningLines]).join("\n") + "\n",
  };
}
