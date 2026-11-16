// Pioneer (Fastino): https://api.fastino.ai/v1/models (public). Updates
// existing files only: context and output limits, deprecation, and for a
// reasoning model the effort levels its metadata lists and the
// `reasoning_content` field (a file's own field stays). Whether a model reasons
// comes from its lab, or from a standalone file itself: Pioneer lists the same
// boilerplate levels on every model, encoders included. Standalone files also
// take image and PDF input and structured output (when listed). A file
// without a cost takes the catalog's; one with a cost keeps it. The
// `anthropic/pioneer/*` duplicates are skipped. New models and dropped files
// are reported.

import { z } from "zod";

import { inherited, Labs, REPO_ROOT } from "../catalog.js";
import { getPath, isTable } from "../fields.js";
import { fetchJSON } from "../http.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.fastino.ai/v1/models";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];

const Capability = z.object({ supported: z.boolean() }).passthrough();

const PioneerMetadata = z.object({
  slug: z.string(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string() }).passthrough()).nullish(),
}).passthrough();

const PioneerModel = z.object({
  id: z.string(),
  display_name: z.string(),
  max_input_tokens: z.number().int().nonnegative(),
  max_tokens: z.number().int().nonnegative(),
  deprecated: z.boolean().optional(),
  input_price_per_million: z.number().nonnegative().optional(),
  output_price_per_million: z.number().nonnegative().optional(),
  cache_read_price_per_million: z.number().nonnegative().optional(),
  cache_write_price_per_million: z.number().nonnegative().optional(),
  capabilities: z.object({
    image_input: Capability.optional(),
    pdf_input: Capability.optional(),
    structured_outputs: Capability.optional(),
  }).passthrough(),
}).passthrough();
type PioneerModel = z.infer<typeof PioneerModel>;

const PioneerResponse = z.object({ data: z.array(PioneerModel), models: z.array(PioneerMetadata).optional().default([]) }).passthrough();

let labs: Labs | undefined;

export const pioneer: SyncModule<unknown> = {
  id: "pioneer",
  name: "Pioneer",
  policy: {
    owns: [
      { path: "status", merge: "deprecated" },
      { path: "modalities.input", merge: "kinds" },
      "capabilities.reasoning.toggle",
      "capabilities.reasoning.effort",
      "capabilities.reasoning.budget",
      "capabilities.structured_output",
      "limit.context",
      "limit.output",
      "api.chat-completions.compatibility.reasoning_field",
      "cost.text.input.price",
      "cost.text.input.cache.read",
      "cost.text.input.cache.write",
      "cost.text.output.price",
    ],
    creates: "gap",
    removals: "keep",
  },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Pioneer models" }),
  observe(raw) {
    const parsed = PioneerResponse.parse(raw);
    const metadata = new Map(parsed.models.map((model) => [model.slug, model]));
    // Each model is listed again as `anthropic/pioneer/<id>`; those aren't catalog models.
    return parsed.data.filter((model) => !model.id.startsWith("anthropic/pioneer/")).map((model) => observe(model, metadata.get(model.id)));
  },
  refine(observation, file) {
    if (file === undefined) return observation;
    labs ??= new Labs(REPO_ROOT);
    const { cost, modalities, capabilities, ...rest } = observation;
    const base = typeof file.base_model === "string";
    const reasoning = getPath(base ? inherited(file, labs) : file, "capabilities.reasoning.supported") === true;
    const { reasoning: controls, structured_output, ...others } = capabilities ?? {};
    const field = getPath(file, "api.chat-completions.compatibility.reasoning_field");
    const legacy = getPath(file, "api.chat-completions.legacy_interleaved") === true;
    return {
      ...rest,
      ...(base ? {} : { modalities }),
      capabilities: {
        ...others,
        ...(reasoning && controls !== undefined ? { reasoning: controls } : {}),
        ...(base || structured_output === undefined ? {} : { structured_output }),
      },
      api: { "chat-completions": { compatibility: { reasoning_field: reasoning ? (field ?? (legacy ? undefined : "reasoning_content")) : null } } },
      ...(isTable(file.cost) ? {} : { cost }),
    } as Observation;
  },
};

function observe(model: PioneerModel, metadata: z.infer<typeof PioneerMetadata> | undefined): Observation {
  const levels = metadata?.supported_reasoning_levels?.map((level) => level.effort) ?? [];
  const unknown = levels.filter((effort) => !EFFORTS.includes(effort));
  if (unknown.length > 0) throw new Error(`Unsupported Pioneer reasoning effort(s) for ${model.id}: ${[...new Set(unknown)].join(", ")}`);
  const effort = [...new Set(levels)].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const supported = (capability: "image_input" | "pdf_input" | "structured_outputs") => model.capabilities[capability]?.supported === true;
  const input = ["text", ...(supported("image_input") ? ["image"] : []), ...(supported("pdf_input") ? ["application/pdf"] : [])];
  const priced = model.input_price_per_million !== undefined && model.output_price_per_million !== undefined;
  return {
    id: model.id,
    ...(model.deprecated === true ? { status: "deprecated" as const } : {}),
    modalities: { input },
    capabilities: {
      ...(effort.length > 0 ? { reasoning: { toggle: null, effort: effort as never, budget: null } } : {}),
      ...(supported("structured_outputs") ? { structured_output: true } : {}),
    },
    limit: { context: model.max_input_tokens, output: model.max_tokens },
    ...(priced ? {
      cost: {
        text: {
          input: { price: model.input_price_per_million!, cache: { read: model.cache_read_price_per_million ?? null, write: model.cache_write_price_per_million ?? null } },
          output: { price: model.output_price_per_million! },
        },
      },
    } : {}),
  } as Observation;
}

