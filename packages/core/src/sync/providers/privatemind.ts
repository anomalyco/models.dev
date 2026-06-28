import { z } from "zod";

import type { SyncProvider, SyncedFullModel } from "../index.js";

// PrivateMind is an OpenAI-compatible platform whose models are exposed as
// stable service-tier aliases (default, fast, coding, reasoning, ...) that
// route to whatever model is currently deployed behind each tier. Every field
// in a registry entry is derived from /v1/models, so swapping the model behind
// an alias needs no change here.
const API_ENDPOINT = "https://api.privatemind.com/v1/models";

// Only chat-shaped tiers map onto a models.dev model entry; embeddings, TTS,
// rerank, etc. are skipped. The filter keys on the API's model_type, not a
// hand-maintained list.
const CHAT_TYPES = new Set(["chat", "vision-chat"]);

const Capabilities = z
  .object({
    tools: z.boolean().optional(),
    response_format: z.boolean().optional(),
    reasoning_effort: z.boolean().optional(),
    image_input: z.boolean().optional(),
  })
  .partial()
  .passthrough();

const Cost = z
  .object({
    input_per_m_token: z.number().optional(),
    output_per_m_token: z.number().optional(),
    image_per_generation: z.number().optional(),
  })
  .partial();

const PrivateMindModel = z
  .object({
    id: z.string(),
    aliases: z.array(z.string()).default([]),
    model_type: z.string().optional(),
    created: z.number().optional(),
    capabilities: Capabilities.optional(),
    context_length: z.number().nullable().optional(),
    cost: Cost.nullable().optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

const PrivateMindResponse = z.object({ data: z.array(PrivateMindModel) }).passthrough();

type PrivateMindModel = z.infer<typeof PrivateMindModel>;

// One source item per (chat-tier alias, model carrying it).
type AliasModel = { alias: string; model: PrivateMindModel };

// /v1/models exposes a unix `created`; it's the only date the API carries, so
// it seeds release_date / last_updated (release_date is then preserved).
function isoDate(unixSeconds: number | undefined): string {
  return new Date((unixSeconds ?? 0) * 1000).toISOString().slice(0, 10);
}

export const privatemind = {
  id: "privatemind",
  name: "PrivateMind",
  modelsDir: "providers/privatemind/models",
  async fetchModels() {
    const key = process.env.PRIVATEMIND_API_KEY;
    if (!key) throw new Error("PRIVATEMIND_API_KEY is not set");
    const response = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`PrivateMind /v1/models failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    const items: AliasModel[] = [];
    for (const model of PrivateMindResponse.parse(raw).data) {
      if (!CHAT_TYPES.has(model.model_type ?? "")) continue;
      for (const alias of model.aliases) items.push({ alias, model });
    }
    return items;
  },
  sourceID(item) {
    return item.alias;
  },
  translateModel(item, context) {
    const { alias, model } = item;
    const caps = model.capabilities ?? {};
    const cost = model.cost ?? {};
    const params = model.supported_parameters ?? [];
    const vision = Boolean(caps.image_input) || model.model_type === "vision-chat";
    const reasoning = Boolean(caps.reasoning_effort);
    const context_length = model.context_length ?? 0;
    const existing = context.existing(alias);
    const date = isoDate(model.created);

    const synced: SyncedFullModel = {
      // id is the stable alias; the display name is the tier, capitalised.
      name: alias.charAt(0).toUpperCase() + alias.slice(1),
      attachment: vision,
      reasoning,
      reasoning_options: reasoning
        ? [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }]
        : undefined,
      tool_call: Boolean(caps.tools),
      temperature: params.includes("temperature"),
      structured_output: Boolean(caps.response_format),
      // an alias is a hosted endpoint, not a single downloadable weights release
      open_weights: false,
      release_date: existing?.release_date ?? date,
      last_updated: existing?.last_updated ?? date,
      cost:
        cost.input_per_m_token != null || cost.output_per_m_token != null
          ? { input: cost.input_per_m_token ?? 0, output: cost.output_per_m_token ?? 0 }
          : undefined,
      limit: { context: context_length, output: context_length },
      modalities: {
        input: vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    };

    return { id: alias, model: synced };
  },
} satisfies SyncProvider<AliasModel>;
