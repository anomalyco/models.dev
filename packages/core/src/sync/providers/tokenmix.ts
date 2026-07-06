import { z } from "zod";
import type { SyncProvider, SyncedFullModel } from "../index.js";

const API_ENDPOINT = "https://api.tokenmix.ai/api/models";

export const TokenMixModel = z
  .object({
    model_id: z.string(),
    name: z.string(),
    context_length: z.number(),
    max_output: z.number(),
    input_price: z.number(),
    output_price: z.number(),
    support_reasoning: z.boolean(),
    support_vision: z.boolean(),
    support_tools: z.boolean(),
    support_structured_output: z.boolean(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    release_date: z.string().nullable().optional(),
  })
  .passthrough();

export const TokenMixResponse = z
  .object({
    code: z.number(),
    data: z.array(TokenMixModel),
  })
  .passthrough();

export type TokenMixModel = z.infer<typeof TokenMixModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function toModalities(values: string[]): Modality[] {
  const allowed = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  const mapped = values
    .map((v) => v.toLowerCase())
    .filter((v): v is Modality => allowed.has(v as Modality));
  return [...new Set(mapped.length > 0 ? mapped : (["text"] as Modality[]))];
}

function toDate(value: string | null | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export const tokenmix = {
  id: "tokenmix",
  name: "TokenMix",
  modelsDir: "providers/tokenmix/models",

  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`TokenMix request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },

  parseModels(raw: unknown) {
    const parsed = TokenMixResponse.parse(raw);
    return parsed.data.filter((m) => m.context_length > 0);
  },

  translateModel(model: TokenMixModel) {
    const releaseDate = toDate(model.release_date);
    const inputMods = toModalities(model.input_modalities);
    const outputMods = toModalities(model.output_modalities);

    const result: SyncedFullModel = {
      name: model.name,
      attachment: model.support_vision,
      reasoning: model.support_reasoning,
      ...(model.support_reasoning ? { reasoning_options: [] } : {}),
      tool_call: model.support_tools,
      ...(model.support_structured_output ? { structured_output: true } : {}),
      release_date: releaseDate,
      last_updated: releaseDate,
      open_weights: false,
      modalities: {
        input: inputMods,
        output: outputMods,
      },
      limit: {
        context: model.context_length,
        output: model.max_output,
      },
      cost: {
        input: round6(model.input_price),
        output: round6(model.output_price),
      },
    };

    return {
      id: model.model_id,
      model: result,
    };
  },
} satisfies SyncProvider<TokenMixModel>;
