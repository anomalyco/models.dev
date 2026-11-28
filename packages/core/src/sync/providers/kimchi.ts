import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SyncProvider, SyncedV2Model } from "../index.js";

export const KIMCHI_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/model-prices";
const catalogRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

const Price = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]).transform(Number);
const ModelPrice = z.object({
  model: z.string().min(1),
  displayName: z.string().min(1),
  type: z.string(),
  inputModalities: z.array(z.enum(["text", "image"])),
  toolCallSupported: z.boolean(),
  reasoningSupported: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputPriceUsd: Price,
  outputPriceUsd: Price,
  cachedInputPriceUsd: Price.optional(),
  status: z.enum(["MODEL_STATUS_ACTIVE", "MODEL_STATUS_DEPRECATED"]),
  sunsetTime: z.string().datetime().nullable(),
  replacementModel: z.string(),
});
export const KimchiResponse = z.object({
  modelPrices: z.array(ModelPrice).min(1),
}).refine((r) => new Set(r.modelPrices.map((m) => m.model)).size === r.modelPrices.length, "duplicate model IDs");
export type KimchiModel = z.infer<typeof ModelPrice>;

const baseModels: Record<string, string> = {
  "deepseek-v4-flash-0731": "deepseek/deepseek-v4-flash-0731",
  "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017": "deepseek/deepseek-v4.1-flash-1017",
  "gemma-4-31b": "google/gemma-4-31b-it",
  "glm-5.3": "zhipuai/glm-5.3",
  "glm-5.3-flash": "zhipuai/glm-5.3-flash",
  "kimi-k3": "moonshotai/kimi-k3",
  "kimi-k3.1-pro": "moonshotai/kimi-k3.1-pro",
  "minimax-m3": "minimax/MiniMax-M3",
  "minimax-m3.1-flash": "minimax/MiniMax-M3.1-Flash",
  "muse-spark-open-fp4": "meta/muse-spark-open",
};

type Reasoning = { supported: boolean; effort?: string[]; toggle?: boolean };
const nativeEffort = ["low", "high", "max"];
const deepseekReasoning = { supported: true, effort: ["none", ...nativeEffort] };
const reasoningControls: Record<string, Reasoning> = {
  "deepseek-v4-flash-0731": deepseekReasoning,
  "deepseek-v4.1-flash": deepseekReasoning,
  "deepseek-v4.1-flash-1017": deepseekReasoning,
  "gemma-4-31b": { supported: true, toggle: true },
  "glm-5.3": { supported: true, effort: nativeEffort },
  "glm-5.3-flash": { supported: true, effort: nativeEffort },
  "kimi-k3": { supported: true, effort: nativeEffort },
  "kimi-k3.1-pro": { supported: true, effort: nativeEffort },
  "minimax-m3": { supported: true, toggle: true },
  "minimax-m3.1-flash": { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] },
  "muse-spark-open-fp4": { supported: true, effort: ["low", "medium", "high", "xhigh"] },
};

function labDocument(baseModel: string, root: string) {
  return Bun.TOML.parse(readFileSync(path.join(root, "models", `${baseModel}.toml`), "utf8")) as Record<string, any>;
}

function pricePerMillion(price: number) {
  return Number((price * 1_000_000).toPrecision(12));
}

export async function fetchKimchiModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(KIMCHI_ENDPOINT, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Kimchi catalog request failed: ${response.status}`);
  const parsed = KimchiResponse.parse(await response.json());
  if (parsed.modelPrices.length < 2) {
    throw new Error("Kimchi returned an undersized catalog; refusing to delete models from a truncated response");
  }
  return parsed;
}

// Sync only fields the public feed owns. Host-authored protocol details survive;
// identical facts remain inherited from the model's lab entry.
export const kimchi = {
  id: "kimchi",
  name: "Kimchi Inference",
  modelsDir: "providers/kimchi/models",
  inheritPredecessorCapabilities: false,
  authoritativeHeaders: true,
  deleteMissing: false,
  trackMissingModels: true,
  skipCreates: true,
  fetchModels: fetchKimchiModels,
  parseModels(raw: unknown) {
    return KimchiResponse.parse(raw).modelPrices;
  },
  missingModelID(model: KimchiModel) {
    return model.type === "chat" ? model.model : undefined;
  },
  translateModel(model: KimchiModel, context): SyncedV2Model | undefined {
    const base_model = baseModels[model.model];
    if (model.type !== "chat" || !base_model) return undefined;
    const root = context.catalogRoot ?? catalogRoot;
    const lab = labDocument(base_model, root);
    const images = (lab.modalities?.input ?? []).filter((value: string) => value.startsWith("image/") || value === "image");
    if (!model.reasoningSupported) throw new Error(`Unexpected non-reasoning catalog model ${model.model}`);
    const reasoning = reasoningControls[model.model];
    if (!reasoning) throw new Error(`Missing Kimchi reasoning controls for ${model.model}`);
    const previous = (context.v2?.(model.model) ?? {}) as Record<string, any>;
    const tools = { ...previous.capabilities?.tools, supported: model.toolCallSupported };
    const labLimit = lab.limit as { context?: number; output?: number } | undefined;
    const output = Math.min(model.maxOutputTokens, labLimit?.output ?? model.maxOutputTokens);
    const contextWindow = Math.min(model.contextWindow, labLimit?.context ?? model.contextWindow);
    const v2: Record<string, any> = {
      ...previous,
      schema: 2,
      base_model,
      name: model.displayName,
      status: model.status === "MODEL_STATUS_DEPRECATED" ? "deprecated" : previous.status,
      capabilities: {
        ...previous.capabilities,
        tools,
        reasoning,
        cache: previous.capabilities?.cache?.explicit
          ? previous.capabilities.cache
          : model.cachedInputPriceUsd == null
            ? undefined
            : previous.capabilities?.cache ?? { implicit: true },
        ...(["deepseek/", "zhipuai/"].some((lab) => base_model.startsWith(lab)) ? { top_k: false } : {}),
      },
      limit: { ...previous.limit, context: contextWindow, output },
      cost: {
        ...previous.cost,
        text: {
          ...previous.cost?.text,
          input: {
            ...Object.fromEntries(Object.entries(previous.cost?.text?.input ?? {}).filter(([key]) => key !== "cache")),
            price: pricePerMillion(model.inputPriceUsd),
            ...(model.cachedInputPriceUsd == null ? {} : { cache: { ...previous.cost?.text?.input?.cache, read: pricePerMillion(model.cachedInputPriceUsd) } }),
          },
          output: { ...previous.cost?.text?.output, price: pricePerMillion(model.outputPriceUsd) },
        },
      },
      modalities: {
        input: model.inputModalities.includes("image") ? ["text", ...images] : ["text"],
        output: ["text"],
      },
      api: {
        ...previous.api,
        "chat-completions": {
          ...previous.api?.["chat-completions"],
          compatibility: {
            ...previous.api?.["chat-completions"]?.compatibility,
            reasoning_field: "reasoning_content",
          },
        },
      },
    };
    for (const key of ["name", "description", "family", "open_weights", "knowledge", "release_date", "last_updated"]) {
      if (JSON.stringify(v2[key]) === JSON.stringify(lab[key])) delete v2[key];
    }
    for (const key of ["context", "output"]) {
      if (v2.limit[key] === lab.limit?.[key]) delete v2.limit[key];
    }
    if (Object.keys(v2.limit).length === 0) delete v2.limit;
    if (JSON.stringify(v2.modalities) === JSON.stringify(lab.modalities)) delete v2.modalities;
    for (const key of ["tools", "temperature", "top_p", "top_k"]) {
      if (JSON.stringify(v2.capabilities[key]) === JSON.stringify(lab.capabilities?.[key])) delete v2.capabilities[key];
    }
    if (v2.status === undefined) delete v2.status;
    return {
      id: model.model,
      v2,
      header: `# Sync: ${KIMCHI_ENDPOINT}; prices are USD per million tokens.\n# Feed owns roster, cap bounds, tool/reasoning support and image input kinds.\n${reasoning.effort ? `# Effort: top-level reasoning_effort=${reasoning.effort.join("|")}; side channel: reasoning_content.\n` : ""}${reasoning.toggle ? `# Toggle: ${model.model === "minimax-m3" ? 'thinking.type = adaptive|disabled' : 'reasoning_effort = none'}.\n` : ""}# Model-specific controls verified 2026-11-25.\n`,
    };
  },
} satisfies SyncProvider<KimchiModel>;
