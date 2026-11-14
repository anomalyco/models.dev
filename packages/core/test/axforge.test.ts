import { expect, test } from "bun:test";

import { axforge, fetchAxForgeModels, parseAxForgeModels, type AxForgeModel } from "../src/sync/providers/axforge.js";

function model(overrides: Partial<AxForgeModel> = {}): AxForgeModel {
  return {
    id: "glm-5.3-flash",
    object: "model",
    created: 0,
    owned_by: "axforge",
    display_name: "GLM-5.3-Flash",
    type: "chat",
    context_length: 262_144,
    max_output_tokens: 65_536,
    input: ["text"],
    tools: true,
    ...overrides,
  };
}

test("parses the public AxForge model list", () => {
  expect(parseAxForgeModels({ object: "list", data: [model()] })).toEqual([model()]);
});

test("fetches the public AxForge model list without authentication", async () => {
  let request: RequestInfo | URL | undefined;
  const fetcher: typeof fetch = async (input) => {
    request = input;
    return Response.json({ object: "list", data: [model()] });
  };
  await expect(fetchAxForgeModels(fetcher)).resolves.toEqual({ object: "list", data: [model()] });
  expect(String(request)).toBe("https://api.axforge.ai/v1/public/models");
});

test("tracks remote-only chat models as issues, without creating or deleting TOMLs", () => {
  expect(axforge.skipCreates).toBe(true);
  expect(axforge.trackMissingModels).toBe(true);
  expect(axforge.deleteMissing).toBe(false);
  expect(axforge.sourceID(model())).toBe("glm-5.3-flash");
});

test("leaves the list's other kinds out", () => {
  const embeddings = model({ id: "qwen3-embed", type: "embeddings", input: undefined, tools: undefined });
  expect(axforge.sourceID(embeddings)).toBeUndefined();
  expect(axforge.translateModel(embeddings, { authored: () => undefined } as never)).toBeUndefined();
});

test("keeps an existing AxForge file as authored", () => {
  const authored = { base_model: "zhipuai/glm-5.3-flash", limit: { context: 262_144, output: 65_536 } };
  const out = axforge.translateModel(model(), { authored: () => authored } as never);
  expect(out).toEqual({ id: "glm-5.3-flash", model: authored as never });
});
