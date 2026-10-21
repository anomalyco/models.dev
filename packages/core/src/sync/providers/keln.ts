import { z } from "zod";

import { AuthoredModelShape, ReasoningOption } from "../../schema.js";
import type { SyncProvider } from "../index.js";
import { perTokenToPerMillion } from "./inceptron.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = "https://api.keln.ai/v1/models";
const PerTokenPrice = z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/);

export const KelnModel = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive(),
  input_modalities: z.array(z.string()).min(1),
  // USD per token as decimal strings (OpenRouter's shape).
  pricing: z.object({
    prompt: PerTokenPrice,
    completion: PerTokenPrice,
    input_cache_read: PerTokenPrice.nullish(),
  }).passthrough(),
  // OpenRouter's shape: `supported_efforts` lists the reasoning_effort values that change
  // something on this model, "none" first when thinking can be switched off; it is absent
  // on models that only switch on and off. `mandatory` is true when nothing switches it off.
  reasoning: z.object({
    mandatory: z.boolean(),
    supported_efforts: z.array(z.string()).nullish(),
    default_effort: z.string().nullish(),
  }).passthrough().nullish(),
}).passthrough();

export const KelnResponse = z.object({
  object: z.literal("list"),
  data: z.array(KelnModel).min(1, "Keln returned an empty catalog; refusing to remove local models"),
}).passthrough().refine(
  (response) => new Set(response.data.map((model) => model.id)).size === response.data.length,
  "Keln returned duplicate model IDs",
);

export type KelnModel = z.infer<typeof KelnModel>;

// Keln names models by their Hugging Face organisation; these two differ from the
// metadata labs' prefixes. Every other organisation resolves as published.
const LAB_PREFIXES: Record<string, string> = { "deepseek-ai": "deepseek", minimaxai: "minimax" };

export function kelnBaseModel(id: string) {
  const [prefix = "", ...rest] = id.split("/");
  return resolveModelMetadataBaseModel([LAB_PREFIXES[prefix] ?? prefix, ...rest].join("/"));
}

/** Reasoning controls exactly as Keln publishes them; undefined when missing or unknown. */
export function kelnReasoningControls(reasoning: KelnModel["reasoning"]) {
  if (reasoning == null) return undefined;
  const efforts = reasoning.supported_efforts ?? [];
  if (efforts.length > 0) {
    const effort = ReasoningOption.safeParse({ type: "effort", values: efforts });
    if (!effort.success) return undefined;
    return { options: [effort.data], header: `# Effort: top-level reasoning_effort = ${efforts.join("|")}.\n` };
  }
  if (reasoning.mandatory) {
    return { options: [], header: "# Always on: no request field switches thinking off.\n" };
  }
  const header = reasoning.default_effort === "none"
    ? "# Toggle: top-level reasoning_effort; thinking is off unless a level is sent (\"none\" keeps it off).\n"
    : "# Toggle: top-level reasoning_effort = \"none\" turns thinking off; it is on otherwise.\n";
  return { options: [{ type: "toggle" as const }], header };
}

export const keln = {
  id: "keln",
  name: "Keln",
  modelsDir: "providers/keln/models",
  preserveBaseModels: false,
  preserveDescriptions: false,
  authoritativeHeaders: true,
  // Rows without a lab base or published controls are reported and keep their files.
  trackMissingModels: false,
  fetchModels: fetchKelnModels,
  parseModels(raw) {
    return KelnResponse.parse(raw).data;
  },
  sourceID(model) {
    return model.id;
  },
  missingModelID(model) {
    return model.id;
  },
  skippedNotice(ids) {
    return ids.length === 0 ? [] : [
      `Keln models awaiting a lab base or published reasoning controls: ${ids.join(", ")}`,
    ];
  },
  translateModel(model, context) {
    const baseModel = context.authored(model.id)?.base_model ?? kelnBaseModel(model.id);
    if (baseModel === undefined) return undefined;
    const base = modelMetadata(baseModel);
    const reasoning = model.reasoning != null;
    const controls = kelnReasoningControls(model.reasoning);
    // A thinking model needs its controls published; never invent them.
    if ((reasoning && controls === undefined) || (!reasoning && base.reasoning === true)) return undefined;

    const schema = AuthoredModelShape.shape.modalities;
    const input = model.input_modalities.flatMap((value) => {
      const parsed = schema.shape.input.element.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    if (!input.includes("text")) return undefined;

    const limit = { context: model.context_length };
    const cacheRead = model.pricing.input_cache_read;
    const translated = factorBaseModel(baseModel, {
      attachment: input.some((value) => value !== "text"),
      reasoning,
      reasoning_options: controls?.options,
      cost: {
        input: perTokenToPerMillion(model.pricing.prompt),
        output: perTokenToPerMillion(model.pricing.completion),
        cache_read: cacheRead == null ? undefined : perTokenToPerMillion(cacheRead),
      },
      limit,
      modalities: { input, output: ["text"] },
    }, limit);

    return {
      id: model.id,
      model: translated,
      header: "# Generated by bun models:sync keln from https://api.keln.ai/v1/models.\n"
        + "# Prices are USD per million tokens; lab facts are inherited via base_model.\n"
        + (controls?.header ?? ""),
    };
  },
} satisfies SyncProvider<KelnModel>;

export async function fetchKelnModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(API_ENDPOINT, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Keln catalog request failed: ${response.status} ${response.statusText}`);
  }
  return KelnResponse.parse(await response.json());
}
