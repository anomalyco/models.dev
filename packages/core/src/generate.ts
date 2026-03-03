import path from "path";

import { Provider, Model } from "./schema.js";

function compareStrings(a: string, b: string) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export async function generate(directory: string) {
  const result = {} as Record<string, Provider>;

  const providers: Array<{ id: string; providerPath: string }> = [];
  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    providers.push({
      id: path.basename(path.dirname(providerPath)),
      providerPath,
    });
  }

  providers.sort((a, b) => {
    const byId = compareStrings(a.id, b.id);
    if (byId !== 0) {
      return byId;
    }
    return compareStrings(a.providerPath, b.providerPath);
  });

  for (const { id: providerID, providerPath } of providers) {
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
    const models: Array<{ id: string; modelPath: string }> = [];
    for await (const modelPath of new Bun.Glob("**/*.toml").scan({
      cwd: modelsPath,
      absolute: true,
      followSymlinks: true,
    })) {
      models.push({
        id: path.relative(modelsPath, modelPath).slice(0, -5),
        modelPath,
      });
    }

    models.sort((a, b) => {
      const byId = compareStrings(a.id, b.id);
      if (byId !== 0) {
        return byId;
      }
      return compareStrings(a.modelPath, b.modelPath);
    });

    for (const { id: modelID, modelPath } of models) {
      const toml = await import(modelPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => mod.default);
      toml.id = modelID;
      const model = Model.safeParse(toml);
      if (!model.success) {
        model.error.cause = { modelPath, toml };
        throw model.error;
      }
      provider.data.models[modelID] = model.data;
    }
    result[providerID] = provider.data;
  }

  return result;
}
