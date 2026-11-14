// ai&: https://api.aiand.com/v1/api.json (public; AIAND_API_URL overrides it),
// a models.dev-shaped feed. Authoritative for host facts: prices (context
// tiers as bands), limits, kinds, tools, structured output, temperature,
// reasoning with its effort levels (the only control ai& has), the reasoning
// field and status. A price the feed leaves out keeps the file's. A file's
// name and description stay. A reasoning model the feed gives no valid
// efforts for keeps its file's efforts, or is left alone when it has none.
// Standalone files also take the family and open weights. New models are
// created from a lab file (new files get a header naming the effort path);
// dropped models are deleted.

import { z } from "zod";

import { ModelFamily } from "../../family.js";
import { Labs, REPO_ROOT } from "../catalog.js";
import { getPath } from "../fields.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.aiand.com/v1/api.json";
const MODALITIES = ["text", "audio", "image", "video", "pdf"];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const INTERLEAVED_FIELDS = ["reasoning_content", "reasoning_details"];
const DOCS_URL = "https://docs.aiand.com/models/catalog/";

const PRICE = z.number().nonnegative();
const CostFields = {
  input: PRICE,
  output: PRICE,
  reasoning: PRICE.optional(),
  cache_read: PRICE.optional(),
  cache_write: PRICE.optional(),
  input_audio: PRICE.optional(),
  output_audio: PRICE.optional(),
};

const AiandModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  family: z.string().optional(),
  release_date: z.string(),
  last_updated: z.string().optional(),
  reasoning: z.boolean(),
  reasoning_options: z.array(z.object({ type: z.string(), values: z.array(z.unknown()).optional() }).passthrough()).optional(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  structured_output: z.boolean().optional(),
  cost: z.object({
    ...CostFields,
    tiers: z.array(z.object({ ...CostFields, tier: z.object({ size: z.number().int().nonnegative() }).passthrough() }).passthrough()).optional(),
  }).passthrough(),
  limit: z.object({ context: z.number().int().positive(), output: z.number().int().positive() }).passthrough(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).passthrough(),
  open_weights: z.boolean().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  interleaved: z.union([z.boolean(), z.object({ field: z.string() }).passthrough()]).optional(),
}).passthrough();
type AiandModel = z.infer<typeof AiandModel>;

const AiandResponse = z.object({ aiand: z.object({ models: z.record(AiandModel) }).passthrough() }).passthrough();

let labs: Labs | undefined;

export const aiand: SyncModule<unknown> = {
  id: "aiand",
  name: "ai&",
  policy: {
    owns: [
      { path: "name", standalone: true, createOnly: true },
      { path: "description", standalone: true, createOnly: true },
      { path: "family", standalone: true },
      { path: "release_date", standalone: true, createOnly: true },
      { path: "last_updated", standalone: true, createOnly: true },
      { path: "open_weights", standalone: true },
      "status",
      { path: "modalities.input", merge: "kinds" },
      { path: "modalities.output", merge: "kinds" },
      "capabilities.tools.supported",
      "capabilities.reasoning.supported",
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "capabilities.temperature",
      "limit.context",
      "limit.output",
      "api.chat-completions.legacy_interleaved",
      "api.chat-completions.compatibility.reasoning_field",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      { path: "cost.text.input.overrides", merge: "bands" },
      "cost.text.output.price",
      "cost.text.output.reasoning",
      { path: "cost.text.output.overrides", merge: "bands" },
      "cost.audio.input.price",
      "cost.audio.output.price",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(process.env.AIAND_API_URL ?? API_ENDPOINT, { source: "ai& catalog" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const models = Object.values(AiandResponse.parse(raw).aiand.models);
    if (models.length === 0) throw new Error("ai& catalog returned no models; refusing an empty feed as authoritative");
    return models.map((model) => observe(model, labs!));
  },
  // The feed's efforts, else the file's; a reasoning model with neither is
  // left alone. A deprecated file whose model the feed lists without a status
  // isn't deprecated anymore. The reasoning field falls back to the file's,
  // then reasoning_content.
  refine(observation, file) {
    const capabilities = observation.capabilities ?? {};
    const reasoning = capabilities.reasoning;
    const fileEffort = getPath(file, "capabilities.reasoning.effort");
    let next = observation;
    if (reasoning?.supported === true && reasoning.effort === undefined) {
      if (!Array.isArray(fileEffort)) return { id: observation.id, updateOnly: true };
      next = { ...next, capabilities: { ...capabilities, reasoning: { ...reasoning, effort: fileEffort as never } } };
    }
    if (next.status === undefined && file?.status === "deprecated") next = { ...next, status: null };
    if (reasoning?.supported === true && getPath(next, "api.chat-completions.compatibility.reasoning_field") === undefined && getPath(next, "api.chat-completions.legacy_interleaved") === undefined) {
      const own = getPath(file, "api.chat-completions.compatibility.reasoning_field") !== undefined || getPath(file, "api.chat-completions.legacy_interleaved") === true;
      if (!own) next = { ...next, api: { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } } };
    }
    return next;
  },
};

function observe(model: AiandModel, labs: Labs): Observation {
  const base = resolveBase(model.id, model.name, labs);
  const effort = feedEffort(model);
  const interleaved = model.interleaved === true ? true : model.interleaved === false || model.interleaved === undefined ? undefined
    : INTERLEAVED_FIELDS.includes(model.interleaved.field) ? model.interleaved.field : undefined;
  const family = ModelFamily.safeParse(model.family);
  const tiers = [...model.cost.tiers ?? []].sort((a, b) => a.tier.size - b.tier.size);
  const when = (size: number) => ({ context: { gt: size } });
  const cache = (prices: { cache_read?: number; cache_write?: number }) =>
    prices.cache_read === undefined && prices.cache_write === undefined ? {} : { cache: { ...(prices.cache_read === undefined ? {} : { read: prices.cache_read }), ...(prices.cache_write === undefined ? {} : { write: prices.cache_write }) } };
  const sortKinds = (values: string[]) => [...new Set(values.filter((value) => MODALITIES.includes(value)))]
    .sort((a, b) => MODALITIES.indexOf(a) - MODALITIES.indexOf(b))
    .map((value) => (value === "pdf" ? "application/pdf" : value));
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: model.id,
    base: base === undefined ? [] : [base],
    name: model.name,
    description: model.description ?? model.name,
    ...(family.success ? { family: family.data } : {}),
    release_date: model.release_date,
    ...((model.last_updated ?? today) === model.release_date ? {} : { last_updated: model.last_updated ?? today }),
    open_weights: model.open_weights ?? false,
    ...(model.status === undefined ? {} : { status: model.status }),
    modalities: { input: sortKinds(model.modalities.input), output: sortKinds(model.modalities.output) },
    capabilities: {
      tools: { supported: model.tool_call },
      reasoning: model.reasoning
        ? { supported: true, toggle: null, budget: null, ...(effort === undefined ? {} : { effort: effort as never }) }
        : { supported: false },
      ...(model.structured_output === undefined ? {} : { structured_output: model.structured_output }),
      temperature: model.temperature,
    },
    limit: { context: model.limit.context, output: model.limit.output },
    api: {
      "chat-completions": !model.reasoning
        ? { legacy_interleaved: null, compatibility: { reasoning_field: null } }
        : interleaved === true ? { legacy_interleaved: true } : interleaved === undefined ? {} : { compatibility: { reasoning_field: interleaved } },
    },
    cost: {
      text: {
        input: {
          price: model.cost.input,
          cache: { ...(model.cost.cache_read === undefined ? {} : { read: model.cost.cache_read }), ...(model.cost.cache_write === undefined ? {} : { write: model.cost.cache_write }) },
          overrides: tiers.length === 0 ? null : tiers.map((tier) => ({ when: when(tier.tier.size), price: tier.input, ...cache(tier) })),
        },
        output: {
          price: model.cost.output,
          ...(model.cost.reasoning === undefined ? {} : { reasoning: model.cost.reasoning }),
          overrides: tiers.length === 0 ? null : tiers.map((tier) => ({ when: when(tier.tier.size), price: tier.output, ...(tier.reasoning === undefined ? {} : { reasoning: tier.reasoning }) })),
        },
      },
      audio: {
        ...(model.cost.input_audio === undefined ? {} : { input: { price: model.cost.input_audio } }),
        ...(model.cost.output_audio === undefined ? {} : { output: { price: model.cost.output_audio } }),
      },
    },
    header: (doc) => header(doc),
  } as Observation;
}

// The feed's effort levels: undefined says nothing, [] says "no controls".
function feedEffort(model: AiandModel): string[] | null | undefined {
  if (model.reasoning_options === undefined) return undefined;
  if (model.reasoning_options.length === 0) return null;
  const values = model.reasoning_options
    .filter((option) => option.type === "effort")
    .flatMap((option) => (option.values ?? []).filter((value): value is string => typeof value === "string" && EFFORTS.includes(value)));
  return values.length === 0 ? undefined : [...new Set(values)].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
}

// A new file's header: ai& has one reasoning control, reasoning_effort.
function header(doc: Record<string, unknown>) {
  const effort = getPath(doc, "capabilities.reasoning.effort");
  if (!Array.isArray(effort) || effort.length === 0) return "";
  return [
    "# Pricing: GET https://api.aiand.com/v1/api.json (synced hourly by the aiand module)",
    `# Docs: ${DOCS_URL}`,
    `# Effort: reasoning_effort = ${effort.map((value) => `"${value}"`).join(" | ")}`,
    "# Controls: reasoning_effort only (`reasoning_effort` on /v1/chat/completions, `reasoning.effort` on /v1/responses; \"none\" = off) — no separate toggle or token-budget field on this host.",
    "# Reasoning side channel: message.reasoning_content",
  ].join("\n");
}

// A unique normalized match on the full ID, then on the filename alone.
function resolveBase(id: string, name: string, labs: Labs) {
  const entries = labs.all().filter((lab) => lab.split("/").length === 2);
  for (const candidate of [...new Set([id, name])]) {
    const full = normalize(candidate);
    const filename = normalize(candidate.split("/").pop() ?? candidate);
    const ranked = [
      entries.filter((entry) => normalize(entry) === full),
      entries.filter((entry) => normalize(entry.split("/")[1]!) === filename),
    ];
    const match = ranked.find((matches) => matches.length === 1)?.[0];
    if (match !== undefined) return match;
  }
  return undefined;
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
