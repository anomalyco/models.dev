// Merge Gateway: https://api-gateway.merge.dev/v1/models (MERGE_GATEWAY_API_KEY,
// paged by cursor). Each model is read from one vendor route: the model's own
// provider when available, else the cheapest available one. Authoritative for
// the display name (unless it's just the ID), token and cache prices (a long
// context price as a band), context and output limits, input and output
// kinds, tools, structured output and deprecation. Prompt caching mode "none"
// removes cache prices; an unlisted cache price keeps the file's. A route that
// reasons turns reasoning on, and a file without reasoning controls takes the
// route's; a file's own controls stay. Standalone files also take the release
// date. New models are created from a lab file; non-text models and dropped
// models keep their files and are reported.

import { z } from "zod";

import { ReasoningEffortV2Values } from "../../schema-v2.js";
import { getPath, isTable } from "../fields.js";
import { bearer, fetchJSON, requireEnv } from "../http.js";
import { namespaceHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api-gateway.merge.dev/v1/models";

const AvailabilityStatus = z.enum(["available", "deprecated"]);

const VendorInfo = z.object({
  launch_date: z.string().nullable().optional(),
  context_window: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative(),
  availability_status: AvailabilityStatus,
  capabilities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
    supports_tool_calling: z.boolean(),
    supports_structured_outputs: z.boolean(),
    supports_reasoning: z.boolean().optional(),
    reasoning: z.object({
      disable_supported: z.boolean().optional(),
      controls: z.array(z.string()).optional(),
      effort_values: z.array(z.string()).optional(),
    }).passthrough().nullable().optional(),
  }).passthrough(),
  pricing: z.object({
    input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    cache_read_per_million: z.number().nonnegative().nullable().optional(),
    cache_write_per_million: z.number().nonnegative().nullable().optional(),
    unit: z.string().optional(),
    long_context: z.object({
      threshold_tokens: z.number().int().positive(),
      input_per_million: z.number().nonnegative().nullable().optional(),
      output_per_million: z.number().nonnegative().nullable().optional(),
      cache_read_per_million: z.number().nonnegative().nullable().optional(),
      cache_write_per_million: z.number().nonnegative().nullable().optional(),
    }).passthrough().nullable().optional(),
  }).passthrough(),
  prompt_caching: z.object({
    mode: z.enum(["automatic", "explicit", "none"]).optional(),
    cache_read_cost_per_million: z.number().nonnegative().nullable().optional(),
    cache_write_cost_per_million: z.number().nonnegative().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();
type VendorInfo = z.infer<typeof VendorInfo>;

const MergeGatewayModel = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  display_name: z.string().min(1),
  vendors: z.record(VendorInfo),
  availability_status: AvailabilityStatus,
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
}).passthrough().superRefine((model, context) => {
  const namespace = model.model.split("/")[0];
  if (namespace !== model.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"], message: `Model namespace ${namespace} does not match provider ${model.provider}` });
});
type MergeGatewayModel = z.infer<typeof MergeGatewayModel>;

const MergeGatewayResponse = z.object({
  data: z.array(MergeGatewayModel),
  has_more: z.boolean().default(false),
  next_cursor: z.string().nullable().optional(),
}).passthrough();

const TOGGLE_HEADER = '# Toggle: thinking.type = "enabled"|"disabled"; enabled requires thinking.budget_tokens.\n# https://docs.merge.dev/merge-gateway/capabilities/reasoning\n';

export const mergeGateway: SyncModule<unknown> = {
  id: "merge-gateway",
  name: "Merge Gateway",
  policy: {
    owns: [
      "name",
      { path: "release_date", standalone: true },
      { path: "last_updated", standalone: true },
      "status",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      { path: "cost.text.output.overrides", merge: "bands" },
    ],
    creates: "auto",
    removals: "keep",
    omitLabInput: true,
  },
  fetch: fetchAll,
  observe: (raw) => MergeGatewayResponse.parse(raw).data.flatMap(observe),
  // A lab-based file goes without a name when the display name is just the
  // ID. A file's own reasoning controls stay; one without takes the route's.
  refine(observation, file) {
    let next = observation;
    const slug = observation.id.split("/").at(-1)?.toLowerCase();
    const name = String(observation.name);
    if ((file === undefined || typeof file.base_model === "string") && (name.includes("/") || name.toLowerCase() === slug)) next = { ...next, name: null };
    const reasoning = next.capabilities?.reasoning;
    const own = getPath(file, "capabilities.reasoning");
    if (reasoning == null || !isTable(own) || !Object.keys(own).some((key) => key !== "supported")) return next;
    return { ...next, capabilities: { ...next.capabilities, reasoning: { supported: reasoning.supported } } };
  },
};

async function fetchAll() {
  const key = requireEnv("Merge Gateway", "MERGE_GATEWAY_API_KEY");
  const models = new Map<string, unknown>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set("limit", "500");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const page = MergeGatewayResponse.parse(await fetchJSON(url.toString(), { source: "Merge Gateway models", headers: bearer(key) }));
    for (const model of page.data) {
      if (models.has(model.model)) throw new Error(`Merge Gateway returned duplicate model ID: ${model.model}`);
      models.set(model.model, model);
    }
    if (!page.has_more) break;
    if (!page.next_cursor) throw new Error("Merge Gateway returned has_more=true without next_cursor");
    if (cursors.has(page.next_cursor)) throw new Error(`Merge Gateway repeated cursor: ${page.next_cursor}`);
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  return { object: "list", data: [...models.values()], has_more: false, next_cursor: null };
}

function observe(model: MergeGatewayModel): Observation[] {
  const selected = selectVendor(model);
  // Non-text models keep their files as they are.
  if (selected === undefined || !selected.capabilities.output.includes("text")) return [{ id: model.model, updateOnly: true }];
  const input = kinds(selected.capabilities.input);
  const output = kinds(selected.capabilities.output);
  const reasons = Object.values(model.vendors).some((vendor) => vendor.availability_status === "available" && vendor.capabilities.supports_reasoning === true);
  const controls = reasoningControls(selected.capabilities.reasoning);
  const deprecated = model.availability_status === "deprecated" || selected.availability_status === "deprecated";
  const release = selected.launch_date ?? model.created_at?.slice(0, 10) ?? undefined;
  const updated = model.updated_at?.slice(0, 10) ?? undefined;
  const hints = namespaceHints(model.model);
  return [{
    id: model.model,
    base: hints,
    name: model.display_name,
    ...(release === undefined ? {} : { release_date: release }),
    ...(updated === undefined ? {} : { last_updated: updated === release ? null : updated }),
    status: deprecated ? "deprecated" : null,
    modalities: { input, output },
    capabilities: {
      tools: { supported: selected.capabilities.supports_tool_calling },
      ...(reasons ? { reasoning: { supported: true, toggle: null, effort: null, budget: null, ...(controls ?? {}) } } : {}),
      structured_output: selected.capabilities.supports_structured_outputs,
    },
    limit: {
      ...(selected.context_window > 0 ? { context: selected.context_window } : {}),
      ...(selected.max_output_tokens > 0 ? { output: selected.max_output_tokens } : {}),
    },
    ...cost(selected),
    defaults: { limit: { context: selected.context_window, output: selected.context_window } },
    header: (doc) => (getPath(doc, "capabilities.reasoning.toggle") === true ? TOGGLE_HEADER : ""),
  } as Observation];
}

// The model's own provider route when available, else the cheapest available
// route, else the provider's, else the first.
function selectVendor(model: MergeGatewayModel): VendorInfo | undefined {
  const own = model.vendors[model.provider];
  if (own?.availability_status === "available") return own;
  const available = Object.values(model.vendors).filter((vendor) => vendor.availability_status === "available");
  const cheapest = available.reduce<VendorInfo | undefined>((best, vendor) => {
    if (best === undefined) return vendor;
    return vendor.pricing.input_per_million + vendor.pricing.output_per_million < best.pricing.input_per_million + best.pricing.output_per_million ? vendor : best;
  }, undefined);
  return cheapest ?? own ?? Object.values(model.vendors)[0];
}

function reasoningControls(reasoning: VendorInfo["capabilities"]["reasoning"]) {
  if (reasoning == null) return undefined;
  const controls = (reasoning.controls ?? []).map((control) => control.toLowerCase());
  const values = reasoning.effort_values ?? [];
  const rank = (value: string) => {
    const index = (ReasoningEffortV2Values as readonly string[]).indexOf(value);
    return index === -1 ? ReasoningEffortV2Values.length : index;
  };
  return {
    ...(reasoning.disable_supported === true ? { toggle: true } : {}),
    ...((controls.includes("reasoning.effort") || controls.includes("reasoning_effort")) && values.length > 0 ? { effort: [...values].sort((a, b) => rank(a) - rank(b)) } : {}),
    ...(controls.includes("thinking.budget_tokens") ? { budget: {} } : {}),
  };
}

function cost(vendor: VendorInfo) {
  if ((vendor.pricing.unit ?? "per_token") !== "per_token") return {};
  const caching = vendor.prompt_caching;
  const none = caching?.mode === "none";
  const read = none ? null : caching?.cache_read_cost_per_million ?? vendor.pricing.cache_read_per_million ?? undefined;
  const write = none ? null : caching?.cache_write_cost_per_million ?? vendor.pricing.cache_write_per_million ?? undefined;
  const long = vendor.pricing.long_context;
  const when = long == null ? undefined : { context: { gt: long.threshold_tokens } };
  const bandRead = long?.cache_read_per_million ?? read ?? undefined;
  const bandWrite = long?.cache_write_per_million ?? write ?? undefined;
  return {
    cost: {
      text: {
        input: {
          price: vendor.pricing.input_per_million,
          cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) },
          ...(long == null ? {} : {
            overrides: [{
              when,
              price: long.input_per_million ?? vendor.pricing.input_per_million,
              ...(bandRead === undefined && bandWrite === undefined ? {} : { cache: { ...(bandRead === undefined ? {} : { read: bandRead }), ...(bandWrite === undefined ? {} : { write: bandWrite }) } }),
            }],
          }),
        },
        output: {
          price: vendor.pricing.output_per_million,
          ...(long == null ? {} : { overrides: [{ when, price: long.output_per_million ?? vendor.pricing.output_per_million }] }),
        },
      },
    },
  };
}

function kinds(values: string[]) {
  const allowed = ["text", "audio", "image", "video", "pdf"];
  return [...new Set(values.map((value) => (value === "document" ? "pdf" : value)).filter((value) => allowed.includes(value)))]
    .map((value) => (value === "pdf" ? "application/pdf" : value));
}
