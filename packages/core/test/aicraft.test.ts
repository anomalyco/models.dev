import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  aicraft,
  fetchAICraftModels,
  parseAICraftModels,
  type AICraftModel,
} from "../src/sync/providers/aicraft.js";

function served(name: string): AICraftModel {
  return { model_name: name };
}

function priceList(count: number) {
  return {
    success: true,
    data: Array.from({ length: count }, (_, index) => served(`model-${index}`)),
  };
}

function context(bodies: Record<string, Record<string, unknown>>) {
  return {
    existing: (_id: string): ExistingModel | undefined => undefined,
    authored: (_id: string): ExistingModel | undefined => undefined,
    v2: (id: string) => bodies[id],
  };
}

test("refuses a truncated price list instead of reading it as removals", () => {
  expect(() => parseAICraftModels({ success: true, data: [] })).toThrow(/refusing to sync/);
  expect(() => parseAICraftModels(priceList(1))).toThrow(/returned 1 models/);
});

test("refuses a response with no model list at all", () => {
  expect(() => parseAICraftModels({ success: true })).toThrow();
  expect(() => parseAICraftModels({ success: true, data: null })).toThrow();
});

test("parses the model names the host serves", () => {
  const models = parseAICraftModels(priceList(120));
  expect(models).toHaveLength(120);
  expect(models[0]).toEqual({ model_name: "model-0" });
  expect(parseAICraftModels({ success: true, data: [...priceList(99).data, served("claude-4.5-sonnet")] })).toHaveLength(100);
});

test("rewrites a listed model from its own body and skips the rest", () => {
  const body = { schema: 2, base_model: "anthropic/claude-sonnet-4-5" };
  const providerContext = context({ "claude-4.5-sonnet": body });

  expect(aicraft.translateModel(served("claude-4.5-sonnet"), providerContext)).toEqual({
    id: "claude-4.5-sonnet",
    v2: body,
  });
  // A route the catalog does not list stays unlisted: no file, no notice, no issue.
  expect(aicraft.translateModel(served("veo-3.1-generate-001"), providerContext)).toBeUndefined();
});

test("fails the sync when the host answers with an error status", async () => {
  const failing = (async () =>
    new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;

  await expect(fetchAICraftModels(failing)).rejects.toThrow(/502/);
});

test("syncs only the IDs the catalog already authors", () => {
  expect(aicraft.skipCreates).toBe(true);
  expect(aicraft.deleteMissing).toBe(true);
  // No sourceID or missingModelID: an unlisted route must not open an issue.
  expect(Object.hasOwn(aicraft, "sourceID")).toBe(false);
  expect(Object.hasOwn(aicraft, "missingModelID")).toBe(false);
});
