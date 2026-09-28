import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import * as missingIssues from "../src/sync/missing-issues.js";
import {
  buildFireworksModel,
  expandFireworksModels,
  fetchFireworksInventory,
  fetchFireworksModels,
  type FireworksInventoryModel,
  FireworksInventoryResponse,
  FireworksResponse,
  fireworksAi,
  mergeFireworksModels,
  type FireworksCatalogModel,
  type FireworksModel,
} from "../src/sync/providers/fireworks-ai.js";

test("fetches the Fireworks serverless catalog with bearer auth", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    return Response.json({ object: "list", data: [fireworksModel()] });
  }) as unknown as typeof fetch;

  await fetchFireworksModels("test-key", fetcher);

  expect(request?.url).toBe("https://api.fireworks.ai/v1/serverless/models");
  expect(request?.headers.get("authorization")).toBe("Bearer test-key");
});

test("parses the Fireworks serverless model list", () => {
  const parsed = FireworksResponse.parse({
    object: "list",
    data: [fireworksModel()],
  });

  expect(parsed.data[0]).toMatchObject({
    id: "accounts/fireworks/models/example",
    serverless_mode: "standard",
    context_length: 1_048_576,
    input_modalities: ["text", "image"],
  });
});

test("fetches Fireworks serverless inventory with the documented filter", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    return Response.json({ models: [inventoryModel()] });
  }) as unknown as typeof fetch;

  await fetchFireworksInventory("test-key", fetcher);

  expect(request?.url).toStartWith("https://api.fireworks.ai/v1/accounts/fireworks/models?");
  expect(new URL(request!.url).searchParams.get("filter")).toBe("supports_serverless=true");
  expect(new URL(request!.url).searchParams.get("pageSize")).toBe("200");
  expect(request?.headers.get("authorization")).toBe("Bearer test-key");
});

test("fetches every Fireworks serverless inventory page", async () => {
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    requests.push(request);
    return Response.json(
      request.url.includes("pageToken=next")
        ? { models: [inventoryModel({ name: "accounts/fireworks/models/two" })] }
        : {
          models: [inventoryModel({ name: "accounts/fireworks/models/one" })],
          nextPageToken: "next",
        },
    );
  }) as unknown as typeof fetch;

  const models = await fetchFireworksInventory("test-key", fetcher);

  expect(models.map((model) => model.name)).toEqual([
    "accounts/fireworks/models/one",
    "accounts/fireworks/models/two",
  ]);
  expect(new URL(requests[1]!.url).searchParams.get("pageToken")).toBe("next");
});

test("accepts unset Fireworks deprecation dates", () => {
  expect(FireworksInventoryResponse.parse({
    models: [{ ...inventoryModel(), deprecationDate: null }],
  }).models[0]?.deprecationDate).toBeNull();
});

test("unions pricing IDs with generation models from serverless inventory", () => {
  const models = mergeFireworksModels(
    [fireworksModel()],
    [
      inventoryModel({ name: "accounts/fireworks/models/example" }),
      inventoryModel({ name: "accounts/fireworks/models/inventory-only" }),
      inventoryModel({ name: "accounts/fireworks/models/embedding", kind: "EMBEDDING_MODEL" }),
      inventoryModel({ name: "accounts/fireworks/models/on-demand", supportsServerless: false }),
    ],
  );

  expect(models.map((model) => model.catalogId)).toEqual([
    "accounts/fireworks/models/example",
    "accounts/fireworks/models/inventory-only",
  ]);
  expect(models[1]).toEqual({
    catalogId: "accounts/fireworks/models/inventory-only",
    inventoryOnly: true,
  });
});

test("does not report retired pricing rows or their aliases as missing models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fireworks-sync-"));
  const modelsDir = path.join(dir, "providers/fireworks-ai/models");
  await mkdir(modelsDir, { recursive: true });
  const issues = spyOn(missingIssues, "openMissingModelIssues").mockResolvedValue([]);
  const provider = {
    ...fireworksAi,
    modelsDir,
    async fetchModels() {
      return {
        serverless: {
          object: "list" as const,
          data: [
            fireworksModel({
              id: "accounts/fireworks/models/retired",
              aliases: ["accounts/fireworks/routers/retired-latest"],
            }),
            fireworksModel({ id: "accounts/fireworks/models/new" }),
          ],
        },
        inventory: [
          inventoryModel({ name: "accounts/fireworks/models/retired", supportsServerless: false }),
          inventoryModel({ name: "accounts/fireworks/models/new" }),
        ],
      };
    },
  };

  try {
    await syncProvider(provider, { openIssues: true });
    expect(issues).toHaveBeenCalledTimes(1);
    expect(issues.mock.calls[0]?.[1]).toEqual(["accounts/fireworks/models/new"]);
  } finally {
    issues.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("excludes expired serverless deprecations including fast routes", () => {
  const retiring = {
    ...inventoryModel({ name: "accounts/fireworks/models/retiring" }),
    deprecationDate: { year: 2026, month: 9, day: 25 },
  };
  const live = inventoryModel({ name: "accounts/fireworks/models/live" });
  const pricing = [
    fireworksModel({ id: retiring.name }),
    fireworksModel({
      id: retiring.name,
      serverless_mode: "fast",
      usage_identifier: "accounts/fireworks/routers/retiring-fast",
    }),
    fireworksModel({ id: live.name }),
  ];

  expect(mergeFireworksModels(pricing, [retiring, live], new Date("2026-09-28T00:00:00Z"))
    .map((model) => model.catalogId)).toEqual([live.name]);
  expect(mergeFireworksModels(pricing, [retiring, live], new Date("2026-09-25T12:00:00Z"))
    .map((model) => model.catalogId)).toEqual([
    retiring.name,
    "accounts/fireworks/routers/retiring-fast",
    live.name,
  ]);
});

test("honors the documented GLM 5.2 retirement while Fireworks still flags it as serverless", () => {
  const retired = inventoryModel({ name: "accounts/fireworks/models/glm-5p2" });
  const live = inventoryModel({ name: "accounts/fireworks/models/glm-5p3" });
  const pricing = [fireworksModel({ id: retired.name }), fireworksModel({ id: live.name })];

  expect(mergeFireworksModels(pricing, [retired, live], new Date("2026-09-28T00:00:00Z"))
    .map((model) => model.catalogId)).toEqual([live.name]);
});

test("refuses destructive sync when either Fireworks source is empty", () => {
  expect(() => mergeFireworksModels([], [inventoryModel()])).toThrow("empty serverless source");
  expect(() => mergeFireworksModels([fireworksModel()], [])).toThrow("empty serverless source");
  expect(() => mergeFireworksModels([fireworksModel()], [
    inventoryModel({ supportsServerless: false }),
  ])).toThrow("empty active serverless inventory");
});

test("preserves inventory-only models while enabling deletion for models absent from both sources", () => {
  const authored = {
    base_model: "example/example",
    cost: { input: 1, output: 2 },
  };
  const translated = fireworksAi.translateModel({
    catalogId: "accounts/fireworks/models/example",
    inventoryOnly: true,
  }, {
    existing: () => existingModel(),
    authored: () => authored,
  });

  expect(fireworksAi.deleteMissing).toBe(true);
  expect(translated?.model).toEqual(authored);
});

test("expands usage identifiers and aliases and attaches flag-only modes", () => {
  const models = expandFireworksModels([
    fireworksModel({ aliases: ["accounts/fireworks/routers/example-latest"] }),
    fireworksModel({
      serverless_mode: "fast",
      usage_identifier: "accounts/fireworks/routers/example-fast",
      aliases: ["accounts/fireworks/routers/example-fast-latest"],
    }),
    fireworksModel({ serverless_mode: "priority", service_tier: "priority" }),
  ]);

  expect(models.map((model) => model.catalogId)).toEqual([
    "accounts/fireworks/models/example",
    "accounts/fireworks/routers/example-latest",
    "accounts/fireworks/routers/example-fast",
    "accounts/fireworks/routers/example-fast-latest",
  ]);
  expect(models[0]?.flagModes).toHaveLength(1);
  expect(models[0]?.flagModes[0]).toMatchObject({
    serverless_mode: "priority",
    service_tier: "priority",
  });
  expect(models[1]?.flagModes).toHaveLength(1);
});

test("updates Fireworks pricing and modalities while preserving authored facts", () => {
  const model = buildFireworksModel(
    catalogModel(),
    existingModel(),
  );

  expect(model).toMatchObject({
    attachment: true,
    tool_call: true,
    cost: { input: 1.4, output: 4.4, cache_read: 0.14 },
    limit: { context: 1_048_573, output: 262_144 },
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    experimental: {
      modes: {
        priority: {
          cost: { input: 1.75, output: 5.5, cache_read: 0.175 },
          provider: { body: { service_tier: "priority" } },
        },
      },
    },
  });
});

test("derives cost from Fireworks when the local model has no cost", () => {
  const { cost: _, ...existing } = existingModel();
  const model = buildFireworksModel(catalogModel(), existing);

  expect(model.cost).toEqual({ input: 1.4, output: 4.4, cache_read: 0.14 });
});

test("uses the service-tier recipe for a priority-only model", () => {
  const priority = fireworksModel({ serverless_mode: "priority", service_tier: "priority" });
  const [model] = expandFireworksModels([priority]);

  expect(buildFireworksModel(model!, existingModel())).toMatchObject({
    provider: { body: { service_tier: "priority" } },
  });
});

test("clears a stale base service tier when the model returns to standard", () => {
  const model = buildFireworksModel(
    catalogModel({ service_tier: undefined }),
    {
      ...existingModel(),
      provider: { body: { service_tier: "priority" } },
    },
  );

  expect(model.provider).toBeUndefined();
});

test("removes a stale priority mode when Fireworks no longer lists it", () => {
  const model = buildFireworksModel(
    catalogModel({ flagModes: [] }),
    {
      ...existingModel(),
      experimental: {
        modes: {
          priority: {
            cost: { input: 2, output: 4 },
            provider: { body: { service_tier: "priority" } },
          },
        },
      },
    },
  );

  expect(model.experimental).toBeUndefined();
});

test("uses serverless modalities as authoritative", () => {
  const model = buildFireworksModel(
    catalogModel({ input_modalities: ["text"] }),
    {
      ...existingModel(),
      attachment: true,
      modalities: { input: ["text", "image", "video"], output: ["text"] },
    },
  );

  expect(model.modalities?.input).toEqual(["text"]);
  expect(model.attachment).toBe(false);
});

test("uses Fireworks context length only as an upper bound", () => {
  const model = buildFireworksModel(
    catalogModel({ context_length: 131_072 }),
    existingModel(),
  );

  expect(model.limit?.context).toBe(131_072);
  expect(model.limit?.output).toBe(131_072);
});

test("does not report Fireworks embedding rows as missing generation models", () => {
  const embedding = catalogModel({ output_modalities: ["embeddings"] });

  expect(fireworksAi.sourceID(embedding)).toBeUndefined();
  expect(fireworksAi.translateModel(embedding, {
    existing: () => existingModel(),
    authored: () => existingModel(),
  })).toBeUndefined();
});

function fireworksModel(overrides: Partial<FireworksModel> = {}): FireworksModel {
  return {
    id: "accounts/fireworks/models/example",
    object: "model",
    serverless_mode: "standard",
    pricing: [
      { sku: "LLM input tokens (cached)", amount: "0.14", unit: "1M tokens" },
      { sku: "LLM input tokens (uncached)", amount: "1.4", unit: "1M tokens" },
      { sku: "LLM output tokens", amount: "4.4", unit: "1M tokens" },
    ],
    display_name: "Example",
    description: "Example reasoning model",
    context_length: 1_048_576,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    created: 1_788_566_400,
    ...overrides,
  };
}

function inventoryModel(overrides: Partial<FireworksInventoryModel> = {}): FireworksInventoryModel {
  return {
    name: "accounts/fireworks/models/example",
    kind: "HF_BASE_MODEL",
    supportsServerless: true,
    ...overrides,
  };
}

function catalogModel(overrides: Partial<FireworksCatalogModel> = {}): FireworksCatalogModel {
  const model = fireworksModel(overrides);
  return {
    ...model,
    catalogId: overrides.catalogId ?? model.usage_identifier ?? model.id,
    flagModes: overrides.flagModes ?? [fireworksModel({
      serverless_mode: "priority",
      service_tier: "priority",
      pricing: [
        { sku: "LLM input tokens (cached)", amount: "0.175", unit: "1M tokens" },
        { sku: "LLM input tokens (uncached)", amount: "1.75", unit: "1M tokens" },
        { sku: "LLM output tokens", amount: "5.5", unit: "1M tokens" },
      ],
    })],
  };
}

function existingModel(): ExistingModel {
  return {
    name: "Example",
    description: "Example reasoning model",
    release_date: "2026-09-01",
    last_updated: "2026-09-01",
    attachment: false,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    temperature: true,
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 1, output: 2 },
    limit: { context: 1_048_573, output: 262_144 },
    modalities: { input: ["text"], output: ["text"] },
  };
}
