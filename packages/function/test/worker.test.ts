import { describe, expect, test } from "bun:test";

import worker, { type Env } from "../src/worker.js";

const textModel = {
  id: "text-model",
  modalities: { input: ["text"], output: ["text"] },
};
const decisionModel = {
  id: "decision-model",
  type: "decision",
  modalities: { input: ["text"], output: ["text"] },
};
const providers = {
  example: {
    id: "example",
    models: { text: textModel, decision: decisionModel },
  },
};
const models = { text: textModel, decision: decisionModel };

describe("catalog API model type filtering", () => {
  test("omits typed models from api.json by default", async () => {
    const response = await request("/api.json");
    const body = await response.json();

    expect(Object.keys(body.example.models)).toEqual(["text"]);
  });

  test("omits typed models from models.json by default", async () => {
    const response = await request("/models.json");
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["text"]);
  });

  test("omits typed models from catalog.json by default", async () => {
    const response = await request("/catalog.json");
    const body = await response.json();

    expect(Object.keys(body.models)).toEqual(["text"]);
    expect(Object.keys(body.providers.example.models)).toEqual(["text"]);
  });

  test("returns explicitly requested decision models", async () => {
    const response = await request("/catalog.json?type=decision");
    const body = await response.json();

    expect(Object.keys(body.models)).toEqual(["decision"]);
    expect(Object.keys(body.providers.example.models)).toEqual(["decision"]);
  });

  test("returns the complete static catalog for all", async () => {
    const response = await request("/models.json?type=all");
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["text", "decision"]);
  });

  test("omits typed models from model-schema.json by default", async () => {
    const response = await request("/model-schema.json");
    const body = await response.json();

    expect(body.$defs.Model.enum).toEqual(["example/text"]);
  });

  test("includes typed models in model-schema.json when requested", async () => {
    const response = await request("/model-schema.json?type=all");
    const body = await response.json();

    expect(body.$defs.Model.enum).toEqual([
      "example/decision",
      "example/text",
    ]);
  });

  test("rejects unknown model types", async () => {
    const response = await request("/api.json?type=unknown");

    expect(response.status).toBe(400);
  });
});

async function request(path: string) {
  const env = {
    ASSETS: {
      fetch(input: Request) {
        const pathname = new URL(input.url).pathname;
        if (pathname === "/_api.json") {
          return Response.json({
            example: { ...providers.example, models: { text: textModel } },
          });
        }
        if (pathname === "/_api-all.json") return Response.json(providers);
        if (pathname === "/_api-decision.json") {
          return Response.json({
            example: { ...providers.example, models: { decision: decisionModel } },
          });
        }
        if (pathname === "/_models.json") {
          return Response.json({ text: textModel });
        }
        if (pathname === "/_models-all.json") return Response.json(models);
        if (pathname === "/_models-decision.json") {
          return Response.json({ decision: decisionModel });
        }
        if (pathname === "/_catalog.json") {
          return Response.json({
            providers: {
              example: { ...providers.example, models: { text: textModel } },
            },
            models: { text: textModel },
          });
        }
        if (pathname === "/_catalog-all.json") {
          return Response.json({ providers, models });
        }
        if (pathname === "/_catalog-decision.json") {
          return Response.json({
            providers: {
              example: { ...providers.example, models: { decision: decisionModel } },
            },
            models: { decision: decisionModel },
          });
        }
        return new Response(null, { status: 404 });
      },
    },
  } as unknown as Env;

  return worker.fetch(
    new Request(`https://models.dev${path}`, {
      headers: { "user-agent": "test" },
    }),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
}
