import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";
import {
  buildCloudflareAiGatewayModel,
  cloudflareAiGateway,
  deriveReasoningOptions,
} from "../src/sync/providers/cloudflare-ai-gateway.js";

test("builds Cloudflare AI Gateway overrides from catalog metadata", () => {
  const model = buildCloudflareAiGatewayModel(
    {
      model_id: "openai/gpt-5.4",
      task: "Text Generation",
      context_length: 1_050_000,
      pricing: {
        "Input <= 200k (per 1M)": 2.5,
        "Input > 200k (per 1M)": 5,
        "Output tokens (per 1M)": 15,
        "Cached input tokens (per 1M)": 0.25,
      },
    },
    undefined,
    {
      reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    },
  );

  expect(model).toEqual({
    base_model: "openai/gpt-5.4",
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
    cost: { input: 2.5, output: 15, cache_read: 0.25 },
    limit: { context: 1_050_000 },
    provider: { npm: "@ai-sdk/openai" },
  });
});

test("derives nested Cloudflare reasoning controls", () => {
  expect(deriveReasoningOptions({
    properties: {
      thinking: { type: "boolean" },
      reasoning: {
        properties: {
          effort: {
            anyOf: [{ enum: ["low", "medium", "high"] }],
          },
        },
      },
    },
  })).toEqual([
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high"] },
  ]);
});

test("ignores advertised reasoning controls for non-reasoning base models", () => {
  const model = buildCloudflareAiGatewayModel(
    {
      model_id: "openai/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      pricing: {
        "Input tokens (per 1M)": 2,
        "Output tokens (per 1M)": 8,
      },
    },
    {
      properties: {
        reasoning_effort: { enum: ["low", "medium", "high"] },
      },
    },
  );

  expect(model.reasoning_options).toBeUndefined();
});

test("fails closed on unknown pricing fields", () => {
  expect(() => buildCloudflareAiGatewayModel({
    model_id: "openai/gpt-4.1",
    task: "Text Generation",
    context_length: 1_047_576,
    pricing: {
      "Input tokens (per 1M)": 2,
      "Output tokens (per 1M)": 8,
      "New billing unit": 1,
    },
  }, undefined)).toThrow('unmapped pricing key "New billing unit"');
});

test("fails closed when Cloudflare pagination is incomplete", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  let page = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage(
    page++ === 0
      ? [{
        model_id: "openai/gpt-4.1",
        task: "Text Generation",
        context_length: 1_047_576,
        pricing: {
          "Input tokens (per 1M)": 2,
          "Output tokens (per 1M)": 8,
        },
      }]
      : [],
    { page, total_count: 2 },
  )));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("pagination ended at 1/2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("rejects unsafe catalog model paths", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([{
      model_id: "../providers/openai/models/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      pricing: {
        "Input tokens (per 1M)": 2,
        "Output tokens (per 1M)": 8,
      },
    }])));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("safe relative provider/model path");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("rejects a catalog with no eligible proxied models", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([{
    model_id: "@cf/meta/llama-3.1-8b-instruct",
    task: "Text Generation",
  }])));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("no eligible proxied models");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("validates Cloudflare page metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  globalThis.fetch = async () => new Response(JSON.stringify(catalogPage([], { page: 2, total_count: 0 })));

  try {
    await expect(cloudflareAiGateway.fetchModels()).rejects.toThrow("expected page 1, got 2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("retries transient Cloudflare responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test";
  let catalogRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/schema")) return new Response(null, { status: 404 });
    catalogRequests++;
    if (catalogRequests === 1) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify(catalogPage([{
      model_id: "openai/gpt-4.1",
      task: "Text Generation",
      context_length: 1_047_576,
      pricing: {
        "Input tokens (per 1M)": 2,
        "Output tokens (per 1M)": 8,
      },
    }])));
  };

  try {
    expect(await cloudflareAiGateway.fetchModels()).toHaveLength(1);
    expect(catalogRequests).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CLOUDFLARE_API_TOKEN", originalToken);
    restoreEnv("CLOUDFLARE_ACCOUNT_ID", originalAccount);
  }
});

test("replaces a stale generated base-model mapping", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".base-model-sync-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  const file = path.join(modelsDir, "model.toml");
  await writeFile(file, 'base_model = "anthropic/claude-opus-4-6"\n');

  try {
    const provider = {
      id: "base-model-test",
      name: "Base-model test",
      modelsDir,
      async fetchModels() {
        return [{ id: "model" }];
      },
      parseModels(raw: unknown) {
        return raw as Array<{ id: string }>;
      },
      translateModel(model: { id: string }) {
        return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
      },
    };
    await syncProvider(provider);
    expect(await readFile(file, "utf8")).toContain('base_model = "openai/gpt-4.1"');
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("reconciles authoritative generated headers", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".cloudflare-ai-gateway-sync-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  const file = path.join(modelsDir, "gpt-4.1.toml");
  await writeFile(file, "# Old note\n\nbase_model = \"openai/gpt-4.1\"\n");

  try {
    const provider = {
      id: "cloudflare-ai-gateway-test",
      name: "Cloudflare AI Gateway test",
      modelsDir,
      authoritativeHeaders: true,
      async fetchModels() {
        return [{ id: "gpt-4.1" }];
      },
      parseModels() {
        return [{ id: "gpt-4.1" }];
      },
      translateModel(model) {
        return {
          id: model.id,
          model: { base_model: "openai/gpt-4.1" },
          header: "# New note\n\n",
        };
      },
    };
    const result = await syncProvider(provider);

    expect(result.updated).toBe(1);
    expect(await readFile(file, "utf8")).toStartWith("# New note\nbase_model");
    expect((await syncProvider(provider)).updated).toBe(0);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
  }
});

test("refuses to write through a symlinked model directory", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".sync-symlink-"));
  const outsideDir = await mkdtemp(path.join(providersDir, ".sync-outside-"));
  const modelsDir = path.join(providerDir, "models");
  await mkdir(modelsDir);
  await symlink(outsideDir, path.join(modelsDir, "linked"));

  try {
    const provider = {
      id: "symlink-test",
      name: "Symlink test",
      modelsDir,
      async fetchModels() {
        return [{ id: "linked/model" }];
      },
      parseModels(raw: unknown) {
        return raw as Array<{ id: string }>;
      },
      translateModel(model: { id: string }) {
        return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
      },
    };
    await expect(syncProvider(provider)).rejects.toThrow("Refusing to sync through symlink");
    expect(await Bun.file(path.join(outsideDir, "model.toml")).exists()).toBe(false);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("refuses a symlinked models root", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".sync-root-"));
  const outsideDir = await mkdtemp(path.join(providersDir, ".sync-root-outside-"));
  const modelsDir = path.join(providerDir, "models");
  await symlink(outsideDir, modelsDir);

  try {
    const provider = testSyncProvider(modelsDir, "model");
    await expect(syncProvider(provider)).rejects.toThrow("Refusing to sync through symlink");
    expect(await Bun.file(path.join(outsideDir, "model.toml")).exists()).toBe(false);
  } finally {
    await rm(providerDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("refuses a symlinked metadata file", async () => {
  const providersDir = path.join(import.meta.dirname, "..", "..", "..", "providers");
  const providerDir = await mkdtemp(path.join(providersDir, ".sync-metadata-"));
  const outsideDir = await mkdtemp(path.join(providersDir, ".sync-metadata-outside-"));
  const modelsDir = path.join(providerDir, "models");
  const namespace = `sync-symlink-${path.basename(providerDir).replaceAll(/[^a-z0-9-]/g, "")}`;
  const metadataDir = path.join(providersDir, "..", "models", namespace);
  const outsideFile = path.join(outsideDir, "model.toml");
  await mkdir(modelsDir);
  await mkdir(metadataDir);
  await writeFile(outsideFile, "sentinel\n");
  await symlink(outsideFile, path.join(metadataDir, "model.toml"));

  try {
    const provider = {
      ...testSyncProvider(modelsDir, "provider-model"),
      metadataNamespace: namespace,
      translateModel(model: { id: string }) {
        return {
          id: model.id,
          model: {
            name: "Provider symlink test",
            description: "Provider model used to test safe sync paths",
            release_date: "2026-01-01",
            last_updated: "2026-01-01",
            attachment: false,
            reasoning: false,
            tool_call: false,
            open_weights: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1_000, output: 100 },
            cost: { input: 1, output: 2 },
          },
          metadata: {
            id: `${namespace}/model`,
            model: {
              name: "Symlink test",
              description: "Metadata used to test safe sync paths",
              release_date: "2026-01-01",
              last_updated: "2026-01-01",
              attachment: false,
              reasoning: false,
              tool_call: false,
              open_weights: false,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 1_000, output: 100 },
            },
          },
        };
      },
    };
    await expect(syncProvider(provider)).rejects.toThrow("Refusing to sync through symlink");
    expect(await readFile(outsideFile, "utf8")).toBe("sentinel\n");
  } finally {
    await rm(providerDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(metadataDir, { recursive: true, force: true });
  }
});

function testSyncProvider(modelsDir: string, id: string) {
  return {
    id: "symlink-test",
    name: "Symlink test",
    modelsDir,
    async fetchModels() {
      return [{ id }];
    },
    parseModels(raw: unknown) {
      return raw as Array<{ id: string }>;
    },
    translateModel(model: { id: string }) {
      return { id: model.id, model: { base_model: "openai/gpt-4.1" } };
    },
  };
}

function catalogPage(
  result: Array<Record<string, unknown>>,
  resultInfo: Partial<{ page: number; per_page: number; total_count: number; total_pages: number }> = {},
) {
  const page = resultInfo.page ?? 1;
  const perPage = resultInfo.per_page ?? 50;
  const totalCount = resultInfo.total_count ?? result.length;
  return {
    success: true,
    result,
    result_info: {
      page,
      per_page: perPage,
      count: result.length,
      total_count: totalCount,
      total_pages: resultInfo.total_pages ?? Math.max(1, Math.ceil(totalCount / perPage)),
    },
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
