import { describe, expect, test } from "bun:test";

import worker, { type Env } from "../src/worker.js";

const providers = {
  mixed: {
    id: "mixed",
    models: {
      chat: { id: "chat" },
      jev: { id: "jev", category: "system-one" },
    },
  },
  default: {
    id: "default",
    models: { chat: { id: "chat" } },
  },
};

const models = {
  "example/chat": { id: "example/chat" },
  "typesafe/jev": { id: "typesafe/jev", category: "system-one" },
};

function setup() {
  const requested: string[] = [];
  const assets = {
    fetch(input: Request) {
      const url = new URL(input.url);
      requested.push(url.href);
      const data =
        url.pathname === "/_api.json"
          ? providers
          : url.pathname === "/_models.json"
            ? models
            : { providers, models };
      return Promise.resolve(
        Response.json(data, {
          headers: { "Access-Control-Allow-Origin": "*", ETag: "asset" },
        }),
      );
    },
  };
  const env = { ASSETS: assets } as Env;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const fetch = (path: string) =>
    worker.fetch(new Request(`https://models.dev${path}`), env, ctx);
  return { fetch, requested };
}

describe("model category filtering", () => {
  test("omits categorized models by default", async () => {
    const { fetch } = setup();
    const response = await fetch("/api.json");
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("etag")).toBeNull();
    expect(result).toEqual({
      mixed: { id: "mixed", models: { chat: { id: "chat" } } },
      default: { id: "default", models: { chat: { id: "chat" } } },
    });
  });

  test("selects an individual category and removes empty providers", async () => {
    const { fetch } = setup();
    const response = await fetch("/api.json?category=system-one");

    expect(await response.json()).toEqual({
      mixed: {
        id: "mixed",
        models: { jev: { id: "jev", category: "system-one" } },
      },
    });
  });

  test("applies category filtering to the model ID schema", async () => {
    const { fetch } = setup();
    const defaults = await fetch("/model-schema.json").then((response) =>
      response.json(),
    );
    const systemOne = await fetch(
      "/model-schema.json?category=system-one",
    ).then((response) => response.json());

    expect(defaults.$defs.Model.enum).toEqual([
      "default/chat",
      "mixed/chat",
    ]);
    expect(systemOne.$defs.Model.enum).toEqual(["mixed/jev"]);
  });

  test("all returns every model across every JSON endpoint", async () => {
    const { fetch, requested } = setup();

    expect(await fetch("/api.json?category=all").then((response) => response.json())).toEqual(providers);
    expect(await fetch("/models.json?category=all").then((response) => response.json())).toEqual(models);
    expect(await fetch("/catalog.json?category=all").then((response) => response.json())).toEqual({ providers, models });
    expect(requested.every((url) => !url.includes("category="))).toBe(true);
  });

  test("rejects unknown categories", async () => {
    const { fetch } = setup();
    const response = await fetch("/api.json?category=unknown");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid category. Expected one of: system-one, all",
    });
  });
});
