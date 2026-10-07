import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import {
  Provider,
  AuthoredModel,
  AuthoredModelShape,
  ModelMetadata,
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
import { generateModels } from "./generate.js";

const BaseModel = AuthoredModelShape.deepPartial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

export async function generateV2(
  directory: string,
): Promise<Record<string, ProviderV2>> {
  const modelsDirectory = path.join(path.dirname(directory), "models");
  const models = await generateModels(modelsDirectory);

  return generateProvidersV2(directory, models);
}

async function generateProvidersV2(
  directory: string,
  models: Record<string, ModelMetadata>,
): Promise<Record<string, ProviderV2>> {
  const result: Record<string, ProviderV2> = {};

  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => structuredClone(mod.default));
    toml.id = providerID;
    toml.models = {};

    const v1Provider = Provider.safeParse(toml);
    if (!v1Provider.success) {
      v1Provider.error.cause = { providerPath, toml };
      throw v1Provider.error;
    }

    const modelsPath = path.join(directory, providerID, "models");
    if (!existsSync(modelsPath)) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }

    const v2Models: Record<string, ModelV2> = {};
    for await (const modelPath of new Bun.Glob("**/*.toml").scan({
      cwd: modelsPath,
      absolute: true,
      followSymlinks: true,
    })) {
      const modelID = path
        .relative(modelsPath, modelPath)
        .split(path.sep)
        .join("/")
        .slice(0, -5);
      const modelToml = await import(modelPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => structuredClone(mod.default));
      modelToml.id = modelID;

      if (modelToml.base_model !== undefined) {
        const baseModel = BaseModel.safeParse(modelToml);
        if (!baseModel.success) {
          baseModel.error.cause = { modelPath, toml: modelToml };
          throw baseModel.error;
        }

        const merged = mergeBaseModel(baseModel.data, models, modelPath);
        const authored = AuthoredModel.safeParse(merged);
        if (!authored.success) {
          authored.error.cause = { modelPath, toml: merged };
          throw authored.error;
        }

        v2Models[modelID] = toModelV2(
          {
            ...authored.data,
            canonical_model_id: baseModel.data.base_model,
          },
          v1Provider.data,
        );
        continue;
      }

      const authored = AuthoredModel.safeParse(modelToml);
      if (!authored.success) {
        authored.error.cause = { modelPath, toml: modelToml };
        throw authored.error;
      }

      v2Models[modelID] = toModelV2(authored.data, v1Provider.data);
    }

    if (Object.keys(v2Models).length === 0) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }

    const providerV2 = ProviderV2.safeParse({
      id: v1Provider.data.id,
      name: v1Provider.data.name,
      doc: v1Provider.data.doc,
      env: v1Provider.data.env,
      models: v2Models,
    });
    if (!providerV2.success) {
      providerV2.error.cause = { providerPath, toml };
      throw providerV2.error;
    }

    result[providerID] = providerV2.data;
  }

  return result;
}

function mergeBaseModel(
  model: z.infer<typeof BaseModel>,
  models: Record<string, ModelMetadata>,
  modelPath: string,
) {
  const base = models[model.base_model];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${model.base_model}`, {
      cause: { modelPath, toml: model },
    });
  }

  const { base_model: _baseModel, base_model_omit: omit, ...overrides } = model;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(inheritableModelMetadata(base), overrides),
  );

  applyOmit(merged, omit ?? []);
  return merged;
}

function inheritableModelMetadata(model: ModelMetadata) {
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

function applyOmit(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const omit of paths) {
    const parts = omit.split(".");
    const parents: Array<{
      value: Record<string, unknown>;
      key: string;
    }> = [];
    let current = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        continue omitLoop;
      }
      parents.push({ value: current, key: part });
      current = next as Record<string, unknown>;
    }

    const lastPart = parts.at(-1);
    if (lastPart === undefined || !(lastPart in current)) {
      continue;
    }

    delete current[lastPart];

    for (let index = parents.length - 1; index >= 0; index--) {
      const parent = parents[index];
      if (parent === undefined) continue;
      const value = parent.value[parent.key];
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        break;
      }
      delete parent.value[parent.key];
    }
  }
}

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
  return {
    input: modalities.input.map(
      (modality): InputModalityV2 =>
        modality === "pdf" ? "application/pdf" : modality,
    ),
    output: modalities.output.map(
      (modality): OutputModalityV2 =>
        modality === "pdf" ? "application/pdf" : modality,
    ),
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
  const effortOption = options.find((option) => option.type === "effort");
  const budgetOption = options.find(
    (option) => option.type === "budget_tokens",
  );

  return {
    supported: true,
    ...(hasToggle ? { toggle: true } : {}),
    ...(effortOption !== undefined
      ? {
          effort: effortOption.values.map((value) =>
            value === null ? "default" : value,
          ),
        }
      : {}),
    ...(budgetOption !== undefined
      ? {
          budget: {
            ...(budgetOption.min !== undefined ? { min: budgetOption.min } : {}),
            ...(budgetOption.max !== undefined ? { max: budgetOption.max } : {}),
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
  if (experimental === undefined) return undefined;
  const modes = experimental.modes
    ? Object.fromEntries(
        Object.entries(experimental.modes).map(([modeName, mode]) => {
          const entry: ExperimentalModeV2 = {
            ...(mode.cost !== undefined ? { cost: toCostV2(mode.cost) } : {}),
            ...(mode.provider?.body !== undefined
              ? { body: mode.provider.body }
              : {}),
            ...(mode.provider?.headers !== undefined
              ? { headers: mode.provider.headers }
              : {}),
          };
          return [modeName, entry];
        }),
      )
    : undefined;

  return {
    ...(modes !== undefined ? { modes } : {}),
  };
}

function toApiV2(_model: Model, _provider: Provider): ApiV2 {
  // Populated by API protocol mapping
  return {} as ApiV2;
}
