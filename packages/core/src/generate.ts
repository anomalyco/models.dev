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
import { labModelV2ToV1, modelV2ToV1, providerTomlToV1, withoutV1ReasoningCost } from "./translate.js";

const BaseModel = AuthoredModelShape
  .deepPartial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

// `[v1_alias]` in provider.toml: a legacy v1 provider that serves another
// provider's models under its own id, name, and env vars. It has no model files
// and is left out of the v2 output.
const V1Alias = z
  .object({
    provider: z.string().min(1),
    // Env var renames applied to `${VAR}` templates in the models, e.g. `provider.api`.
    env: z.record(z.string().min(1)).default({}),
  })
  .strict();

type V1Alias = z.infer<typeof V1Alias>;

export async function generateCatalog(directory: string) {
  const models = await generateModels(path.join(directory, "models"));
  const providers = await generateProviders(
    path.join(directory, "providers"),
    models,
  );
  // v2-only lab models stay available as base models but are left out of v1.
  for (const id of v2OnlyModels.get(models) ?? []) delete models[id];

  return { models, providers };
}

// Lab model IDs marked `v2_only = true`, per generateModels result.
const v2OnlyModels = new WeakMap<object, Set<string>>();

// Every lab model, including v2-only ones (providers can still base_model them).
export async function generateModels(directory: string) {
  const result: Record<string, ModelMetadata> = {};
  const v2Only = new Set<string>();
  v2OnlyModels.set(result, v2Only);
  if (!existsSync(directory)) return result;

  for await (const modelPath of new Bun.Glob("**/*.toml").scan({
    cwd: directory,
    absolute: true,
    followSymlinks: true,
  })) {
    const modelID = path.relative(directory, modelPath).split(path.sep).join("/").slice(0, -5);
    const toml = await import(modelPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = modelID;
    if (toml.v2_only === true) v2Only.add(modelID);

    const model = ModelMetadata.safeParse(labModelV2ToV1(toml, { modelPath }));
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
  const aliases: Array<{ provider: Provider; alias: V1Alias; providerPath: string }> = [];
  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const { v1_alias, ...raw } = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    const toml = providerTomlToV1(raw);
    toml.id = providerID;
    toml.models = {};
    const provider = Provider.safeParse(toml);
    if (!provider.success) {
      provider.error.cause = { providerPath, toml };
      throw provider.error;
    }

    if (v1_alias !== undefined) {
      const alias = V1Alias.safeParse(v1_alias);
      if (!alias.success) {
        alias.error.cause = { providerPath, toml: v1_alias };
        throw alias.error;
      }
      if (existsSync(path.join(directory, providerID, "models"))) {
        throw new Error(`Provider "${providerID}" is a v1_alias and can't have a models directory`, {
          cause: { providerPath },
        });
      }
      aliases.push({ provider: provider.data, alias: alias.data, providerPath });
      result[providerID] = provider.data;
      continue;
    }

    const modelsPath = path.join(directory, providerID, "models");
    if (!existsSync(modelsPath)) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }
    for await (const modelPath of new Bun.Glob("**/*.toml").scan({
      cwd: modelsPath,
      absolute: true,
      followSymlinks: true,
    })) {
      const modelID = path.relative(modelsPath, modelPath).split(path.sep).join("/").slice(0, -5);
      const raw = await import(modelPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => mod.default);
      raw.id = modelID;
      // Models marked `v2_only = true` are only published in the v2 API.
      if (raw.v2_only === true) continue;
      const toml = modelV2ToV1(raw, { modelPath });
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
        provider.data.models[modelID] = {
          ...normalizeModelCost(model.data),
          canonical_model_id: baseModel.data.base_model,
        };
        continue;
      }
      const model = AuthoredModel.safeParse(toml);
      if (!model.success) {
        model.error.cause = { modelPath, toml };
        throw model.error;
      }
      provider.data.models[modelID] = normalizeModelCost(model.data);
    }
    if (Object.keys(provider.data.models).length === 0) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }
    result[providerID] = provider.data;
  }

  for (const { provider, alias, providerPath } of aliases) {
    const target = result[alias.provider];
    if (target === undefined || aliases.some((item) => item.provider.id === alias.provider)) {
      throw new Error(`Provider "${provider.id}" aliases unknown provider "${alias.provider}"`, {
        cause: { providerPath },
      });
    }
    const rename = (value: string) =>
      Object.entries(alias.env).reduce(
        (text, [from, to]) => text.replaceAll(`\${${from}}`, `\${${to}}`),
        value,
      );
    // The target's provider-level base URL applies to its models too.
    if (provider.api === undefined && target.api !== undefined) provider.api = rename(target.api);
    provider.models = JSON.parse(rename(JSON.stringify(target.models)));
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
  return withoutV1ReasoningCost(merged);
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
