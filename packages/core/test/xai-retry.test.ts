import { afterEach, expect, test } from "bun:test";

import { fetchXAIWithRetry } from "../src/sync/providers/xai.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(statuses: number[]) {
  const seen: number[] = [];
  globalThis.fetch = (async () => {
    const status = statuses[seen.length] ?? 200;
    seen.push(status);
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return seen;
}

test("retries a one-off 503 from xAI and returns the next good response", async () => {
  const seen = respond([503, 200]);
  const response = await fetchXAIWithRetry("https://api.x.ai/v1/image-generation-models", {}, 4, () => 0);
  expect(response.status).toBe(200);
  expect(seen).toEqual([503, 200]);
});

test("returns the error once every attempt fails, so the sync still fails", async () => {
  const seen = respond([503, 503, 503, 503, 200]);
  const response = await fetchXAIWithRetry("https://api.x.ai/v1/image-generation-models", {}, 4, () => 0);
  expect(response.status).toBe(503);
  expect(seen).toHaveLength(4);
});

test("doesn't retry a client error", async () => {
  const seen = respond([401, 200]);
  const response = await fetchXAIWithRetry("https://api.x.ai/v1/api-key", {}, 4, () => 0);
  expect(response.status).toBe(401);
  expect(seen).toEqual([401]);
});
