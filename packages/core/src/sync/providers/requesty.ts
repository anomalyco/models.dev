import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedModel } from "../index.js";
import { factorBaseModel, resolveCanonicalBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://router.requesty.ai/v1/models";

export const RequestyModel = z.object({
  id: z.string(),
  api: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  description: z.string().optional(),
  input_price: z.number().optional(),
  output_price: z.number().optional(),
  cached_price: z.number().optional(),
  context_window: z.number().optional(),
  max_output_tokens: z.number().optional(),
  supports_caching: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_tool_calling: z.boolean().optional(),
  supports_image_generation: z.boolean().optional(),
  supports_output_json_schema: z.boolean().optional(),
}).passthrough();

export const RequestyResponse = z.object({
  data: z.array(RequestyModel),
}).passthrough();

export type RequestyModel = z.infer<typeof RequestyModel>;

export const requesty = {
  id: "requesty",
  name: "Requesty",
  modelsDir: "providers/requesty/models",
  // Requesty proxies a large, frequently-changing catalog (including many
  // re-proxied sub-provider variants). Only sync models that resolve to a
  // canonical models.dev base model, and never delete hand-curated entries.
  deleteMissing: false,
  // Requesty's live API doesn't carry every field curated entries may have
  // (e.g. cache_write tiers, pdf modality). Treat any existing entry as
  // authoritative so the sync is purely additive: it creates newly-available
  // models but never rewrites hand-curated ones.
  sameModel() {
    return true;
  },
  async fetchModels() {
    const headers = process.env.REQUESTY_API_KEY
      ? { Authorization: `Bearer ${process.env.REQUESTY_API_KEY}` }
      : undefined;
    const response = await fetch(API_ENDPOINT, { headers });
    if (!response.ok) {
      throw new Error(`Requesty request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return RequestyResponse.parse(raw).data.filter((model) => {
      // Skip routing-policy aliases and non-chat surfaces.
      if ((model.api ?? "chat") !== "chat") return false;
      if (!model.id.includes("/")) return false;
      if (model.id.startsWith("policy/")) return false;
      // Only keep models that map onto an existing canonical models.dev model,
      // so synced entries stay factored via base_model and the catalog stays
      // curated rather than mirroring every proxied sub-provider variant.
      return resolveCanonicalBaseModel(model.id) !== undefined;
    });
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildRequestyModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<RequestyModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

// Requesty reports prices in USD per token. models.dev stores USD per million tokens.
function price(value: number | undefined) {
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000_000_000) / 1_000_000
    : undefined;
}

export function buildRequestyModel(
  model: RequestyModel,
  existing: ExistingModel | undefined,
): SyncedModel {
  const input: Modality[] = model.supports_vision ? ["text", "image"] : ["text"];
  const output: Modality[] = ["text"];
  const inputPrice = price(model.input_price);
  const outputPrice = price(model.output_price);
  const reasoning = Boolean(model.supports_reasoning);
  const attachment = input.some((value) => value !== "text");
  const toolCall = Boolean(model.supports_tool_calling);
  const structuredOutput = Boolean(model.supports_output_json_schema);
  const cost = inputPrice !== undefined && outputPrice !== undefined
    ? {
        input: inputPrice,
        output: outputPrice,
        cache_read: price(model.cached_price),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;

  // parseModels only admits models that resolve to a canonical base model, so
  // these entries stay factored via base_model (provider-agnostic facts are
  // inherited from models/<provider>/<id>.toml). An existing authored
  // base_model wins so curated overrides are preserved.
  const canonical = existing?.base_model ?? resolveCanonicalBaseModel(model.id)!;
  const context = model.context_window ?? existing?.limit?.context ?? 0;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.max_output_tokens || existing?.limit?.output || context,
  };

  return factorBaseModel(
    canonical,
    {
      attachment,
      reasoning,
      temperature: true,
      tool_call: toolCall,
      structured_output: structuredOutput,
      status: existing?.status,
      interleaved: existing?.interleaved,
      limit,
      modalities: { input, output },
      cost,
    },
    limit,
    existing?.base_model === canonical ? existing.base_model_omit : undefined,
  );
}
