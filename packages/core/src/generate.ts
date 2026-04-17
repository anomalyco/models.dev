import path from "path";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { Provider, Model } from "./schema.js";

const ExtendsModel = Model.sourceType()
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

export async function generate(directory: string) {
  const result: Record<string, Provider> = {};
  const extendsModels: Array<{
    providerID: string;
    modelID: string;
    modelPath: string;
    model: z.infer<typeof ExtendsModel>;
  }> = [];
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
        extendsModels.push({
          providerID,
          modelID,
          modelPath,
          model: model.data,
        });
        continue;
      }
      const model = Model.safeParse(toml);
      if (!model.success) {
        model.error.cause = { modelPath, toml };
        throw model.error;
      }
      provider.data.models[modelID] = model.data;
    }
    result[providerID] = provider.data;
  }

  for (const pendingModel of extendsModels) {
    const [providerID, modelID] = pendingModel.model.extends.from.split("/");
    const baseModel = result[providerID]?.models[modelID];
    if (baseModel === undefined) {
      throw new Error(`Unable to resolve extends.from: ${pendingModel.model.extends.from}`, {
        cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
      });
    }

    const { extends: extendsConfig, ...overrides } = pendingModel.model;
    const merged: Record<string, unknown> = structuredClone(
      mergeDeep(baseModel, overrides),
    );

    for (const omit of extendsConfig.omit ?? []) {
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
          throw new Error(`Unable to omit missing path: ${omit}`, {
            cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
          });
        }
        parents.push({ value: current, key: part });
        current = next as Record<string, unknown>;
      }

      const lastPart = parts.at(-1);
      if (lastPart === undefined || !(lastPart in current)) {
        throw new Error(`Unable to omit missing path: ${omit}`, {
          cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
        });
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

    const model = Model.safeParse(merged);
    if (!model.success) {
      model.error.cause = { modelPath: pendingModel.modelPath, toml: merged };
      throw model.error;
    }

    result[pendingModel.providerID]!.models[pendingModel.modelID] = model.data;
  }

  return result;
}
