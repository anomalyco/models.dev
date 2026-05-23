import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { ModelFamilyValues } from "../../family.js";
import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";

const API_ENDPOINT = "https://router.requesty.ai/v1/models";
const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");
const modelFilesByProvider = new Map<string, Set<string>>();
const canonicalTomlByModel = new Map<string, Record<string, unknown>>();

const CANONICAL_PROVIDER_PREFIXES = {
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  minimaxi: "minimax",
  mistral: "mistral",
  moonshot: "moonshotai",
  openai: "openai",
  "openai-responses": "openai",
  xai: "xai",
  zai: "zai",
} as const;

export const RequestyModel = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  owned_by: z.string(),
  input_price: z.number().optional(),
  cached_price: z.number().optional(),
  caching_price: z.number().optional(),
  output_price: z.number().optional(),
  max_output_tokens: z.number(),
  context_window: z.number(),
  supports_caching: z.boolean(),
  supports_vision: z.boolean(),
  supports_computer_use: z.boolean(),
  supports_reasoning: z.boolean(),
  supports_image_generation: z.boolean(),
  supports_tool_calling: z.boolean(),
}).passthrough();

export const RequestyResponse = z.object({
  data: z.array(RequestyModel),
}).passthrough();

export type RequestyModel = z.infer<typeof RequestyModel>;

export const requesty = {
  id: "requesty",
  name: "Requesty",
  modelsDir: "providers/requesty/models",
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Requesty request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  },
  parseModels(raw) {
    return RequestyResponse.parse(raw).data.filter((model) => {
      if (model.id.includes("@")) return false;
      return true;
    });
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildRequestyModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<RequestyModel>;

function dateFromTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function price(value: number | undefined) {
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000_000_000) / 1_000_000
    : undefined;
}

type Modality = "text" | "audio" | "image" | "video" | "pdf";

function inputModalities(model: RequestyModel): Modality[] {
  const result: Modality[] = ["text"];
  if (model.supports_vision) {
    result.push("image");
    result.push("pdf");
  }
  return result;
}

function outputModalities(model: RequestyModel): Modality[] {
  const result: Modality[] = ["text"];
  if (model.supports_image_generation) {
    result.push("image");
  }
  return result;
}

function inferFamily(model: RequestyModel) {
  const target = model.id.toLowerCase();
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

export function buildRequestyModel(model: RequestyModel, existing: ExistingModel | undefined): SyncedModel {
  const input = inputModalities(model);
  const output = outputModalities(model);
  const prompt = price(model.input_price);
  const completion = price(model.output_price);
  const reasoning = model.supports_reasoning;
  const context = model.context_window;
  const family = inferFamily(model);
  const releaseDate = dateFromTimestamp(model.created);
  const familyValue = existing?.family ?? family;
  const attachment = input.some((value) => value !== "text");
  const toolCall = model.supports_tool_calling;
  const knowledge = existing?.knowledge;
  const cost = prompt !== undefined && completion !== undefined
    ? {
        input: prompt,
        output: completion,
        reasoning: existing?.cost?.reasoning,
        cache_read: price(model.cached_price),
        cache_write: price(model.caching_price),
        tiers: existing?.cost?.tiers,
      }
    : existing?.cost;
  const limit = {
    context,
    input: existing?.limit?.input,
    output: model.max_output_tokens || existing?.limit?.output || context,
  };
  const canonical = resolveCanonicalModel(model.id);

  if (canonical !== undefined) {
    return {
      extends: {
        from: canonical.from,
        omit: canonicalOmit(canonical.provider, canonical.modelID, cost, limit),
      },
      ...canonicalRuntimeOverrides(canonical.provider, canonical.modelID, {
        attachment,
        reasoning,
      }),
      temperature: existing?.temperature,
      tool_call: toolCall,
      structured_output: existing?.structured_output,
      status: existing?.status,
      interleaved: existing?.interleaved,
      cost,
      limit,
      modalities: { input, output },
    };
  }

  return {
    name: modelDisplayName(model),
    family: familyValue,
    release_date: existing?.release_date ?? releaseDate,
    last_updated: existing?.last_updated ?? releaseDate,
    attachment,
    reasoning,
    temperature: existing?.temperature,
    tool_call: toolCall,
    structured_output: existing?.structured_output,
    knowledge,
    open_weights: existing?.open_weights ?? false,
    status: existing?.status,
    interleaved: existing?.interleaved,
    cost,
    limit,
    modalities: { input, output },
  } satisfies SyncedFullModel;
}

function modelDisplayName(model: RequestyModel) {
  const id = model.id;
  const parts = id.split("/");
  const modelPart = parts.length > 1 ? parts.slice(1).join("/") : id;
  return modelPart
    .replace(/[-_]/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())
    .replace(/:.*$/, "");
}

function resolveCanonicalModel(requestyID: string) {
  const [prefix, ...modelParts] = requestyID.split("/");
  if (prefix === undefined || modelParts.length === 0) return undefined;

  const provider = CANONICAL_PROVIDER_PREFIXES[prefix as keyof typeof CANONICAL_PROVIDER_PREFIXES];
  if (provider === undefined) return undefined;

  const modelID = modelParts.join("/").replace(/:(?:free|flex|priority)$/, "");
  const candidates = canonicalCandidates(provider, modelID);
  const match = candidates.find((candidate) => {
    return canonicalModelExists(provider, candidate);
  });

  return match === undefined
    ? undefined
    : {
        from: `${provider}/${match}`,
        provider,
        modelID: match,
      };
}

function canonicalModelExists(provider: string, modelID: string) {
  let files = modelFilesByProvider.get(provider);
  if (files === undefined) {
    try {
      files = new Set(readdirSync(path.join(PROVIDERS_DIR, provider, "models")));
    } catch {
      files = new Set();
    }
    modelFilesByProvider.set(provider, files);
  }
  return files.has(`${modelID}.toml`);
}

function canonicalOmit(
  provider: string,
  modelID: string,
  cost: SyncedFullModel["cost"],
  limit: SyncedFullModel["limit"],
) {
  const toml = canonicalToml(provider, modelID);
  const omit = ["provider", "experimental"].filter((key) => toml[key] !== undefined);

  const baseCost = toml.cost;
  if (baseCost !== undefined && baseCost !== null && typeof baseCost === "object" && !Array.isArray(baseCost)) {
    if (cost === undefined) {
      omit.push("cost");
    } else {
      for (const key of ["reasoning", "cache_read", "cache_write", "input_audio", "output_audio", "tiers"] as const) {
        if ((baseCost as Record<string, unknown>)[key] !== undefined && cost[key] === undefined) {
          omit.push(`cost.${key}`);
        }
      }
    }
  }

  const baseLimit = toml.limit;
  if (
    baseLimit !== undefined &&
    baseLimit !== null &&
    typeof baseLimit === "object" &&
    !Array.isArray(baseLimit) &&
    (baseLimit as Record<string, unknown>).input !== undefined &&
    limit.input === undefined
  ) {
    omit.push("limit.input");
  }

  return omit.length > 0 ? omit : undefined;
}

function canonicalRuntimeOverrides(
  provider: string,
  modelID: string,
  values: Pick<SyncedFullModel, "attachment" | "reasoning">,
) {
  const toml = canonicalToml(provider, modelID);
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value !== undefined && toml[key] !== value),
  );
}

function canonicalToml(provider: string, modelID: string) {
  const key = `${provider}/${modelID}`;
  let toml = canonicalTomlByModel.get(key);
  if (toml === undefined) {
    const filePath = path.join(PROVIDERS_DIR, provider, "models", `${modelID}.toml`);
    toml = Bun.TOML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    canonicalTomlByModel.set(key, toml);
  }
  return toml;
}

function canonicalCandidates(provider: string, modelID: string) {
  const candidates = [modelID];

  if (provider === "anthropic") {
    candidates.push(modelID.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/, "$1-$2"));
    candidates.push(modelID.replace(/^claude-3\.5-/, "claude-3-5-"));
  }

  if (provider === "openai") {
    candidates.push(modelID.replace(/-chat$/, ""));
  }

  if (provider === "mistral") {
    candidates.push(modelID.replace(/-latest$/, ""));
    candidates.push(modelID.replace(/-\d{4}$/, ""));
  }

  if (provider === "minimax") {
    candidates.push(modelID.replace(/^minimax-m/, "MiniMax-M"));
    candidates.push(modelID.replace(/^MiniMax-M/, "minimax-m"));
  }

  return [...new Set(candidates)];
}
