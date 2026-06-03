import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import {
  Provider,
  Model,
  AuthoredModel,
  AuthoredModelShape,
  ModelMetadata,
} from "./schema.js";

const BaseModel = AuthoredModelShape
  .partial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

export async function generateCatalog(directory: string) {
  const models = await generateModels(path.join(directory, "models"));
  const providers = await generateProviders(
    path.join(directory, "providers"),
    models,
  );

  return { models, providers };
}

export async function generateModels(directory: string) {
  const result: Record<string, ModelMetadata> = {};
  if (!existsSync(directory)) return result;

  for await (const modelPath of new Bun.Glob("**/*.toml").scan({
    cwd: directory,
    absolute: true,
    followSymlinks: true,
  })) {
    const modelID = path.relative(directory, modelPath).slice(0, -5);
    const toml = await import(modelPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = modelID;

    const model = ModelMetadata.safeParse(toml);
    if (!model.success) {
      model.error.cause = { modelPath, toml };
      throw model.error;
    }
    result[modelID] = model.data;
  }

  return result;
}

export async function generate(directory: string) {
  const modelsDirectory = path.join(path.dirname(directory), "models");
  const models = await generateModels(modelsDirectory);

  return generateProviders(directory, models);
}

async function generateProviders(
  directory: string,
  models: Record<string, ModelMetadata>,
) {
  const result: Record<string, Provider> = {};
  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = providerID;
    toml.models = {};
    const provider = Provider.safeParse(toml);
    if (!provider.success) {
      provider.error.cause = { providerPath, toml };
      throw provider.error;
    }

    const modelsPath = path.join(directory, providerID, "models");
    for await (const modelPath of new Bun.Glob("**/*.toml").scan({
      cwd: modelsPath,
      absolute: true,
      followSymlinks: true,
    })) {
      const modelID = path.relative(modelsPath, modelPath).slice(0, -5);
      const toml = await import(modelPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => mod.default);
      toml.id = modelID;
      if (toml.base_model !== undefined) {
        const baseModel = BaseModel.safeParse(toml);
        if (!baseModel.success) {
          baseModel.error.cause = { modelPath, toml };
          throw baseModel.error;
        }

        const merged = mergeBaseModel(baseModel.data, models, modelPath);
        const model = AuthoredModel.safeParse(merged);
        if (!model.success) {
          model.error.cause = { modelPath, toml: merged };
          throw model.error;
        }
        provider.data.models[modelID] = normalizeModelCost(model.data);
        continue;
      }
      const model = AuthoredModel.safeParse(toml);
      if (!model.success) {
        model.error.cause = { modelPath, toml };
        throw model.error;
      }
      provider.data.models[modelID] = normalizeModelCost(model.data);
    }
    result[providerID] = provider.data;
  }

  const nameToProviderID = new Map<string, string>();
  for (const provider of Object.values(result)) {
    const nameKey = provider.name.toLowerCase();
    const existingID = nameToProviderID.get(nameKey);
    if (existingID !== undefined) {
      throw new Error(
        `Duplicate provider name "${provider.name}" used by both "${existingID}" and "${provider.id}". Provider names must be unique.`,
        { cause: { providerIDs: [existingID, provider.id], name: provider.name } },
      );
    }
    nameToProviderID.set(nameKey, provider.id);
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
      const value = parent?.value[parent.key];
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

function normalizeModelCost(model: z.infer<typeof AuthoredModel>): Model {
  return normalizeCost(model) as Model;
}

function normalizeCost(model: Record<string, unknown>) {
  const cost = model.cost;
  if (cost === undefined || cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    return model;
  }

  const tiers = (cost as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) {
    return model;
  }

  if (tiers.length !== 1) {
    return model;
  }

  const contextOver200k = tiers.find((tier) => {
    if (tier === null || typeof tier !== "object" || Array.isArray(tier)) return false;
    const tierConfig = (tier as { tier?: unknown }).tier;
    if (tierConfig === null || typeof tierConfig !== "object" || Array.isArray(tierConfig)) return false;
    const type = (tierConfig as { type?: unknown }).type;
    const size = (tierConfig as { size?: unknown }).size;
    // context_over_200k is a legacy compatibility field. It intentionally
    // includes higher thresholds; cost.tiers carries the exact threshold.
    return (
      (type === undefined || type === "context") &&
      typeof size === "number" &&
      size >= 200_000
    );
  });

  if (contextOver200k === undefined) {
    return model;
  }

  const { tier: _tier, ...legacyCost } = contextOver200k as Record<string, unknown>;
  return {
    ...model,
    cost: {
      ...(cost as Record<string, unknown>),
      context_over_200k: legacyCost,
    },
  };
}
