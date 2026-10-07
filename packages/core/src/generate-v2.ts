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
  type ExperimentalModeV2,
  type InputModalityV2,
  type ModelV2,
  type OutputModalityV2,
  type ReasoningSupportV2,
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
    const modelID = path
      .relative(modelsDir, modelPath)
      .split(path.sep)
      .join("/")
      .slice(0, -5);
    const rawModel = { ...(await readToml(modelPath)), id: modelID };
    const resolved = resolveV1Model(rawModel, baseModels, modelPath);
    models[modelID] = toModelV2(resolved, v1Provider);
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

// ---------------------------------------------------------------------------
// V1 -> V2 model transformation
// ---------------------------------------------------------------------------

export function toModelV2(model: Model, provider: Provider): ModelV2 {
  const normalizeModality = (m: string) =>
    m === "pdf" ? "application/pdf" : m;
  const stripLegacyCost = ({
    context_over_200k: _legacy,
    ...cost
  }: NonNullable<Model["cost"]>) => cost;

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
    modalities: {
      input: model.modalities.input.map(normalizeModality) as InputModalityV2[],
      output: model.modalities.output.map(normalizeModality) as OutputModalityV2[],
    },
    capabilities: {
      tools: model.tool_call ? { supported: true } : { supported: false },
      reasoning: toReasoningSupportV2(model),
      ...(model.structured_output !== undefined
        ? { structured_output: model.structured_output }
        : {}),
      ...(model.temperature !== undefined
        ? { temperature: model.temperature }
        : {}),
    },
    limit: { ...model.limit },
    ...(model.cost !== undefined ? { cost: stripLegacyCost(model.cost) } : {}),
    api: toApiV2(model, provider),
    ...(model.experimental?.modes
      ? {
          experimental: {
            modes: Object.fromEntries(
              Object.entries(model.experimental.modes).map(([name, mode]) => {
                const entry: ExperimentalModeV2 = {
                  ...(mode.cost !== undefined
                    ? { cost: stripLegacyCost(mode.cost) }
                    : {}),
                  ...(mode.provider?.body !== undefined
                    ? { body: mode.provider.body }
                    : {}),
                  ...(mode.provider?.headers !== undefined
                    ? { headers: mode.provider.headers }
                    : {}),
                };
                return [name, entry];
              }),
            ),
          },
        }
      : {}),
  };
}

function toReasoningSupportV2(model: Model): ReasoningSupportV2 {
  if (!model.reasoning) return { supported: false };

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
  const base = baseModels[baseModel.base_model];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${baseModel.base_model}`, {
      cause: { modelPath, toml: baseModel },
    });
  }

  const {
    id: _id,
    benchmarks: _benchmarks,
    license: _license,
    links: _links,
    weights: _weights,
    ...inheritable
  } = base;
  const baseFields = Object.fromEntries(
    Object.entries(inheritable).filter(([, value]) => value !== undefined),
  );
  const {
    base_model: _baseModel,
    base_model_omit: omit,
    ...overrides
  } = baseModel;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(baseFields, overrides),
  );
  omitPaths(merged, omit ?? []);

  const authored = parseWithCause(AuthoredModel, merged, {
    modelPath,
    toml: merged,
  });

  return {
    ...authored,
    canonical_model_id: baseModel.base_model,
  };
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
