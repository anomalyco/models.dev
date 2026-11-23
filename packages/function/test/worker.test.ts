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
const v2Providers = {
  ...providers,
  "github-copilot": { id: "github-copilot", models: { text: textModel } },
};
const optInProviders = {
  "openai-chatgpt": { id: "openai-chatgpt", models: { text: textModel } },
  "openai-codex": { id: "openai-codex", models: { text: textModel } },
};
const expandedProviders = { ...v2Providers, ...optInProviders };
function withOptIn(ids: readonly string[]) {
  return {
    ...v2Providers,
    ...Object.fromEntries(Object.entries(optInProviders).filter(([id]) => ids.includes(id))),
  };
}

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

  test("combines repeated type parameters", async () => {
    const response = await request("/models.json?type=chat&type=decision");
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["text", "decision"]);
  });

  test("gives filtered responses an ETag that revalidates", async () => {
    const response = await request("/models.json?type=decision,chat");
    const etag = response.headers.get("etag");
    const again = await request("/models.json?type=chat,decision", {
      "user-agent": "test",
      "if-none-match": etag ?? "",
    });

    expect(etag).toBe('W/"all;type=chat,decision"');
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
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
    expect(body).toEqual(v2Providers);
  });

  test("serves one experimental v2.0 type from its prebuilt file", async () => {
    const response = await request("/experimental/v2.0/api.json?type=decision");
    const body = await response.json();

    expect(response.headers.get("etag")).toBe('"v2-decision"');
    expect(Object.keys(body.example.models)).toEqual(["decision"]);
  });
});

describe("HEAD requests", () => {
  const head = (path: string) =>
    request(path, { "user-agent": "test" }, () => {}, "HEAD");

  for (const path of [
    "/api.json?type=chat,decision",
    "/models.json?type=chat,decision",
    "/catalog.json?type=chat,decision",
    "/experimental/v2.0/api.json?type=chat,decision",
    "/model-schema.json",
    "/model-schema.json?type=all",
  ]) {
    test(`answers HEAD ${path} like GET, without a body`, async () => {
      const get = await request(path);
      const response = await head(path);

      expect(response.status).toBe(200);
      expect(response.status).toBe(get.status);
      expect(response.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(response.headers.get("etag")).toBe(get.headers.get("etag"));
      expect(await response.text()).toBe("");
    });
  }

  test("keeps HEAD revalidation for filtered responses", async () => {
    const etag = (await request("/models.json?type=decision,chat")).headers.get("etag");
    const response = await request(
      "/models.json?type=chat,decision",
      { "user-agent": "test", "if-none-match": etag ?? "" },
      () => {},
      "HEAD",
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
  });

  test("passes HEAD for a prebuilt file straight to the asset", async () => {
    const response = await head("/api.json");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("experimental provider opt-in", () => {
  const endpoint = "/experimental/v2.0/api.json";

  test("requires opt-in even with type=all and leaves existing providers unchanged", async () => {
    for (const query of ["", "?type=all", "?include=unknown", "?include=openai,github-copilot"]) {
      const response = await request(endpoint + query);
      expect(await response.json()).toEqual(v2Providers);
    }
    for (const [query, ids] of [
      ["include=openai-codex", ["openai-codex"]],
      ["include=openai-chatgpt&include=unknown", ["openai-chatgpt"]],
      ["include=openai-codex,openai-chatgpt", ["openai-chatgpt", "openai-codex"]],
      ["include= openai-chatgpt, openai-codex,openai-codex &include=unknown", ["openai-chatgpt", "openai-codex"]],
    ] as const) {
      const response = await request(endpoint + "?" + query);
      expect(await response.json()).toEqual(withOptIn(ids));
    }
  });

  test("composes with single, repeated, and comma-separated type filters", async () => {
    for (const query of ["type=chat", "type=chat&type=decision", "type=decision,chat"]) {
      const expanded = await request(endpoint + "?include=openai-codex&" + query);
      expect((await expanded.json())["openai-codex"]).toEqual(expandedProviders["openai-codex"]);
      const defaults = await request(endpoint + "?" + query);
      expect((await defaults.json())["openai-codex"]).toBeUndefined();
    }
    const decision = await request(endpoint + "?include=openai-codex&type=decision");
    expect((await decision.json())["openai-codex"]).toBeUndefined();
    expect((await request(endpoint + "?include=openai-codex&type=invalid")).status).toBe(400);
  });

  test("separates static and composed view validators in both directions", async () => {
    const queries = [
      "",
      "?include=openai-codex",
      "?include=openai-chatgpt",
      "?include=openai-chatgpt,openai-codex",
      "?type=chat,decision",
      "?include=openai-codex&type=chat,decision",
    ];
    for (const query of queries) {
      const response = await request(endpoint + query);
      const etag = response.headers.get("etag")!;
      const again = await request(endpoint + query, { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      for (const other of queries.filter((value) => value !== query)) {
        expect((await request(endpoint + other, { "if-none-match": etag })).status).toBe(200);
      }
    }
  });

  test("include cannot add the provider to any v1 view, even with type=all", async () => {
    for (const path of ["/api.json", "/models.json", "/catalog.json", "/model-schema.json"]) {
      for (const query of ["", "type=all&"]) {
        const response = await request(path + "?" + query + "include=openai-codex,openai-chatgpt");
        const body = await response.text();
        expect(body).toBe(await (await request(path + "?" + query)).text());
        expect(body).not.toContain("openai-codex");
        expect(body).not.toContain("openai-chatgpt");
      }
    }
  });

  test("prebuilt v2 files retain direct static access", async () => {
    const defaults = await request("/_experimental_v2.0_api.json");
    expect(await defaults.json()).toEqual(v2Providers);
    const included = await request("/_experimental_v2.0_api-include-openai-chatgpt-openai-codex-all.json");
    expect(await included.json()).toEqual(expandedProviders);
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
  method = "GET",
) {
  const env = {
    PosthogToken: secret("posthog-token"),
    LakeEndpoint: secret("https://stream.example/"),
    LakeToken: secret("lake-token"),
    ASSETS: {
      fetch(input: Request) {
        const pathname = new URL(input.url).pathname;
        if (pathname.startsWith("/_experimental_v2.0_api")) {
          const view = Object.keys(optInProviders).filter((id) => pathname.includes(id));
          const type = pathname
            .replace("/_experimental_v2.0_api", "")
            .replace(/-include(-openai-(chatgpt|codex))+/, "")
            .replace(".json", "");
          const source = withOptIn(view);
          const value = type === "-decision"
            ? { example: { ...providers.example, models: { decision: decisionModel } } }
            : type === "-chat"
              ? Object.fromEntries(Object.entries(source).map(([id, provider]) => [
                  id, { ...provider, models: { text: textModel } },
                ]))
              : source;
          const etag = `"v2${view.map((id) => `-${id}`).join("")}${type}"`;
          const headers = { etag, "Cache-Control": "public, max-age=3600" };
          if (input.headers.get("if-none-match")?.includes(etag)) {
            return new Response(null, { status: 304, headers });
          }
          return Response.json(value, { headers });
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
        if (pathname === "/_models-all.json") {
          if (input.headers.get("if-none-match") === 'W/"all"') {
            return new Response(null, { status: 304, headers: { etag: 'W/"all"' } });
          }
          return Response.json(models, { headers: { etag: 'W/"all"' } });
        }
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
  // Like the real asset binding, answer HEAD with headers and no body.
  const assets = env.ASSETS.fetch.bind(env.ASSETS);
  env.ASSETS.fetch = (async (input: Request) => {
    const response = await assets(input);
    return input.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }) as typeof env.ASSETS.fetch;

  return worker.fetch(
    new Request(`https://models.dev${path}`, { headers, method }),
    env,
    { waitUntil } as unknown as ExecutionContext,
  );
}

function secret(value: string) {
  return JSON.stringify({ value });
}
