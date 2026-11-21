import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import {
  agentrouter,
  fetchAgentRouterModels,
  parseAgentRouterModels,
  type AgentRouterModel,
} from "../src/sync/providers/agentrouter.js";

const REPO = path.join(import.meta.dir, "../../..");

const response = {
  success: true,
  data: [
    {
      model_name: "gpt-6.1-sol",
      supported_endpoint_types: ["openai"],
      model_ratio: 4,
      completion_ratio: 5,
    },
    {
      model_name: "gpt-5.6-sol",
      supported_endpoint_types: ["openai"],
      model_ratio: 4,
      completion_ratio: 5,
    },
  ],
};

test("AgentRouter sync is registered for direct and hourly runs", () => {
  expect(providers.agentrouter).toBe(agentrouter);
  expect(groups.direct).toContain("agentrouter");
  expect(agentrouter).toMatchObject({
    skipCreates: true,
    trackMissingModels: true,
    deleteMissing: false,
  });
});

test("parses and normalizes the public AgentRouter inventory", () => {
  const models = parseAgentRouterModels(response);
  expect(models.map((model) => model.model_name)).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
  expect(models.map((model) => agentrouter.sourceID(model))).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
});

test("rejects incomplete, empty, and duplicate AgentRouter inventories", () => {
  expect(() => parseAgentRouterModels({ success: false, data: response.data })).toThrow();
  expect(() => parseAgentRouterModels({ success: true, data: [] })).toThrow();
  expect(() => parseAgentRouterModels({ success: true, data: [response.data[0], response.data[0]] }))
    .toThrow("Duplicate AgentRouter model ID: gpt-6.1-sol");
});

test("preserves authored metadata and reports unknown models", () => {
  const model = parseAgentRouterModels(response)[0]!;
  const authored: ExistingModel = {
    base_model: "openai/gpt-5.6-sol",
    reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
  };
  const context = {
    existing: () => authored,
    authored: () => authored,
  };
  expect(agentrouter.translateModel(model, context)).toEqual({ id: model.model_name, model: authored });

  const missing = { model_name: "new-model", supported_endpoint_types: ["openai"] } satisfies AgentRouterModel;
  expect(agentrouter.translateModel(missing, { existing: () => undefined, authored: () => undefined })).toBeUndefined();
  expect(agentrouter.skippedNotice([missing.model_name]).join(" ")).toContain(missing.model_name);
  expect(agentrouter.skippedNotice([])).toEqual([]);
});

test("fetches the public inventory without credentials and rejects HTTP failures", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Response.json(response);
  }) as typeof fetch;
  expect(await fetchAgentRouterModels(fetcher)).toEqual(response);
  expect(requests).toEqual([{ url: "https://agentrouter.org/api/pricing", init: undefined }]);

  const failing = (async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
  await expect(fetchAgentRouterModels(failing)).rejects.toThrow("AgentRouter pricing request failed: 503");
});

test("leaves shipped v2 files byte-identical and retains models absent from the inventory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentrouter-sync-"));
  const modelsDir = path.join(dir, "providers/agentrouter/models");
  const modelPath = path.join(modelsDir, "gpt-6.1-sol.toml");
  const files = [
    "providers/agentrouter/provider.toml",
    "providers/agentrouter/models/gpt-6.1-sol.toml",
    "models/openai/gpt-6.1-sol.toml",
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await Bun.write(path.join(dir, file), Bun.file(path.join(REPO, file)));
  }
  const before = await Bun.file(modelPath).text();

  try {
    const present = await syncProvider({
      ...agentrouter,
      modelsDir,
      async fetchModels() {
        return {
          success: true,
          data: [{ model_name: "gpt-6.1-sol", supported_endpoint_types: ["openai"] }],
        };
      },
    });
    expect(present).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
    expect(await Bun.file(modelPath).text()).toBe(before);

    const absent = await syncProvider({
      ...agentrouter,
      modelsDir,
      async fetchModels() {
        return {
          success: true,
          data: [{ model_name: "unknown-model", supported_endpoint_types: ["openai"] }],
        };
      },
    });
    expect(absent).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(absent.notices.join(" ")).toContain("gpt-6.1-sol.toml");
    expect(await Bun.file(modelPath).text()).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
