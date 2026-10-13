import { z } from "zod";

import type { ExistingModel, SyncedModel, SyncProvider } from "../index.js";

// LowRouter is a router: an `auto/<creator>/<model>` ID resolves to one of several
// provider/region routes per request. This sync only keeps the files already in
// providers/lowrouter current. It never creates a model from the feed: reasoning
// controls, limits and replay fields are hand-authored from live probes.
//
// `?currency=usd` returns each route's quote in USD. EUR-billed routes are converted at
// LowRouter's ECB fixing, which the pinned entry states in its `fx` array.
const API_ENDPOINT = "https://api.lowrouter.ai/v1/models?currency=usd";

// Fewer unscoped auto IDs than this means a truncated response, not retirements.
const MIN_AUTO_MODELS = 100;

// LowRouter renamed these IDs; the old ID is gone from /v1/models. Each maps the
// new ID to the old file, which is moved to the new ID with its authored fields.
// Mistral IDs moved to the full Hugging Face names in November 2026.
export const RENAMED: Record<string, string> = {
  "auto/mistralai/ministral-3-3b-instruct-2512": "auto/mistralai/ministral-3b-2512",
  "auto/mistralai/ministral-3-8b-instruct-2512": "auto/mistralai/ministral-8b-2512",
  "auto/mistralai/ministral-3-14b-instruct-2512": "auto/mistralai/ministral-14b-2512",
  "auto/mistralai/mistral-large-3-675b-instruct-2512": "auto/mistralai/mistral-large-2512",
  "auto/mistralai/mistral-medium-3.5-128b": "auto/mistralai/mistral-medium-3.5",
  "auto/mistralai/mistral-small-4-119b-2603": "auto/mistralai/mistral-small-2603",
};

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

const Region = z.object({
  locode: z.string(),
  pricing: Pricing.optional(),
}).passthrough();

export const LowRouterEntry = z.object({
  id: z.string().min(1),
  lifecycle: z.string().optional(),
  fx: z.array(Fx).nullish(),
  auto_routing: z.object({
    default_routes: z.array(z.string()).optional(),
  }).passthrough().optional(),
  regions: z.array(Region).nullish(),
}).passthrough();

export const LowRouterResponse = z.object({
  data: z.array(LowRouterEntry),
}).passthrough();

export type LowRouterEntry = z.infer<typeof LowRouterEntry>;

/** The route a plain request resolves to under LowRouter's default routing profile. */
export interface DefaultRoute {
  id: string;
  provider: string;
  locode: string;
  pricing?: z.infer<typeof Pricing>;
  fx?: z.infer<typeof Fx>;
}

export interface LowRouterModel {
  id: string;
  lifecycle?: string;
  route?: DefaultRoute;
}

/** The unscoped auto IDs: `auto/<creator>/<model>`, nothing after. */
export function isAutoID(id: string) {
  return id.startsWith("auto/") && id.split("/").length === 3;
}

/** Pairs each auto ID with its default route's quote, read from the pinned `provider/creator/model` entry. */
export function lowRouterModels(entries: LowRouterEntry[]): LowRouterModel[] {
  const pinned = new Map(entries.filter((entry) => !entry.id.startsWith("auto/")).map((entry) => [entry.id, entry]));
  const models = entries.filter((entry) => isAutoID(entry.id)).map((entry) => {
    const routeID = entry.auto_routing?.default_routes?.[0];
    if (routeID === undefined) return { id: entry.id, lifecycle: entry.lifecycle };
    const parts = routeID.split("/");
    const locode = parts[3] ?? "global";
    const target = pinned.get(parts.slice(0, 3).join("/"));
    const region = target?.regions?.find((candidate) => candidate.locode === locode);
    return {
      id: entry.id,
      lifecycle: entry.lifecycle,
      route: { id: routeID, provider: parts[0] ?? "", locode, pricing: region?.pricing, fx: target?.fx?.[0] },
    };
  });
  if (models.length < MIN_AUTO_MODELS) {
    throw new Error(
      `LowRouter returned ${models.length} auto models, below the ${MIN_AUTO_MODELS} needed to`
        + " tell a retirement from a truncated response",
    );
  }
  return models;
}

export const lowrouter = {
  id: "lowrouter",
  name: "LowRouter",
  modelsDir: "providers/lowrouter/models",
  // An ID LowRouter no longer lists is withdrawn (deprecated IDs stay listed until
  // `retires_on`), so its file is removed. The auto-merge limits cap a bad run.
  deleteMissing: true,
  // New IDs are added by hand-authored PRs, so remote-only IDs are counted, not reported as issues.
  trackMissingModels: false,
  // A renamed file keeps exactly its authored fields.
  inheritPredecessorCapabilities: false,
  // header() returns the existing header unless the price changed or a sync wrote it.
  authoritativeHeaders: true,
  sourceID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [`${ids.length} LowRouter auto IDs have no file in providers/lowrouter and were not created.`];
  },
  async fetchModels() {
    return fetchLowRouterModels();
  },
  parseModels(raw) {
    return lowRouterModels(LowRouterResponse.parse(raw).data);
  },
  translateModel(model, context) {
    const previousID = context.authored(model.id) === undefined ? RENAMED[model.id] : model.id;
    const authored = previousID === undefined ? undefined : context.authored(previousID);
    if (previousID === undefined || authored === undefined) return undefined;
    const built = buildLowRouterModel(model, authored, context.header?.(previousID));
    return { id: model.id, ...built };
  },
} satisfies SyncProvider<LowRouterModel>;

export async function fetchLowRouterModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT);
  if (!response.ok) {
    throw new Error(`LowRouter models request failed: ${response.status} ${response.statusText}`);
  }
  return LowRouterResponse.parse(await response.json());
}

// The feed states the default route's price and the ID's lifecycle; everything else in
// the file (reasoning controls, limits, API tables, modalities) is hand-authored and kept.
// `existing` is the file's own fields (context.authored), not the view merged with its lab file.
export function buildLowRouterModel(
  model: LowRouterModel,
  existing: ExistingModel,
  existingHeader: string | undefined,
): { model: SyncedModel; header: string } {
  const pricing = model.route?.pricing;
  if (model.route === undefined || pricing === undefined) {
    throw new Error(`LowRouter ${model.id} has no priced default route`);
  }
  if (pricing.currency !== "USD") {
    throw new Error(`LowRouter ${model.id}: expected USD pricing from ${API_ENDPOINT}, got ${pricing.currency}`);
  }

  const cost = {
    ...existing.cost,
    input: pricing.prompt_per_1m_tokens,
    output: pricing.completion_per_1m_tokens,
    // Cache prices come only from the route the header names, so a route without them
    // never keeps another route's figures.
    cache_read: pricing.cache_read_per_1m_tokens,
    cache_write: pricing.cache_write_per_1m_tokens,
  };
  const status = model.lifecycle === "deprecated" ? "deprecated" : existing.status;
  const priceChanged = (["input", "output", "cache_read", "cache_write"] as const)
    .some((key) => existing.cost?.[key] !== cost[key]);

  return {
    // Only cost and status change. Re-factoring the other fields against the lab file
    // would also drop overrides the header comments explain.
    model: { ...existing, cost, status } as SyncedModel,
    header: header(model.route, existingHeader, priceChanged),
  };
}

const SYNCED_SOURCE = `# Source: ${API_ENDPOINT} (synced).`;

// Hand-written evidence (reasoning, limit and modality probes) starts at the first of these labels.
const EVIDENCE_START = /^# (Effort|Reasoning|Toggle|Budget|Limit|Input modalities|Tool calls):/;

/**
 * The cost lines above the evidence are replaced when the price changes, or always once
 * a sync wrote them, so they never disagree with the figures. A hand-written header whose
 * price still matches is left as it is. Evidence lines are kept verbatim.
 */
export function header(route: DefaultRoute, existingHeader: string | undefined, priceChanged: boolean) {
  const lines = (existingHeader ?? "").split("\n").filter((line) => line.startsWith("#"));
  if (!priceChanged && lines[0] !== SYNCED_SOURCE) return existingHeader ?? "";
  const start = lines.findIndex((line) => EVIDENCE_START.test(line));
  const evidence = start === -1 ? [] : lines.slice(start);
  const conversion = route.fx?.rate === undefined
    ? "# The route bills in USD; no currency conversion."
    : `# The route bills in EUR, converted by LowRouter at ${route.fx.rate} USD/EUR (ECB, ${route.fx.as_of ?? "date not stated"}).`;
  return [
    SYNCED_SOURCE,
    `# Cost: the default route ${route.id} (auto_routing.default_routes).`,
    conversion,
    "# Another route can serve a request (routing policy or failover); usage.cost on the response",
    "# carries the amount debited.",
    ...evidence,
  ].join("\n") + "\n";
}
