// Ambient: https://api.ambient.xyz/v1/models (public), an OpenRouter-shaped
// list. Authoritative for token and cache prices, context and output limits,
// input and output kinds, tools, structured output, temperature and whether a
// model reasons; reasoning controls are hand-authored. A model's lab comes
// from its OpenRouter slug. `ambient/*` aliases are named "Ambient <Label>".
// Models the catalog marks not ready are left alone. New models are created
// from a lab file; dropped models are kept and reported.

import { z } from "zod";

import { Labs, REPO_ROOT } from "../catalog.js";
import { fetchJSON } from "../http.js";
import { namespaceHints } from "../labs.js";
import { OPENROUTER_SHAPED_OWNS, observeOpenRouterShaped } from "../openrouter-shape.js";
import type { Observation, SyncModule } from "../types.js";

const API_ENDPOINT = "https://api.ambient.xyz/v1/models";

const AmbientModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.number(),
  hugging_face_id: z.string().nullable().optional(),
  context_length: z.number(),
  max_output_length: z.number(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }).passthrough(),
  supported_features: z.array(z.string()).default([]),
  supported_sampling_parameters: z.array(z.string()).default([]),
  openrouter: z.object({ slug: z.string() }).nullable().optional(),
  is_ready: z.boolean().default(false),
}).passthrough();
type AmbientModel = z.infer<typeof AmbientModel>;

const AmbientResponse = z.object({ object: z.literal("list"), data: z.array(AmbientModel) }).passthrough();

let labs: Labs | undefined;

export const ambient: SyncModule<unknown> = {
  id: "ambient",
  name: "Ambient",
  policy: { owns: OPENROUTER_SHAPED_OWNS, creates: "auto", removals: "keep", omitLabInput: true },
  fetch: () => fetchJSON(API_ENDPOINT, { source: "Ambient models" }),
  observe(raw) {
    labs ??= new Labs(REPO_ROOT);
    // A model listed as not ready keeps its file as it is.
    return AmbientResponse.parse(raw).data.map((model) => (model.is_ready ? observe(model, labs!) : { id: model.id, updateOnly: true }));
  },
};

function observe(model: AmbientModel, labs: Labs): Observation {
  const slug = model.openrouter?.slug ?? model.id;
  const observation = observeOpenRouterShaped({
    id: slug,
    name: model.name,
    created: model.created,
    hugging_face_id: model.hugging_face_id,
    context_length: model.context_length,
    architecture: { input_modalities: model.input_modalities, output_modalities: model.output_modalities },
    pricing: model.pricing,
    top_provider: { max_completion_tokens: model.max_output_length },
    supported_parameters: [...model.supported_features, ...model.supported_sampling_parameters],
  }, { id: model.id, hints: namespaceHints(slug), labs });
  const alias = aliasName(model.id);
  return alias === undefined ? observation : { ...observation, name: alias };
}

function aliasName(id: string) {
  if (!id.startsWith("ambient/")) return undefined;
  const label = id.slice("ambient/".length).split(/[/-]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return `Ambient ${label}`;
}
