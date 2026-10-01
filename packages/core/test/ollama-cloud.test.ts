import { expect, test } from "bun:test";

import {
  fetchOllamaCloudModels,
  ollamaCloud,
  parseOllamaCloudModels,
  type OllamaCloudModel,
} from "../src/sync/providers/ollama-cloud.js";

function model(overrides: Partial<OllamaCloudModel> = {}): OllamaCloudModel {
  return {
    id: "deepseek-v4-pro:0813",
    object: "model",
    created: 1_786_633_200,
    owned_by: "ollama",
    ...overrides,
  };
}

test("parses the public Ollama Cloud model inventory", () => {
  expect(parseOllamaCloudModels({
    object: "list",
    data: [model()],
  })).toEqual([model()]);
});

test("fetches the public Ollama Cloud model endpoint without authentication", async () => {
  let request: RequestInfo | URL | undefined;
  const fetcher: typeof fetch = async (input) => {
    request = input;
    return Response.json({ object: "list", data: [model()] });
  };

  await expect(fetchOllamaCloudModels(fetcher)).resolves.toEqual({
    object: "list",
    data: [model()],
  });
  expect(String(request)).toBe("https://ollama.com/v1/models");
});

test("tracks remote-only Ollama Cloud models without creating or deleting TOMLs", () => {
  expect(ollamaCloud.skipCreates).toBe(true);
  expect(ollamaCloud.trackMissingModels).toBe(true);
  expect(ollamaCloud.deleteMissing).toBe(false);
  expect(ollamaCloud.sourceID(model())).toBe("deepseek-v4-pro:0813");
});

test("preserves existing Ollama Cloud provider overrides", () => {
  const authored = {
    base_model: "deepseek/deepseek-v4-pro-0813",
    reasoning_options: [
      { type: "toggle" as const },
      { type: "effort" as const, values: ["high", "max"] },
    ],
    limit: { context: 1_048_576, output: 1_048_576 },
  };

  expect(ollamaCloud.translateModel(model(), {
    existing: () => undefined,
    authored: () => authored,
  })).toEqual({ id: "deepseek-v4-pro:0813", model: authored });
  expect(ollamaCloud.translateModel(model({ id: "new-model" }), {
    existing: () => undefined,
    authored: () => undefined,
  })).toBeUndefined();
});
