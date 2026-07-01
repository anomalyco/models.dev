import { z } from "zod";

import type { SyncProvider, SyncedFullModel } from "../index.js";

// PrivateMind is an OpenAI-compatible platform. Every registry entry is derived
// entirely from /v1/models, so deploying, swapping, or retiring a model needs
// no change here — the next sync reflects it automatically.
const API_ENDPOINT = "https://api.privatemind.com/v1/models";

// Only chat-shaped models map onto a models.dev entry; embeddings, TTS, ASR,
// rerank, OCR and image-gen are skipped. Keys on the API's model_type, not a
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
    model_full_name: z.string().optional(),
    model_type: z.string().optional(),
    created: z.number().optional(),
    open_weights: z.boolean().optional(),
    capabilities: Capabilities.optional(),
    context_length: z.number().nullable().optional(),
    cost: Cost.nullable().optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

const PrivateMindResponse = z.object({ data: z.array(PrivateMindModel) }).passthrough();

type PrivateMindModel = z.infer<typeof PrivateMindModel>;

// /v1/models carries a unix `created`; it seeds release_date / last_updated and
// is then preserved, so the dates stay stable across syncs.
function isoDate(unixSeconds: number | undefined): string {
  const ms = unixSeconds ? unixSeconds * 1000 : Date.now();
  return new Date(ms).toISOString().slice(0, 10);
}

export const privatemind = {
  id: "privatemind",
  name: "PrivateMind",
  modelsDir: "providers/privatemind/models",
  // Mirror the live fleet: drop entries for models no longer returned by the API.
  deleteMissing: true,
  async fetchModels() {
    // /v1/models is public (no API key): the endpoint returns the default
    // org's catalog to anonymous callers.
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`PrivateMind /v1/models failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    // Publish only chat-shaped, open-weight models. `open_weights === true` is
    // the gateway's own signal (sourced from the catalog), so internal /
    // proprietary models (open_weights false) drop out here automatically — no
    // hand-maintained denylist.
    return PrivateMindResponse.parse(raw).data.filter(
      (model) => CHAT_TYPES.has(model.model_type ?? "") && model.open_weights === true,
    );
  },
  sourceID(model) {
    return model.id;
  },
  translateModel(model, context) {
    const caps = model.capabilities ?? {};
    const cost = model.cost ?? {};
    const params = model.supported_parameters ?? [];
    const vision = Boolean(caps.image_input) || model.model_type === "vision-chat";
    const reasoning = Boolean(caps.reasoning_effort);
    const context_length = model.context_length ?? 0;
    const existing = context.existing(model.id);
    const date = isoDate(model.created);

    const synced: SyncedFullModel = {
      name: model.model_full_name || model.id,
      attachment: vision,
      reasoning,
      reasoning_options: reasoning
        ? [{ type: "effort", values: ["low", "medium", "high"] }]
        : undefined,
      tool_call: Boolean(caps.tools),
      temperature: params.includes("temperature"),
      structured_output: Boolean(caps.response_format),
      open_weights: true,
      release_date: existing?.release_date ?? date,
      last_updated: existing?.last_updated ?? date,
      cost:
        cost.input_per_m_token != null || cost.output_per_m_token != null
          ? { input: cost.input_per_m_token ?? 0, output: cost.output_per_m_token ?? 0 }
          : undefined,
      // vLLM serves with no output cap below the context window, so for large
      // models the output ceiling is the context length. But OpenCode reserves
      // the output budget from the window (usable = context - min(output, 32000)),
      // so output == context starves a near-32K model's usable context to almost
      // nothing. When the window is small (<= 64K) clamp output to leave room for
      // the prompt; large windows are unaffected (OpenCode caps output at 32000).
      limit: {
        context: context_length,
        output: context_length <= 65_536 ? Math.min(context_length, 8_192) : context_length,
      },
      modalities: {
        input: vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    };

    return { id: model.id, model: synced };
  },
} satisfies SyncProvider<PrivateMindModel>;
