import { expect, test } from "bun:test";
import path from "node:path";
import {
  filterProvidersByModelType,
  generateCatalog,
  generateV2,
  includedProviders,
  providerView,
} from "../src/index.js";

test("only the new provider is opt-in and the source remains unchanged", () => {
  const providers = {
    openai: {},
    "github-copilot": {},
    "github-copilot-enterprise": {},
    "openai-codex": {},
  };
  expect(providerView(providers, false)).toEqual({
    openai: {},
    "github-copilot": {},
    "github-copilot-enterprise": {},
  });
  expect(providerView(providers, true)).toBe(providers);
  expect(providers["openai-codex"]).toEqual({});
});

test("include parses explicit provider IDs with whitespace, duplicates, and repeated parameters", () => {
  for (const query of ["", "type=all", "include=all", "include=openai-chatgpt"]) {
    expect(includedProviders(new URLSearchParams(query)).has("openai-codex")).toBe(false);
  }
  expect([...includedProviders(new URLSearchParams(
    "include= openai-codex,openai-chatgpt,,openai-codex &include= github-copilot, openai-codex",
  ))]).toEqual(["openai-codex", "openai-chatgpt", "github-copilot"]);
});

// Both generators read the full repository catalog from disk.
test("real catalog retains existing providers, composes types, and leaves v1 alone", async () => {
  const root = path.join(import.meta.dir, "..", "..", "..");
  const providers = await generateV2(path.join(root, "providers"));
  const defaults = providerView(providers, false);
  expect(providers["openai-codex"]).toBeDefined();
  expect(defaults["openai-codex"]).toBeUndefined();
  expect(Object.keys(defaults)).toEqual(Object.keys(providers).filter((id) => id !== "openai-codex"));
  for (const [id, provider] of Object.entries(defaults)) {
    expect(provider).toBe(providers[id]);
  }
  const expanded = filterProvidersByModelType(providerView(providers, true), ["chat", "decision"]);
  expect(expanded["openai-codex"]).toEqual(providers["openai-codex"]);
  const v1 = await generateCatalog(root);
  expect(v1.providers["openai-codex"]).toBeUndefined();
}, 30_000);
