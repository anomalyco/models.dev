import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider } from "../src/sync/index.js";

import {
  fetchOllamaCloudModels,
  ollamaCloud,
  parseOllamaCloudModels,
  type OllamaCloudModel,
} from "../src/sync/providers/ollama-cloud.js";

const REPO = path.join(import.meta.dir, "../../..");

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

test("leaves shipped v2 files byte-identical, including time-of-day multipliers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ollama-cloud-sync-"));
  const modelsDir = path.join(dir, "providers/ollama-cloud/models");
  const ids = ["deepseek-v4-pro:0813", "glm-5.2", "kimi-k3"];
  await mkdir(modelsDir, { recursive: true });
  for (const id of ids) {
    await Bun.write(path.join(modelsDir, `${id}.toml`), Bun.file(path.join(REPO, "providers/ollama-cloud/models", `${id}.toml`)));
  }
  for (const lab of ["deepseek/deepseek-v4-pro-0813", "zhipuai/glm-5.2", "moonshotai/kimi-k3"]) {
    await mkdir(path.dirname(path.join(dir, "models", lab)), { recursive: true });
    await Bun.write(path.join(dir, "models", `${lab}.toml`), Bun.file(path.join(REPO, "models", `${lab}.toml`)));
  }
  const before = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));
  expect(before[0]).toContain("utc_hours");

  try {
    const result = await syncProvider({
      ...ollamaCloud,
      modelsDir,
      async fetchModels() {
        return { object: "list", data: [model(), model({ id: "kimi-k3" })] };
      },
    });
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    const after = await Promise.all(ids.map((id) => Bun.file(path.join(modelsDir, `${id}.toml`)).text()));
    expect(after).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
