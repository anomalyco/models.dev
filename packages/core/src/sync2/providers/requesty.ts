// Requesty: https://router.requesty.ai/v1/models/managed (public).
// Authoritative for token and cache prices with their context bands, context
// and output limits, tool calling, structured output and reasoning (its
// shared reasoning_effort levels). A regional route (`@eu`) is named after its
// lab model and region. Files without a lab file also take the source's
// description, family, release date and image input. New models are created
// from a lab file; dropped models are deleted.

import { z } from "zod";

import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { labHints } from "../labs.js";
import type { Observation, SyncModule } from "../types.js";
import { inferFamily } from "../units.js";

const API_ENDPOINT = "https://router.requesty.ai/v1/models/managed";
// Documented shared values; xhigh is model-specific and not in the catalog API.
const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"];
const REGION_SUFFIX = /@[a-z0-9-]+$/i;
const ANTHROPIC_DOT_ZERO = /^claude-(?:opus|sonnet|haiku)-\d+$/;

const PricingBand = z.object({
  prompt_tokens_threshold: z.number(),
  input_price: z.number().nullish(),
  output_price: z.number().nullish(),
  cached_price: z.number().nullish(),
  caching_price: z.number().nullish(),
}).passthrough();

const RequestyModel = z.object({
  id: z.string().min(1),
  created: z.number(),
  description: z.string(),
  context_window: z.number(),
  max_output_tokens: z.number(),
  input_price: z.number().nullish(),
  output_price: z.number().nullish(),
  cached_price: z.number().nullish(),
  caching_price: z.number().nullish(),
  pricing: z.array(PricingBand).nullish(),
  supports_vision: z.boolean().default(false),
  supports_reasoning: z.boolean().default(false),
  supports_tool_calling: z.boolean().default(false),
  supports_output_json_schema: z.boolean().default(false),
}).passthrough();
type RequestyModel = z.infer<typeof RequestyModel>;

const RequestyResponse = z.object({ object: z.literal("list"), data: z.array(RequestyModel) }).passthrough();

let labs: Labs | undefined;

export const requesty: SyncModule<unknown> = {
  id: "requesty",
  name: "Requesty",
  policy: {
    owns: [
      "name",
      { path: "description", standalone: true },
      { path: "family", standalone: true },
      { path: "release_date", standalone: true },
      { path: "open_weights", standalone: true },
      { path: "modalities.input", merge: "kinds", standalone: true },
      "capabilities.tools.supported",
      "capabilities.reasoning",
      "capabilities.structured_output",
      "limit.context",
      "limit.output",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.input.overrides",
      "cost.text.output.price",
      "cost.text.output.overrides",
    ],
    creates: "auto",
    removals: "delete",
    omitLabInput: true,
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Requesty models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    return RequestyResponse.parse(raw).data.map((model) => observe(model, labs!));
  },
};

function observe(model: RequestyModel, labs: Labs): Observation {
  const bare = model.id.replace(REGION_SUFFIX, "");
  const hints = [
    ...labHints(bare),
    ...(bare.startsWith("claude-") ? labHints(`anthropic/${bare}`) : []),
    ...(ANTHROPIC_DOT_ZERO.test(bare) ? labHints(`${bare}-0`) : []),
  ];
  const lab = hints.map((hint) => labs.find(hint)).find((found) => found !== undefined);
  const labDoc = lab === undefined ? undefined : labs.get(lab);
  const context = model.context_window;
  const region = REGION_SUFFIX.exec(model.id)?.[0].slice(1);
  const labOutput = (labDoc?.limit as { output?: number } | undefined)?.output;
  // An output limit of 0 means unknown: the lab's, unless it exceeds this
  // route's context. A file linked to its lab by hand keeps its own.
  const output = model.max_output_tokens > 0
    ? model.max_output_tokens
    : lab === undefined ? undefined : labOutput !== undefined && labOutput <= context ? null : context;
  const reasoning = model.supports_reasoning;
  const releaseDate = new Date(model.created * 1000).toISOString().slice(0, 10);

  return {
    id: model.id,
    base: lab === undefined ? [] : [lab],
    // A route matched to a lab is named after it (and its region); a file
    // linked to its lab by hand keeps its own name.
    ...(lab === undefined ? {} : { name: region === undefined ? null : typeof labDoc?.name === "string" ? `${labDoc.name} (${region.toUpperCase()})` : model.id }),
    description: model.description,
    ...(lab === undefined ? { family: inferFamily(model.id, model.id) as never } : {}),
    release_date: releaseDate,
    open_weights: false,
    modalities: { input: model.supports_vision ? ["text", "image"] : ["text"] },
    capabilities: {
      tools: { supported: model.supports_tool_calling },
      // The OpenAI-compatible route takes reasoning_effort, not a budget.
      reasoning: reasoning ? { supported: true, effort: REASONING_EFFORTS as never } : { supported: false },
      structured_output: model.supports_output_json_schema,
    },
    limit: { context, ...(output === undefined ? {} : { output }) },
    ...cost(model),
  };
}

function cost(model: RequestyModel) {
  const base = model.pricing?.[0] ?? model;
  const input = base.input_price;
  const output = base.output_price;
  if (input == null || output == null) return {};
  const bands = (model.pricing ?? []).slice(1);
  const when = (band: z.infer<typeof PricingBand>) => ({ context: { gt: band.prompt_tokens_threshold } });
  return {
    cost: {
      text: {
        input: {
          price: perMillion(input),
          cache: { read: charged(base.cached_price) ?? null, write: charged(base.caching_price) ?? null },
          overrides: bands.length === 0 ? null : bands.map((band) => {
            const read = charged(band.cached_price);
            const write = charged(band.caching_price);
            return {
              when: when(band),
              price: perMillion(band.input_price ?? input),
              ...(read === undefined && write === undefined ? {} : { cache: { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) } }),
            };
          }),
        },
        output: {
          price: perMillion(output),
          overrides: bands.length === 0 ? null : bands.map((band) => ({ when: when(band), price: perMillion(band.output_price ?? output) })),
        },
      },
    },
  };
}

function charged(price: number | null | undefined) {
  return price == null || price <= 0 ? undefined : perMillion(price);
}

function perMillion(price: number) {
  return Math.round(price * 1_000_000 * 1_000_000) / 1_000_000;
}
