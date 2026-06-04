import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { generate, generateCatalog } from "../src/index.js";

async function withFixture<T>(callback: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-test-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, file: string, content: string) {
  const filePath = path.join(root, file);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("catalog generation", () => {
  test("base_model can factor metadata without changing provider JSON", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/direct/provider.toml", providerToml("Direct"));
      await write(root, "providers/factored/provider.toml", providerToml("Factored"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/direct/models/model.toml",
        `${providerFieldsToml()}

[cost]
input = 1.25
output = 2.50
cache_read = 0.125
`,
      );
      await write(
        root,
        "providers/factored/models/model.toml",
        `base_model = "lab/model"

[cost]
input = 1.25
output = 2.50
cache_read = 0.125
`,
      );

      const catalog = await generateCatalog(root);

      expect(catalog.models["lab/model"]?.benchmarks).toEqual([
        {
          name: "SWE-Bench Verified",
          score: 71.2,
          metric: "resolved",
          source: "https://example.com/benchmarks",
        },
      ]);
      expect(catalog.models["lab/model"]?.weights).toEqual([
        {
          label: "Weights",
          url: "https://huggingface.co/lab/model",
          format: "safetensors",
        },
      ]);

      expect(catalog.providers.factored?.models.model).toEqual(
        catalog.providers.direct?.models.model,
      );
      expect(catalog.providers.factored?.models.model).not.toHaveProperty(
        "base_model",
      );
      expect(catalog.providers.factored?.models.model).not.toHaveProperty(
        "benchmarks",
      );
    });
  });

  test("base_model_omit removes inherited metadata fields", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
base_model_omit = ["limit.input", "structured_output"]

[cost]
input = 1.25
output = 2.50

[limit]
context = 200_000
output = 32_000
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.structured_output).toBeUndefined();
      expect(model?.limit).toEqual({
        context: 200_000,
        output: 32_000,
      });
    });
  });

  test("repository provider TOMLs do not use legacy extends tables", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const matches: string[] = [];

    for await (const file of new Bun.Glob("providers/**/*.toml").scan({
      cwd: root,
    })) {
      const text = await Bun.file(path.join(root, file)).text();
      if (/^\[extends\]/m.test(text)) matches.push(file);
    }

    expect(matches).toEqual([]);
  });

  test("repository provider JSON strips authored metadata pointers", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providers = await generate(path.join(root, "providers"));
    const leaked: string[] = [];

    for (const [providerID, provider] of Object.entries(providers)) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        const encoded = stable(model);
        if (encoded.includes("base_model") || encoded.includes("base_model_omit")) {
          leaked.push(`${providerID}/${modelID}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  test("repository provider JSON excludes model-only metadata", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providers = await generate(path.join(root, "providers"));
    const modelOnlyFields = ["benchmarks", "license", "links", "weights"];
    const leaked: string[] = [];

    for (const [providerID, provider] of Object.entries(providers)) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        const leakedFields = modelOnlyFields.filter((field) => field in model);
        if (leakedFields.length > 0) {
          leaked.push(`${providerID}/${modelID}: ${leakedFields.join(", ")}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  test("repository model metadata avoids provider-only namespaces", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providerNamespaces = [
      "amazon-bedrock",
      "llama",
      "opencode",
      "tencent-tokenhub",
    ];
    const namespaceDirs = providerNamespaces.filter((namespace) =>
      existsSync(path.join(root, "models", namespace))
    );
    const baseModelRefs: string[] = [];

    for await (const file of new Bun.Glob("providers/**/*.toml").scan({
      cwd: root,
    })) {
      const text = await Bun.file(path.join(root, file)).text();
      const match = /^base_model = "([^/"]+)\//m.exec(text);
      if (match?.[1] !== undefined && providerNamespaces.includes(match[1])) {
        baseModelRefs.push(file);
      }
    }

    expect(namespaceDirs).toEqual([]);
    expect(baseModelRefs).toEqual([]);
  });

  test("repository open-weight model metadata includes weights links", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const missingWeights: string[] = [];
    const closedWithWeights: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      const hasWeights = (model.weights?.length ?? 0) > 0;
      if (model.open_weights === true && !hasWeights) {
        missingWeights.push(modelID);
      }
      if (model.open_weights !== true && hasWeights) {
        closedWithWeights.push(modelID);
      }
    }

    expect(missingWeights).toEqual([]);
    expect(closedWithWeights).toEqual([]);
  });

  test("repository benchmark metadata is sourced", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const unsourced: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      for (const benchmark of model.benchmarks ?? []) {
        if (benchmark.source === undefined) {
          unsourced.push(`${modelID}: ${benchmark.name}`);
        }
      }
    }

    expect(unsourced).toEqual([]);
  });
});

function providerToml(name: string) {
  return `name = "${name}"
npm = "@ai-sdk/openai"
env = ["API_KEY"]
doc = "https://example.com/models"
`;
}

function modelMetadataToml() {
  return `name = "Lab Model"
family = "gpt"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true
knowledge = "2025-12"
open_weights = true
license = "Example License"

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]

[[links]]
label = "Model card"
url = "https://example.com/model"
type = "model_card"

[[weights]]
label = "Weights"
url = "https://huggingface.co/lab/model"
format = "safetensors"

[[benchmarks]]
name = "SWE-Bench Verified"
score = 71.2
metric = "resolved"
source = "https://example.com/benchmarks"
`;
}

function providerFieldsToml() {
  return `name = "Lab Model"
family = "gpt"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true
knowledge = "2025-12"
open_weights = true

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]
`;
}
