// Prime Inference: https://api.pinference.ai/api/v1/models (public).
// Authoritative for token and cache prices, context and output limits, input
// and output kinds, tool calling, temperature, structured output, the display
// name, and reasoning with its effort levels; descriptions and the lab's input
// limit are always the lab's. Each file's leading comment is generated. Only
// public chat routes are synced: lowercase namespaces outside internal/ and
// frontier/, no `:` variants, with tools and text in and out. A public route
// with incomplete metadata (or reasoning with no listed efforts) keeps its
// file as it is. New models are created from a lab file; dropped routes are
// deleted.

import { z } from "zod";

import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import { ReasoningEffortV2Values } from "../../schema-v2.js";
import type { Doc, Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.pinference.ai/api/v1/models";
const KINDS = ["text", "audio", "image", "video", "pdf"];

// Prime reports 0 for routes without a token limit, such as audio
// transcription, so 0 reads as unpublished rather than a real limit.
const TokenLimit = z.number().int().nonnegative().nullish().transform((value) => (value === 0 ? null : value));
const Price = z.number().nonnegative().nullish();

const PrimeModel = z.object({
  id: z.string().min(1),
  display_name: z.string().nullish(),
  pricing: z.object({
    input_usd_per_mtok: Price,
    output_usd_per_mtok: Price,
    cache_read_usd_per_mtok: Price,
    cache_write_usd_per_mtok: Price,
  }).passthrough().nullish(),
  specs: z.object({
    context_window: TokenLimit,
    max_output_tokens: TokenLimit,
    supports_reasoning: z.boolean().nullish(),
    modalities: z.object({ input: z.array(z.string()).nullish(), output: z.array(z.string()).nullish() }).passthrough().nullish(),
  }).passthrough().nullish(),
  context_window: TokenLimit,
  max_output_tokens: TokenLimit,
  supported_parameters: z.array(z.string()).nullish(),
  reasoning: z.object({ supported_efforts: z.array(z.string()).nullish() }).passthrough().nullish(),
}).passthrough();
type PrimeModel = z.infer<typeof PrimeModel>;

const PrimeResponse = z.object({
  object: z.literal("list"),
  data: z.array(PrimeModel).min(1, "Prime returned an empty catalog; refusing to remove local models"),
}).passthrough();

const MID_CONVERSATION_LINES = [
  "# Mid-conversation: system_updates, effort_updates and tools.updates are unset; Prime documents none of them and they weren't tested live.",
  "# Prime serves Chat Completions, Anthropic Messages (translated onto chat completions) and Responses (https://api.pinference.ai/openapi.json).",
].join("\n");
const MIME_LINE = "# Input MIME types: the lab's entries for each kind Prime lists (Prime documents no formats).";

let labs: Labs | undefined;

export const prime: SyncModule<unknown> = {
  id: "prime",
  name: "Prime Inference",
  policy: {
    owns: [
      "name",
      "description",
      "base_model_omit",
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
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "auto",
    removals: "delete",
    headers: "replace",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Prime catalog" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    const data = PrimeResponse.parse(raw).data;
    return data.filter(publicChatRoute).map((model) => observe(model, labs!));
  },
};

// Inventory routes rather than public model identities. Lowercase namespaces
// also keep exact IDs on case-insensitive filesystems.
function publicChatRoute(model: PrimeModel) {
  const [namespace = ""] = model.id.split("/");
  if (namespace !== namespace.toLowerCase() || ["internal", "frontier"].includes(namespace) || model.id.includes(":")) return false;
  const modalities = model.specs?.modalities;
  return !(
    (model.supported_parameters != null && !model.supported_parameters.includes("tools"))
    || (modalities?.input != null && !modalities.input.includes("text"))
    || (modalities?.output != null && !modalities.output.includes("text"))
  );
}

function observe(model: PrimeModel, labs: Labs): Observation {
  const parameters = model.supported_parameters;
  const modalities = model.specs?.modalities;
  const context = model.context_window ?? model.specs?.context_window;
  const outputLimit = model.max_output_tokens ?? model.specs?.max_output_tokens;
  const pricing = model.pricing;
  const reasoning = model.specs?.supports_reasoning;
  const efforts = model.reasoning?.supported_efforts == null ? undefined : sortEfforts(model.reasoning.supported_efforts);
  const incomplete = !parameters?.includes("tools") || !modalities?.input?.includes("text") || !modalities.output?.includes("text")
    || context == null || outputLimit == null || pricing?.input_usd_per_mtok == null || pricing.output_usd_per_mtok == null || reasoning == null;
  const badEfforts = reasoning === true && (efforts === undefined || efforts.length === 0 || efforts.some((effort) => !(ReasoningEffortV2Values as readonly string[]).includes(effort)));
  // Kept as is until Prime publishes the rest.
  if (incomplete || badEfforts) return { id: model.id, updateOnly: true };
  const listed = { input: modalities!.input!, output: modalities!.output!, parameters: parameters! };

  const hints = labHints(model.id);
  const lab = hints.map((hint) => labs.find(hint)).find((found) => found !== undefined);
  const labInput = lab === undefined ? undefined : (labs.get(lab)?.limit as { input?: number } | undefined)?.input;
  const input = listed.input.filter((value) => KINDS.includes(value));
  const output = listed.output.filter((value) => KINDS.includes(value));
  return {
    id: model.id,
    base: hints,
    name: model.display_name?.trim() || null,
    description: null,
    ...({ base_model_omit: labInput === undefined ? null : ["limit.input"] } as object),
    modalities: { input: mime(input), output: mime(output) },
    capabilities: {
      tools: { supported: true },
      reasoning: reasoning ? { supported: true, toggle: null, effort: efforts as never, budget: null } : { supported: false },
      temperature: listed.parameters.includes("temperature"),
      structured_output: listed.parameters.some((value) => ["response_format", "structured_outputs"].includes(value)),
    },
    limit: { context, output: outputLimit },
    cost: {
      text: {
        input: { price: pricing.input_usd_per_mtok, cache: { read: pricing.cache_read_usd_per_mtok ?? null, write: pricing.cache_write_usd_per_mtok ?? null } },
        output: { price: pricing.output_usd_per_mtok },
      },
    },
    // The MIME line names the file's own formats, which the sync keeps.
    header: (doc: Doc) => "# Generated by bun models:sync prime from https://api.pinference.ai/api/v1/models.\n"
      + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
      + (reasoning ? `# Effort: top-level reasoning_effort = ${efforts!.join("|")}.\n` : "")
      + (listed.input.includes("file") ? "# Generic file input is omitted; it does not imply PDF support.\n" : "")
      + `${MID_CONVERSATION_LINES}\n`
      + (mimeTypes(doc) ? `${MIME_LINE}\n` : ""),
  } as Observation;
}

function mimeTypes(doc: Doc) {
  const input = (doc.modalities as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) && input.some((value) => String(value).includes("/"));
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

// Low to high, so a reordered catalog never rewrites the files.
function sortEfforts(efforts: string[]) {
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

function mime(values: string[]) {
  return values.map((value) => (value === "pdf" ? "application/pdf" : value));
}
