#!/usr/bin/env bun

import path from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mergeDeep } from "remeda";
import { z } from "zod";
import { generate } from "../src/generate.js";
import { AuthoredModel, AuthoredModelShape, Model, Provider } from "../src/schema.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const providersPath = path.join(root, "providers");
const modelsPath = path.join(root, "models");

const LegacyExtendsModel = AuthoredModelShape
  .partial()
  .extend({
    extends: z
      .object({
        from: z.string(),
        omit: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const diffOutput = await Bun.$`git diff --name-only HEAD -- providers`.cwd(root).text();
const changedProviderPaths = diffOutput
  .split("\n")
  .filter(Boolean)
  .filter((filePath) => /^providers\/[^/]+\/models\/.+\.toml$/.test(filePath));

if (changedProviderPaths.length === 0) {
  process.exit(0);
}

const baselineRoot = path.join(tmpdir(), `models-dev-compare-${Date.now()}`);
await mkdir(baselineRoot, { recursive: true });

try {
  const baselineProvidersPath = path.join(baselineRoot, "providers");
  await cp(providersPath, baselineProvidersPath, { recursive: true });
  await cp(modelsPath, path.join(baselineRoot, "models"), { recursive: true });

  for (const filePath of changedProviderPaths) {
    const tempFilePath = path.join(baselineRoot, filePath);
    const show = Bun.spawn(["git", "show", `HEAD:${filePath}`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await show.exited;
    if (exitCode !== 0) {
      await rm(tempFilePath, { force: true });
      continue;
    }

    const contents = await new Response(show.stdout).text();
    await mkdir(path.dirname(tempFilePath), { recursive: true });
    await writeFile(tempFilePath, contents);
  }

  const before = await generateForComparison(baselineProvidersPath);
  const after = await generate(providersPath);

  for (const filePath of changedProviderPaths) {
    const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(filePath);
    if (!match) continue;

    const [, providerID, modelID] = match;
    const beforeModel = before[providerID]?.models[modelID];
    const afterModel = after[providerID]?.models[modelID];
    const beforeJson = sortedJson(beforeModel);
    const afterJson = sortedJson(afterModel);

    if (beforeJson === afterJson) {
      continue;
    }

    const beforeFilePath = path.join(baselineRoot, "before.json");
    const afterFilePath = path.join(baselineRoot, "after.json");
    await writeFile(beforeFilePath, `${beforeJson}\n`);
    await writeFile(afterFilePath, `${afterJson}\n`);

    const diff = Bun.spawn(
      [
        "diff",
        "-u",
        "-L",
        `${filePath} (before)`,
        "-L",
        `${filePath} (after)`,
        beforeFilePath,
        afterFilePath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(diff.stdout).text();
    process.stdout.write(output);
  }
} finally {
  await rm(baselineRoot, { recursive: true, force: true });
}

async function generateForComparison(directory: string) {
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: directory })) {
    const text = await Bun.file(path.join(directory, file)).text();
    if (/^\[extends\]/m.test(text)) {
      return generateLegacyExtends(directory);
    }
  }

  return generate(directory);
}

async function generateLegacyExtends(directory: string) {
  const result: Record<string, Provider> = {};
  const pendingModels: Array<{
    providerID: string;
    modelID: string;
    modelPath: string;
    model: z.infer<typeof LegacyExtendsModel>;
  }> = [];

  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, { with: { type: "toml" } }).then(
      (mod) => mod.default,
    );
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
      const toml = await import(modelPath, { with: { type: "toml" } }).then(
        (mod) => mod.default,
      );
      toml.id = modelID;

      if (toml.extends !== undefined) {
        const model = LegacyExtendsModel.safeParse(toml);
        if (!model.success) {
          model.error.cause = { modelPath, toml };
          throw model.error;
        }
        pendingModels.push({
          providerID,
          modelID,
          modelPath,
          model: model.data,
        });
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
      );
    }
    nameToProviderID.set(nameKey, provider.id);
  }

  for (const pendingModel of pendingModels) {
    const [providerID, ...modelParts] = pendingModel.model.extends.from.split("/");
    const modelID = modelParts.join("/");
    const baseModel = result[providerID]?.models[modelID];
    if (baseModel === undefined) {
      throw new Error(`Unable to resolve legacy extends.from: ${pendingModel.model.extends.from}`, {
        cause: { modelPath: pendingModel.modelPath, toml: pendingModel.model },
      });
    }

    const { extends: extendsConfig, ...overrides } = pendingModel.model;
    const { reasoning_options: _reasoningOptions, ...inherited } = baseModel;
    const merged: Record<string, unknown> = structuredClone(
      mergeDeep(inherited, overrides),
    );
    applyOmit(merged, extendsConfig.omit ?? []);

    const model = Model.safeParse(normalizeCost(merged));
    if (!model.success) {
      model.error.cause = { modelPath: pendingModel.modelPath, toml: merged };
      throw model.error;
    }

    result[pendingModel.providerID]!.models[pendingModel.modelID] = model.data;
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
  if (!Array.isArray(tiers) || tiers.length !== 1) {
    return model;
  }

  const contextOver200k = tiers.find((tier) => {
    if (tier === null || typeof tier !== "object" || Array.isArray(tier)) return false;
    const tierConfig = (tier as { tier?: unknown }).tier;
    if (tierConfig === null || typeof tierConfig !== "object" || Array.isArray(tierConfig)) return false;
    const type = (tierConfig as { type?: unknown }).type;
    const size = (tierConfig as { size?: unknown }).size;
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

function sortedJson(value: unknown) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
