import { describe, expect, spyOn, test } from "bun:test";

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

    expect(body.$defs.Model.enum).toEqual(["example/decision", "example/text"]);
  });

  test("rejects unknown model types", async () => {
    const response = await request("/api.json?type=unknown");

    expect(response.status).toBe(400);
  });

  test("serves experimental v2.0 api.json", async () => {
    const response = await request("/experimental/v2.0/api.json");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(providers);
  });
});

describe("hit tracking", () => {
  test("retries temporary stream failures with the original event", async () => {
    const bodies: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("posthog"))
          return new Response(null, { status: 204 });
        bodies.push(String(init?.body));
        return new Response(null, { status: bodies.length === 1 ? 503 : 204 });
      },
    );
    const pending: Promise<unknown>[] = [];
    try {
      await request("/api.json", { "user-agent": "bun/1.3.14" }, (promise) =>
        pending.push(promise),
      );
      await Promise.all(pending);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    } finally {
      fetch.mockRestore();
    }
  });

  test("reports permanent stream rejections", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) =>
        new Response(null, {
          status: String(input).includes("posthog") ? 204 : 401,
        }),
    );
    const pending: Promise<unknown>[] = [];
    try {
      await request("/api.json", { "user-agent": "opencode/test" }, (promise) =>
        pending.push(promise),
      );
      const results = await Promise.allSettled(pending);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      fetch.mockRestore();
    }
  });

  test("sends opencode hits to the lake event stream", async () => {
    const sent: Request[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
    );
    const pending: Promise<unknown>[] = [];
    try {
      await request(
        "/api.json?type=all",
        {
          "user-agent": "opencode/1.18.34",
          "cf-connecting-ip": "203.0.113.45",
          "cf-ipcountry": "US",
        },
        (promise) => pending.push(promise),
      );
      await Promise.all(pending);
    } finally {
      fetch.mockRestore();
    }

    const lake = sent.find((item) => item.url === "https://stream.example/");
    expect(lake?.method).toBe("POST");
    expect(lake?.headers.get("authorization")).toBe("Bearer lake-token");
    const events = await lake?.json();
    expect(events).toEqual([
      {
        source: "models",
        type: "hit",
        timestamp: expect.any(String),
        payload: {
          method: "GET",
          path: "/api.json",
          useragent: "opencode/1.18.34",
          ip: "203.0.113.45",
          cf_country: "US",
        },
      },
    ]);
  });
});

async function request(
  path: string,
  headers: Record<string, string> = { "user-agent": "test" },
  waitUntil: (promise: Promise<unknown>) => void = () => {},
) {
  const env = {
    PosthogToken: secret("posthog-token"),
    LakeEndpoint: secret("https://stream.example/"),
    LakeToken: secret("lake-token"),
    ASSETS: {
      fetch(input: Request) {
        const pathname = new URL(input.url).pathname;
        if (pathname === "/_experimental_v2.0_api.json") {
          return Response.json(providers);
        }
        if (pathname === "/_api.json") {
          return Response.json({
            example: { ...providers.example, models: { text: textModel } },
          });
        }
        if (pathname === "/_api-all.json") return Response.json(providers);
        if (pathname === "/_api-decision.json") {
          return Response.json({
            example: {
              ...providers.example,
              models: { decision: decisionModel },
            },
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
              example: {
                ...providers.example,
                models: { decision: decisionModel },
              },
            },
            models: { decision: decisionModel },
          });
        }
        return new Response(null, { status: 404 });
      },
    },
  } as unknown as Env;

  return worker.fetch(
    new Request(`https://models.dev${path}`, { headers }),
    env,
    { waitUntil } as unknown as ExecutionContext,
  );
}

function secret(value: string) {
  return JSON.stringify({ value });
}
