import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { generateModels } from "./generate.js";
import {
  AuthoredModel,
  AuthoredModelShape,
  ModelMetadata,
  Provider,
  type Model,
} from "./schema.js";
import {
  ProviderV2,
  type ApiV2,
  type CapabilitiesV2,
  type CostV2,
  type ExperimentalModeV2,
  type ExperimentalV2,
  type InputModalityV2,
  type LimitV2,
  type ModalitiesV2,
  type ModelV2,
  type OutputModalityV2,
  type ReasoningSupportV2,
  type ToolsSupportV2,
} from "./schema-v2.js";

// ---------------------------------------------------------------------------
// High-level catalog generation
// ---------------------------------------------------------------------------

export async function generateV2(
  providersDir: string,
): Promise<Record<string, ProviderV2>> {
  const modelsDir = path.join(path.dirname(providersDir), "models");
  const baseModels = await generateModels(modelsDir);

  const providers: Record<string, ProviderV2> = {};
  for await (const providerPath of scanTomls(providersDir, "*/provider.toml")) {
    const provider = await loadProviderV2(providerPath, baseModels);
    providers[provider.id] = provider;
  }

  return providers;
}

async function loadProviderV2(
  providerPath: string,
  baseModels: Record<string, ModelMetadata>,
): Promise<ProviderV2> {
  const providerDir = path.dirname(providerPath);
  const providerID = path.basename(providerDir);
  const rawProvider = { ...(await readToml(providerPath)), id: providerID, models: {} };
  const v1Provider = parseWithCause(Provider, rawProvider, {
    providerPath,
    toml: rawProvider,
  });

  const modelsDir = path.join(providerDir, "models");
  if (!existsSync(modelsDir)) {
    throw new Error(`Provider "${providerID}" has no models`, {
      cause: { providerPath },
    });
  }

  const models: Record<string, ModelV2> = {};
  for await (const modelPath of scanTomls(modelsDir, "**/*.toml")) {
    const model = await loadModelV2(modelPath, modelsDir, v1Provider, baseModels);
    models[model.id] = model;
  }

  if (Object.keys(models).length === 0) {
    throw new Error(`Provider "${providerID}" has no models`, {
      cause: { providerPath },
    });
  }

  return parseWithCause(
    ProviderV2,
    {
      id: v1Provider.id,
      name: v1Provider.name,
      doc: v1Provider.doc,
      env: v1Provider.env,
      models,
    },
    { providerPath, toml: rawProvider },
  );
}

async function loadModelV2(
  modelPath: string,
  modelsDir: string,
  provider: Provider,
  baseModels: Record<string, ModelMetadata>,
): Promise<ModelV2> {
  const modelID = modelIdFromPath(modelsDir, modelPath);
  const rawModel = { ...(await readToml(modelPath)), id: modelID };
  const resolved = resolveV1Model(rawModel, baseModels, modelPath);
  return toModelV2(resolved, provider);
}

// ---------------------------------------------------------------------------
// V1 -> V2 model transformation
// ---------------------------------------------------------------------------

export function toModelV2(model: Model, provider: Provider): ModelV2 {
  const cost = toCostV2(model.cost);
  const experimental = toExperimentalV2(model.experimental);

  return {
    id: model.id,
    ...(model.canonical_model_id !== undefined
      ? { canonical_id: model.canonical_model_id }
      : {}),
    type: model.type ?? "chat",
    name: model.name,
    description: model.description,
    ...(model.family !== undefined ? { family: model.family } : {}),
    open_weights: model.open_weights,
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    release_date: model.release_date,
    last_updated: model.last_updated,
    ...(model.status !== undefined ? { status: model.status } : {}),
    modalities: toModalitiesV2(model.modalities),
    capabilities: toCapabilitiesV2(model),
    limit: toLimitV2(model.limit),
    ...(cost !== undefined ? { cost } : {}),
    api: toApiV2(model, provider),
    ...(experimental !== undefined ? { experimental } : {}),
  };
}

function toModalitiesV2(modalities: Model["modalities"]): ModalitiesV2 {
  const normalize = (modality: string) =>
    modality === "pdf" ? "application/pdf" : modality;

  return {
    input: modalities.input.map(normalize) as InputModalityV2[],
    output: modalities.output.map(normalize) as OutputModalityV2[],
  };
}

function toCapabilitiesV2(model: Model): CapabilitiesV2 {
  const tools: ToolsSupportV2 = model.tool_call
    ? { supported: true }
    : { supported: false };

  return {
    tools,
    reasoning: toReasoningSupportV2(model),
    ...(model.structured_output !== undefined
      ? { structured_output: model.structured_output }
      : {}),
    ...(model.temperature !== undefined
      ? { temperature: model.temperature }
      : {}),
  };
}

function toReasoningSupportV2(model: Model): ReasoningSupportV2 {
  if (!model.reasoning) {
    return { supported: false };
  }

  const options = model.reasoning_options ?? [];
  const hasToggle = options.some((option) => option.type === "toggle");
  const effort = options.find((option) => option.type === "effort");
  const budget = options.find((option) => option.type === "budget_tokens");

  return {
    supported: true,
    ...(hasToggle ? { toggle: true } : {}),
    ...(effort !== undefined
      ? {
          effort: effort.values.map((value) =>
            value === null ? "default" : value,
          ),
        }
      : {}),
    ...(budget !== undefined
      ? {
          budget: {
            ...(budget.min !== undefined ? { min: budget.min } : {}),
            ...(budget.max !== undefined ? { max: budget.max } : {}),
          },
        }
      : {}),
  };
}

function toLimitV2(limit: Model["limit"]): LimitV2 {
  return {
    context: limit.context,
    ...(limit.input !== undefined ? { input: limit.input } : {}),
    output: limit.output,
  };
}

function toCostV2(cost: Model["cost"]): CostV2 | undefined {
  if (cost === undefined) return undefined;
  const { context_over_200k: _legacy, ...rest } = cost;
  return rest;
}

function toExperimentalV2(
  experimental: Model["experimental"],
): ExperimentalV2 | undefined {
  if (!experimental?.modes) return undefined;

  const modes = Object.fromEntries(
    Object.entries(experimental.modes).map(([name, mode]) => {
      const entry: ExperimentalModeV2 = {
        ...(mode.cost !== undefined ? { cost: toCostV2(mode.cost) } : {}),
        ...(mode.provider?.body !== undefined
          ? { body: mode.provider.body }
          : {}),
        ...(mode.provider?.headers !== undefined
          ? { headers: mode.provider.headers }
          : {}),
      };
      return [name, entry];
    }),
  );

  return { modes };
}

function toApiV2(_model: Model, _provider: Provider): ApiV2 {
  // Populated by API protocol mapping
  return {} as ApiV2;
}

// ---------------------------------------------------------------------------
// Base model inheritance & file helpers
// ---------------------------------------------------------------------------

const BaseModel = AuthoredModelShape.deepPartial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

function resolveV1Model(
  rawModel: Record<string, unknown>,
  baseModels: Record<string, ModelMetadata>,
  modelPath: string,
): Model {
  if (rawModel.base_model === undefined) {
    return parseWithCause(AuthoredModel, rawModel, {
      modelPath,
      toml: rawModel,
    });
  }

  const baseModel = parseWithCause(BaseModel, rawModel, {
    modelPath,
    toml: rawModel,
  });
  const merged = mergeBaseModel(baseModel, baseModels, modelPath);
  const authored = parseWithCause(AuthoredModel, merged, {
    modelPath,
    toml: merged,
  });

  return {
    ...authored,
    canonical_model_id: baseModel.base_model,
  };
}

function mergeBaseModel(
  model: z.infer<typeof BaseModel>,
  baseModels: Record<string, ModelMetadata>,
  modelPath: string,
): Record<string, unknown> {
  const base = baseModels[model.base_model];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${model.base_model}`, {
      cause: { modelPath, toml: model },
    });
  }

  const { base_model: _baseModel, base_model_omit: omit, ...overrides } = model;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(inheritableMetadata(base), overrides),
  );

  omitPaths(merged, omit ?? []);
  return merged;
}

function inheritableMetadata(model: ModelMetadata): Record<string, unknown> {
  const {
    id: _id,
    benchmarks: _benchmarks,
    license: _license,
    links: _links,
    weights: _weights,
    ...metadata
  } = model;

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function omitPaths(target: Record<string, unknown>, paths: string[]) {
  for (const rawPath of paths) {
    const parts = rawPath.split(".");
    const trail: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let current: Record<string, unknown> | undefined = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (!isPlainObject(next)) {
        current = undefined;
        break;
      }
      trail.push({ parent: current, key: part });
      current = next;
    }

    const leaf = parts.at(-1);
    if (!current || leaf === undefined || !(leaf in current)) continue;
    delete current[leaf];

    for (const { parent, key } of trail.reverse()) {
      const child = parent[key];
      if (isPlainObject(child) && Object.keys(child).length === 0) {
        delete parent[key];
      } else {
        break;
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scanTomls(cwd: string, pattern: string) {
  return new Bun.Glob(pattern).scan({
    cwd,
    absolute: true,
    followSymlinks: true,
  });
}

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  const mod = await import(filePath, { with: { type: "toml" } });
  return structuredClone(mod.default);
}

function modelIdFromPath(modelsDir: string, modelPath: string): string {
  return path
    .relative(modelsDir, modelPath)
    .split(path.sep)
    .join("/")
    .slice(0, -5);
}

function parseWithCause<T>(
  schema: z.ZodType<T>,
  data: unknown,
  cause: Record<string, unknown>,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    parsed.error.cause = cause;
    throw parsed.error;
  }
  return parsed.data;
}
