import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { generate, generateCatalog, generateV2 } from "../src/index.js";

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
  test("rejects providers with no models", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/empty/provider.toml", providerToml("Empty"));

      expect(generate(path.join(root, "providers"))).rejects.toThrow(
        'Provider "empty" has no models',
      );
    });
  });

  test("base_model publishes canonical identity with the provider model", async () => {
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
reasoning_options = []

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
          harness: "Example Harness",
          variant: "high",
          dataset: "verified",
          version: "1",
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

      expect(catalog.providers.factored?.models.model).toEqual({
        ...catalog.providers.direct?.models.model,
        canonical_model_id: "lab/model",
      });
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
reasoning_options = []

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

  test("base_model can inherit sibling fields from partial object overrides", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
open_weights = true
reasoning_options = []

[cost]
input = 1.25
output = 2.50

[limit]
context = 200_000

[modalities]
input = ["text"]
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.open_weights).toBe(true);
      expect(model?.limit).toEqual({
        context: 200_000,
        input: 272_000,
        output: 128_000,
      });
      expect(model?.modalities).toEqual({
        input: ["text"],
        output: ["text"],
      });
    });
  });

  test("v1_alias providers serve the target's models with renamed env vars", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/target/provider.toml", providerToml("Target"));
      await write(
        root,
        "providers/target/models/model.toml",
        `${providerFieldsToml()}
[cost]
input = 1
output = 2

[provider]
api = "https://\${TARGET_RESOURCE}.example.com/v1"
`,
      );
      await write(
        root,
        "providers/legacy/provider.toml",
        `${providerToml("Legacy")}
[v1_alias]
provider = "target"
env = { TARGET_RESOURCE = "LEGACY_RESOURCE" }
`,
      );

      const providers = await generate(path.join(root, "providers"));
      expect(Object.keys(providers.legacy!)).not.toContain("v1_alias");
      expect(providers.legacy?.name).toBe("Legacy");
      expect(providers.legacy?.models.model?.provider?.api).toBe(
        "https://${LEGACY_RESOURCE}.example.com/v1",
      );
      expect(providers.target?.models.model?.provider?.api).toBe(
        "https://${TARGET_RESOURCE}.example.com/v1",
      );
    });
  });

  test("v1_alias renames the target's provider-level api and rejects model files", async () => {
    await withFixture(async (root) => {
      await write(
        root,
        "providers/target/provider.toml",
        `name = "Target"
npm = "@ai-sdk/openai"
env = ["TARGET_RESOURCE", "TARGET_KEY"]
api = "https://\${TARGET_RESOURCE}.example.com/v1"
doc = "https://example.com/models"
`,
      );
      await write(root, "providers/target/models/plain.toml", `${providerFieldsToml()}
[cost]
input = 1
output = 2
`);
      const alias = `name = "Legacy"
npm = "@ai-sdk/openai"
env = ["LEGACY_RESOURCE", "LEGACY_KEY"]
doc = "https://example.com/models"

[v1_alias]
provider = "target"
env = { TARGET_RESOURCE = "LEGACY_RESOURCE", TARGET_KEY = "LEGACY_KEY" }
`;
      await write(root, "providers/legacy/provider.toml", alias);

      const providers = await generate(path.join(root, "providers"));
      expect(providers.legacy?.api).toBe("https://${LEGACY_RESOURCE}.example.com/v1");
      expect(providers.legacy?.models.plain?.provider).toBeUndefined();
      expect(JSON.stringify(providers.legacy)).not.toContain("TARGET_");

      await write(root, "providers/legacy/models/plain.toml", `${providerFieldsToml()}`);
      expect(generate(path.join(root, "providers"))).rejects.toThrow("can't have a models directory");
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
      "zai",
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

  test("repository benchmark names are normalized", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const qualifiedNames: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      for (const benchmark of model.benchmarks ?? []) {
        if (/\s\([^)]+\)$/.test(benchmark.name)) {
          qualifiedNames.push(`${modelID}: ${benchmark.name}`);
        }
      }
    }

    expect(qualifiedNames).toEqual([]);
  });

  test("legacy_shape is published in v1 and never in v2", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(
        root,
        "providers/provider/models/model.toml",
        `schema = 2
name = "Lab Model"
description = "Example model for catalog generation and inheritance tests"
open_weights = true
release_date = "2026-01-02"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = false }

[limit]
context = 400_000
output = 128_000

[api.responses]
base_url = "https://example.com/v1"
sdk = { aisdk = "@ai-sdk/openai" }
legacy_shape = "responses"

[cost.text.input]
price = 1

[cost.text.output]
price = 2
`,
      );

      const providers = await generate(path.join(root, "providers"));
      expect(providers.provider?.models.model?.provider).toEqual({
        npm: "@ai-sdk/openai",
        api: "https://example.com/v1",
        shape: "responses",
      });

      const providersV2 = await generateV2(path.join(root, "providers"));
      expect(providersV2.provider?.models.model?.api).toEqual({
        responses: { base_url: "https://example.com/v1", sdk: { aisdk: "@ai-sdk/openai" , opencodeai: "@opencode/ai/providers/openai/responses" } },
      });
      expect(JSON.stringify(providersV2)).not.toContain("legacy_shape");
    });
  });
});

describe("model API tables", () => {
  const model = (api = "") => `schema = 2
name = "Lab Model"
description = "Example model for catalog generation and inheritance tests"
open_weights = true
release_date = "2026-01-02"

[modalities]
input = ["text"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = false }

[limit]
context = 400_000
output = 128_000
${api}
[cost.text.input]
price = 1

[cost.text.output]
price = 2
`;
  const provider = (extra = "") => `name = "Gateway"
npm = "@ai-sdk/openai-compatible"
api = "https://example.com/v1"
env = ["API_KEY"]
doc = "https://example.com/models"
${extra}`;

  test("every table is published in order, filled in from the provider default", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/gateway/provider.toml", provider('opencodeai = "@opencode/ai/providers/openai-compatible"\n'));
      await write(
        root,
        "providers/gateway/models/model.toml",
        model(`
[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }

[api.images]
base_url = "https://images.example.com/v1"
sdk = { aisdk = "@ai-sdk/openai", opencodeai = "@opencode/ai/protocols/openai-images" }
`),
      );
      await write(root, "providers/gateway/models/plain.toml", model());

      const providersV2 = await generateV2(path.join(root, "providers"));
      const api = providersV2.gateway?.models.model?.api;
      expect(Object.entries(api ?? {})).toEqual([
        [
          "chat-completions",
          {
            base_url: "https://example.com/v1",
            sdk: { aisdk: "@ai-sdk/openai-compatible", opencodeai: "@opencode/ai/providers/openai-compatible" },
            compatibility: { reasoning_field: "reasoning_content" },
          },
        ],
        [
          "images",
          {
            base_url: "https://images.example.com/v1",
            sdk: { aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/protocols/openai-images" },
          },
        ],
      ]);
      // A model without tables keeps the provider's default API.
      expect(providersV2.gateway?.models.plain?.api).toEqual({
        "chat-completions": {
          base_url: "https://example.com/v1",
          sdk: { aisdk: "@ai-sdk/openai-compatible", opencodeai: "@opencode/ai/providers/openai-compatible" },
        },
      });

      // v1 reads the provider as before and only the model's first table.
      const providers = await generate(path.join(root, "providers"));
      expect(providers.gateway).not.toHaveProperty("opencodeai");
      expect(providers.gateway?.models.model?.interleaved).toEqual({ field: "reasoning_content" });
      expect(providers.gateway?.models.model?.provider).toBeUndefined();
    });
  });

  test("without a provider opencodeai, a table's OpenCode package is guessed as before", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/openai/provider.toml", providerToml("OpenAI"));
      await write(root, "providers/openai/models/model.toml", model("\n[api.chat-completions]\n\n[api.responses]\n"));

      const api = (await generateV2(path.join(root, "providers"))).openai?.models.model?.api;
      expect(api?.["chat-completions"]?.sdk?.opencodeai).toBe("@opencode/ai/providers/openai/chat");
      expect(api?.responses?.sdk?.opencodeai).toBe("@opencode/ai/providers/openai/responses");
    });
  });

  test('"none" leaves a package out instead of filling it in', async () => {
    await withFixture(async (root) => {
      await write(root, "providers/gateway/provider.toml", provider('opencodeai = "@opencode/ai/providers/openai-compatible"\n'));
      await write(
        root,
        "providers/gateway/models/model.toml",
        model(`
[api.systemone]
sdk = { aisdk = "none", opencodeai = "@opencode/ai/providers/typesafe-ai" }

[api.images]
sdk = { opencodeai = "none" }
`),
      );
      await write(root, "providers/silent/provider.toml", providerToml("Silent") + 'opencodeai = "none"\n');
      await write(root, "providers/silent/models/model.toml", model("\n[api.chat-completions]\n"));

      const providersV2 = await generateV2(path.join(root, "providers"));
      expect(providersV2.gateway?.models.model?.api).toEqual({
        systemone: { base_url: "https://example.com/v1", sdk: { opencodeai: "@opencode/ai/providers/typesafe-ai" } },
        images: { base_url: "https://example.com/v1", sdk: { aisdk: "@ai-sdk/openai-compatible" } },
      });
      // A provider-level "none" also stops the guessed package.
      expect(providersV2.silent?.models.model?.api).toEqual({
        "chat-completions": { base_url: "https://api.openai.com/v1", sdk: { aisdk: "@ai-sdk/openai" } },
      });

      // v1 never sees "none": the model keeps the provider's npm.
      const providers = await generate(path.join(root, "providers"));
      expect(providers.gateway?.models.model?.provider).toBeUndefined();
      expect(JSON.stringify(providers)).not.toContain('"none"');
    });
  });

  test("a provider's opencodeai applies to models without tables", async () => {
    await withFixture(async (root) => {
      // Cohere-like: the guess would be @opencode/ai/providers/cohere/chat.
      await write(
        root,
        "providers/cohere/provider.toml",
        `name = "Cohere"
npm = "@ai-sdk/openai-compatible"
api = "https://api.cohere.ai/compatibility/v1"
env = ["COHERE_API_KEY"]
doc = "https://docs.cohere.com/docs/models"
opencodeai = "@opencode/ai/providers/cohere"
`,
      );
      await write(root, "providers/cohere/models/model.toml", model());
      await write(root, "providers/silent/provider.toml", providerToml("Silent") + 'opencodeai = "none"\n');
      await write(root, "providers/silent/models/model.toml", model());

      const providersV2 = await generateV2(path.join(root, "providers"));
      expect(providersV2.cohere?.models.model?.api).toEqual({
        "chat-completions": {
          base_url: "https://api.cohere.ai/compatibility/v1",
          sdk: { aisdk: "@ai-sdk/openai-compatible", opencodeai: "@opencode/ai/providers/cohere" },
        },
      });
      expect(providersV2.silent?.models.model?.api).toEqual({
        responses: { base_url: "https://api.openai.com/v1", sdk: { aisdk: "@ai-sdk/openai" } },
      });

      const providers = await generate(path.join(root, "providers"));
      expect(providers.cohere).not.toHaveProperty("opencodeai");
    });
  });

  test("rejects an opencodeai that isn't an @opencode/ai entry point", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/gateway/provider.toml", provider('opencodeai = "@opencode/ai/openai"\n'));
      await write(root, "providers/gateway/models/model.toml", model());
      await expect(generateV2(path.join(root, "providers"))).rejects.toThrow("@opencode/ai/providers/");
    });
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
description = "Example model for catalog generation and inheritance tests"
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
harness = "Example Harness"
variant = "high"
dataset = "verified"
version = "1"
source = "https://example.com/benchmarks"
`;
}

function providerFieldsToml() {
  return `name = "Lab Model"
description = "Example model for catalog generation and inheritance tests"
family = "gpt"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
reasoning_options = []
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
