import { z } from "zod";

import { describeModel } from "../../describe.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api-gateway.merge.dev/v1/models";

const AvailabilityStatus = z.enum(["available", "deprecated"]);

const VendorReasoning = z.object({
  configurable: z.boolean().optional(),
  disable_supported: z.boolean().optional(),
  default_enabled: z.boolean().optional(),
  controls: z.array(z.string()).optional(),
  output_style: z.string().nullable().optional(),
}).passthrough();

const VendorCapabilities = z.object({
  input: z.array(z.enum(["text", "audio", "image", "document", "embedding"])),
  output: z.array(z.enum(["text", "audio", "tool_use", "embedding"])),
  supports_tool_calling: z.boolean(),
  supports_tool_choice: z.boolean().default(false),
  supports_structured_outputs: z.boolean(),
  supports_reasoning: z.boolean().optional(),
  reasoning: VendorReasoning.nullable().optional(),
  streaming: z.boolean(),
}).passthrough();

const PromptCaching = z.object({
  mode: z.enum(["automatic", "explicit", "none"]).optional(),
  cache_read_cost_per_million: z.number().nonnegative().nullable().optional(),
  cache_write_cost_per_million: z.number().nonnegative().nullable().optional(),
}).passthrough();

const VendorInfo = z.object({
  launch_date: z.string().nullable().optional(),
  context_window: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative(),
  availability_status: AvailabilityStatus,
  capabilities: VendorCapabilities,
  pricing: z.object({
    currency: z.literal("USD").default("USD"),
    input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    cache_read_per_million: z.number().nonnegative().nullable().optional(),
    cache_write_per_million: z.number().nonnegative().nullable().optional(),
  }).passthrough(),
  prompt_caching: PromptCaching.nullable().optional(),
}).passthrough();

export const MergeGatewayModel = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  display_name: z.string().min(1),
  vendors: z.record(VendorInfo),
  availability_status: AvailabilityStatus,
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
}).passthrough();

export const MergeGatewayResponse = z.object({
  object: z.literal("list").default("list"),
  data: z.array(MergeGatewayModel),
  has_more: z.boolean().default(false),
  next_cursor: z.string().nullable().optional(),
}).passthrough();

export type MergeGatewayModel = z.infer<typeof MergeGatewayModel>;
export type MergeGatewayVendor = z.infer<typeof VendorInfo>;

export async function fetchMergeGatewayModels(
  fetcher: typeof fetch = fetch,
  apiKey = process.env.MERGE_GATEWAY_API_KEY,
) {
  if (!apiKey) throw new Error("MERGE_GATEWAY_API_KEY is required to sync Merge Gateway models");

  const models = new Map<string, MergeGatewayModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("limit", "500");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);

    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Merge Gateway request failed: ${response.status} ${response.statusText}`);
    }

    const page = MergeGatewayResponse.parse(await response.json());
    for (const model of page.data) models.set(model.model, model);
    if (!page.has_more) break;
    if (!page.next_cursor) throw new Error("Merge Gateway returned has_more=true without next_cursor");
    if (cursors.has(page.next_cursor)) throw new Error(`Merge Gateway repeated cursor: ${page.next_cursor}`);
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  } while (true);

  return {
    object: "list" as const,
    data: [...models.values()],
    has_more: false,
    next_cursor: null,
  };
}

export const mergeGateway = {
  id: "merge-gateway",
  name: "Merge Gateway",
  modelsDir: "providers/merge-gateway/models",
  // API-key policy can affect catalog visibility. Retain missing local models
  // until Merge exposes an account-independent catalog response.
  deleteMissing: false,
  sourceID(model) {
    return model.model;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} Merge Gateway models were skipped because they are not text models or lack canonical metadata.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local Merge Gateway models were absent from the API response and retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  fetchModels() {
    return fetchMergeGatewayModels();
  },
  parseModels(raw) {
    return MergeGatewayResponse.parse(raw).data;
  },
  translateModel(model, context) {
    const existing = context.existing(model.model);
    const translated = buildMergeGatewayModel(model, existing, context.authored(model.model));
    return translated === undefined ? undefined : { id: model.model, model: translated };
  },
} satisfies SyncProvider<MergeGatewayModel>;

export function selectMergeGatewayVendor(model: MergeGatewayModel) {
  const canonical = model.vendors[model.provider];
  if (canonical?.availability_status === "available") {
    return { id: model.provider, info: canonical };
  }

  // Match Gateway's default resolver: when the model author's native route is
  // unavailable, use the cheapest active route by combined input + output
  // price. Object order is preserved for equal prices; the public API emits
  // vendors in CMS-priority order, which is Gateway's own tiebreaker.
  const available = Object.entries(model.vendors)
    .filter(([, info]) => info.availability_status === "available");
  const selected = available.reduce<typeof available[number] | undefined>((best, candidate) => {
    if (best === undefined) return candidate;
    const bestCost = best[1].pricing.input_per_million + best[1].pricing.output_per_million;
    const candidateCost = candidate[1].pricing.input_per_million + candidate[1].pricing.output_per_million;
    return candidateCost < bestCost ? candidate : best;
  }, undefined);
  if (selected !== undefined) return { id: selected[0], info: selected[1] };
  if (canonical !== undefined) return { id: model.provider, info: canonical };

  const fallback = Object.entries(model.vendors)[0];
  return fallback === undefined ? undefined : { id: fallback[0], info: fallback[1] };
}

export function buildMergeGatewayModel(
  model: MergeGatewayModel,
  existing: ExistingModel | undefined,
  authored: ExistingModel | undefined = existing,
): SyncedModel | undefined {
  const selected = selectMergeGatewayVendor(model);
  if (selected === undefined || !selected.info.capabilities.output.includes("text")) return undefined;

  const input = modalities(selected.info.capabilities.input);
  const output = modalities(selected.info.capabilities.output);
  const limit = {
    context: selected.info.context_window || existing?.limit?.context || 0,
    // Preserve only a provider-authored input cap. `existing` is resolved
    // against base-model metadata, so using its inherited input value here
    // can keep an impossible cap when the gateway reports a smaller context.
    input: authored?.limit?.input,
    output: selected.info.max_output_tokens || existing?.limit?.output || selected.info.context_window,
  };
  const cachePricing = mergeGatewayCachePricing(selected.info, existing);
  const cost = {
    input: selected.info.pricing.input_per_million,
    output: selected.info.pricing.output_per_million,
    reasoning: existing?.cost?.reasoning,
    cache_read: cachePricing.read,
    cache_write: cachePricing.write,
    input_audio: existing?.cost?.input_audio,
    output_audio: existing?.cost?.output_audio,
    tiers: existing?.cost?.tiers,
  };
  const status = model.availability_status === "deprecated" || selected.info.availability_status === "deprecated"
    ? "deprecated" as const
    : undefined;
  const baseModel = existing?.base_model ?? resolveCanonicalBaseModel(model.model);
  // `supports_reasoning` is not part of the documented public schema
  // (PublicVendorModelCapabilities) and is inconsistently populated across
  // vendor routes: the same model can report `true` on one route and `false`
  // on another (e.g. anthropic/claude-opus-4-6 reports `false` via `anthropic`
  // and `true` via `bedrock`), and reasoning-only models such as
  // deepseek/deepseek-r1 report `false` on their sole route. Treat it as a
  // positive-only signal: `true` (always accompanied by route `reasoning`
  // metadata) confirms the model reasons on the gateway, while `false`/absent
  // means unknown and preserves curated reasoning metadata.
  const routeConfirmsReasoning = Object.values(model.vendors).some(
    (vendor) => vendor.availability_status === "available" && vendor.capabilities.supports_reasoning === true,
  );
  const reasoning = routeConfirmsReasoning ? true : existing?.reasoning;
  const reasoningOptions = reasoning === true
    ? existing?.reasoning_options ?? []
    : existing?.reasoning_options;
  const authoritative = {
    // Some catalog rows use an upstream org/model ID as display_name. Let
    // canonical metadata provide the human-readable name for factored models.
    name: baseModel !== undefined && model.display_name.includes("/") ? undefined : model.display_name,
    attachment: input.some((value) => value !== "text"),
    tool_call: selected.info.capabilities.supports_tool_calling,
    structured_output: selected.info.capabilities.supports_structured_outputs,
    status,
    cost,
    limit,
    modalities: { input, output },
  };

  if (baseModel !== undefined) {
    return factorBaseModel(
      baseModel,
      {
        ...authoritative,
        description: existing?.description,
        reasoning,
        reasoning_options: reasoningOptions,
        temperature: existing?.temperature,
        interleaved: existing?.interleaved,
        provider: existing?.provider,
        experimental: existing?.experimental,
      },
      limit,
      existing?.base_model_omit,
    );
  }

  if (existing === undefined) return undefined;

  const releaseDate = selected.info.launch_date
    ?? model.created_at?.slice(0, 10)
    ?? existing.release_date;
  if (releaseDate === undefined) return undefined;
  const lastUpdated = model.updated_at?.slice(0, 10)
    ?? existing.last_updated
    ?? releaseDate;
  return {
    ...authoritative,
    description: existing.description ?? describeModel({
      id: model.model,
      name: model.display_name,
      family: existing.family,
      reasoning,
      tool_call: selected.info.capabilities.supports_tool_calling,
      structured_output: selected.info.capabilities.supports_structured_outputs,
      open_weights: existing.open_weights,
      limit,
      modalities: { input, output },
    }),
    family: existing.family,
    release_date: releaseDate,
    last_updated: lastUpdated,
    reasoning: reasoning ?? false,
    reasoning_options: reasoningOptions,
    temperature: existing.temperature,
    knowledge: existing.knowledge,
    open_weights: existing.open_weights ?? false,
    interleaved: existing.interleaved,
    provider: existing.provider,
    experimental: existing.experimental,
  } satisfies SyncedFullModel;
}

function mergeGatewayCachePricing(
  vendor: MergeGatewayVendor,
  existing: ExistingModel | undefined,
) {
  const promptCaching = vendor.prompt_caching;
  const pricing = vendor.pricing;
  if (promptCaching?.mode === "none") {
    return { read: undefined, write: undefined };
  }
  return {
    read: promptCaching?.cache_read_cost_per_million
      ?? pricing.cache_read_per_million
      ?? existing?.cost?.cache_read,
    write: promptCaching?.cache_write_cost_per_million
      ?? pricing.cache_write_per_million
      ?? existing?.cost?.cache_write,
  };
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function modalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  return [...new Set(values
    .map((value) => value === "document" ? "pdf" : value)
    .filter((value): value is Modality => allowed.has(value as Modality))
  )];
}
