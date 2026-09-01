import { z } from "zod";

import { inferKimiFamily, ModelFamilyValues } from "../../family.js";
import type { SyncProvider } from "../index.js";

// The public catalog needs no key, and `include` is what turns on the pricing
// and modality blocks this sync depends on.
const API_ENDPOINT = "https://api.aimlapi.com/v1/models?include=pricing,modalities";

// AI/ML API serves one id under several endpoint types — a model can be both a
// chat model and, say, an image model. Only the chat surface belongs here.
const CHAT_COMPLETIONS_TYPE = "openai/chat-completions";

const PricingUnit = z.object({
  name: z.string().nullish(),
  content: z.string().nullish(),
  origin: z.string().nullish(),
  price: z.number().nullish(),
  per: z.number().nullish(),
}).passthrough();

const Info = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  developer: z.string().nullish(),
  releasedAt: z.string().nullish(),
  contextLength: z.number().int().nonnegative().nullish(),
  outputMax: z.number().int().nonnegative().nullish(),
}).passthrough();

export const AimlapiModel = z.object({
  id: z.string().min(1),
  type: z.string().nullish(),
  info: Info.nullish(),
  modalities: z.object({
    input: z.array(z.string()).nullish(),
    output: z.array(z.string()).nullish(),
  }).passthrough().nullish(),
  pricing: z.object({
    units: z.array(PricingUnit).nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const AimlapiResponse = z.object({
  data: z.array(AimlapiModel).min(1),
}).passthrough();

export type AimlapiModel = z.infer<typeof AimlapiModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const MODALITIES = new Set<string>(["text", "audio", "image", "video", "pdf"]);

function normalizeModalities(values: readonly string[] | null | undefined): Modality[] {
  const seen = new Set<Modality>();
  for (const value of values ?? []) {
    const normalized = value.toLowerCase();
    if (MODALITIES.has(normalized)) seen.add(normalized as Modality);
  }
  if (seen.size === 0) seen.add("text");
  return [...seen];
}

/**
 * Prices are quoted as `price` per `per` tokens; models.dev stores dollars per
 * million. The unit discriminator is `origin`, not `measure`: provided is
 * input, generated is output, cached is a cache read. Only text token charges
 * are taken — a model's image or audio units are a different surface.
 */
function perMillion(
  units: readonly z.infer<typeof PricingUnit>[],
  origin: string,
): number | undefined {
  const unit = units.find(
    (candidate) =>
      candidate.name === "token" && candidate.content === "text" && candidate.origin === origin,
  );
  if (!unit || unit.price == null || !unit.per) return undefined;
  return (unit.price / unit.per) * 1_000_000;
}

function positive(value: number | null | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

/**
 * `family` is a closed vocabulary of model families (`gpt`, `claude`, `o`, …),
 * not the vendor prefix — matching on the prefix produces values the schema
 * rejects. Longest match first so `claude-sonnet` wins over `claude`, and `o`
 * only matches when a digit follows it, as in `o3`.
 */
function inferFamily(id: string, name: string): string | undefined {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;

  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") {
        return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      }
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}

function releaseDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1];
}

export const aimlapi = {
  id: "aimlapi",
  name: "AI/ML API",
  modelsDir: "providers/aimlapi/models",
  // The catalog turns over quickly and lists far more than the chat surface, so
  // a local model missing from one response is not proof that it is gone.
  deleteMissing: false,
  sourceID(model) {
    return model.type === CHAT_COMPLETIONS_TYPE ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AI/ML API chat models were skipped because the catalog does not yet publish a description or an output limit for them, both of which this schema requires.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local AI/ML API models were absent from the catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AI/ML API request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return AimlapiResponse.parse(raw).data;
  },
  translateModel(model, context) {
    // Chat only. The same id may also appear under an image or audio type;
    // those entries are a different product and are skipped silently.
    if (model.type !== CHAT_COMPLETIONS_TYPE) return undefined;

    const existing = context.existing(model.id);
    const info = model.info ?? {};
    const units = model.pricing?.units ?? [];

    const output = normalizeModalities(model.modalities?.output);
    // A chat model whose output is not purely text is a media model riding the
    // chat protocol, and does not belong in a chat catalog.
    if (output.length !== 1 || output[0] !== "text") return undefined;

    const input = normalizeModalities(model.modalities?.input);
    const contextLimit = positive(info.contextLength) ?? existing?.limit?.context;
    const outputLimit = positive(info.outputMax) ?? existing?.limit?.output;
    const description = info.description?.trim() || existing?.description;

    // The schema requires a description and an output limit. Where the catalog
    // publishes neither and no local value exists, the model is skipped rather
    // than filled in: an invented description or a guessed limit would be worse
    // than an absent entry, and skippedNotice makes the gap visible.
    if (!description || outputLimit === undefined) return undefined;

    return {
      id: model.id,
      model: {
        name: info.name?.trim() || existing?.name || model.id,
        description,
        family: existing?.family ?? inferFamily(model.id, info.name?.trim() ?? ""),
        release_date: releaseDate(info.releasedAt) ?? existing?.release_date,
        last_updated: releaseDate(info.releasedAt) ?? existing?.last_updated,
        // The catalog does not report these capabilities. A value already in the
        // repo was put there by someone who checked; a default here would only
        // overwrite that with a guess.
        attachment: existing?.attachment ?? input.length > 1,
        reasoning: existing?.reasoning ?? false,
        tool_call: existing?.tool_call ?? false,
        structured_output: existing?.structured_output ?? false,
        open_weights: existing?.open_weights ?? false,
        cost: {
          input: perMillion(units, "provided") ?? existing?.cost?.input,
          output: perMillion(units, "generated") ?? existing?.cost?.output,
          cache_read: perMillion(units, "cached") ?? existing?.cost?.cache_read,
        },
        limit: {
          context: contextLimit,
          input: contextLimit,
          output: outputLimit,
        },
        modalities: {
          input,
          output,
        },
      },
    };
  },
} satisfies SyncProvider<AimlapiModel>;
