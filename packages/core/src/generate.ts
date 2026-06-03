import path from "path";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { Provider, Model, AuthoredModel, AuthoredModelShape } from "./schema.js";

const ExtendsModel = AuthoredModelShape
  .partial()
  .extend({
    extends: z
      .object({
        from: z
          .string()
          .regex(/^[^/]+\/[^/]+$/, "Must be in provider/model format"),
        omit: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

type PendingModel = {
  providerID: string;
  modelID: string;
  modelPath: string;
  model: z.infer<typeof ExtendsModel>;
};

export async function generate(directory: string) {
  const result: Record<string, Provider> = {};
  const extendsModels: PendingModel[] = [];
  const pendingModelByID = new Map<string, PendingModel>();
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
      if (toml.extends !== undefined) {
        const model = ExtendsModel.safeParse(toml);
        if (!model.success) {
          model.error.cause = { modelPath, toml };
          throw model.error;
        }
        const pendingModel = {
          providerID,
          modelID,
          modelPath,
          model: model.data,
        };
        extendsModels.push(pendingModel);
        pendingModelByID.set(`${providerID}/${modelID}`, pendingModel);
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

  const resolveModel = (
    providerID: string,
    modelID: string,
    stack: string[],
  ): Model | undefined => {
    const existing = result[providerID]?.models[modelID];
    if (existing !== undefined) {
      return existing;
    }

    const pendingModel = pendingModelByID.get(`${providerID}/${modelID}`);
    if (pendingModel === undefined) {
      return undefined;
    }

    return resolvePendingModel(pendingModel, stack);
  };

  const resolvePendingModel = (
    pendingModel: PendingModel,
    stack: string[],
  ): Model => {
    const pendingModelID = `${pendingModel.providerID}/${pendingModel.modelID}`;
    const existing = result[pendingModel.providerID]?.models[pendingModel.modelID];
    if (existing !== undefined) {
      return existing;
    }

    if (stack.includes(pendingModelID)) {
      throw new Error(
        `Cycle detected in extends.from chain: ${[...stack, pendingModelID].join(" -> ")}`,
        {
          cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
        },
      );
    }

    const [providerID, modelID] = pendingModel.model.extends.from.split("/");
    const baseModel = resolveModel(providerID!, modelID!, [...stack, pendingModelID]);
    if (baseModel === undefined) {
      throw new Error(`Unable to resolve extends.from: ${pendingModel.model.extends.from}`, {
        cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
      });
    }

    const { extends: extendsConfig, ...overrides } = pendingModel.model;
    // Reasoning controls describe the endpoint interface, not just the model.
    // Derived providers must declare the controls their API exposes explicitly.
    const { reasoning_options: _reasoningOptions, ...inherited } = baseModel;
    const merged: Record<string, unknown> = structuredClone(
      mergeDeep(inherited, overrides),
    );

    omitLoop: for (const omit of extendsConfig.omit ?? []) {
      const parts = omit.split(".");
      const parents: Array<{
        value: Record<string, unknown>;
        key: string;
      }> = [];
      let current = merged;

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
        if (parent === undefined) {
          break;
        }
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

    const model = Model.safeParse(normalizeCost(merged));
    if (!model.success) {
      model.error.cause = { modelPath: pendingModel.modelPath, toml: merged };
      throw model.error;
    }

    result[pendingModel.providerID]!.models[pendingModel.modelID] = model.data;
    return model.data;
  };

  for (const pendingModel of extendsModels) {
    resolvePendingModel(pendingModel, []);
  }

  return result;
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
