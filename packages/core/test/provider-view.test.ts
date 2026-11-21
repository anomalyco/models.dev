import { expect, test } from "bun:test";
import path from "node:path";
import {
  filterProvidersByModelType,
  generateCatalog,
  generateV2,
  includedOptIn,
  includedProviders,
  optInSets,
  optInSuffix,
  OPT_IN_PROVIDERS,
  providerView,
} from "../src/index.js";

test("opt-in providers are hidden unless named and the source remains unchanged", () => {
  const providers = {
    openai: {},
    "github-copilot": {},
    "github-copilot-enterprise": {},
    "openai-chatgpt": {},
    "openai-codex": {},
  };
  expect(providerView(providers, [])).toEqual({
    openai: {},
    "github-copilot": {},
    "github-copilot-enterprise": {},
  });
  expect(Object.keys(providerView(providers, ["openai-codex"]))).toEqual([
    "openai",
    "github-copilot",
    "github-copilot-enterprise",
    "openai-codex",
  ]);
  expect(Object.keys(providerView(providers, ["openai-chatgpt"]))).toEqual([
    "openai",
    "github-copilot",
    "github-copilot-enterprise",
    "openai-chatgpt",
  ]);
  expect(providerView(providers, ["openai-chatgpt", "openai-codex"])).toBe(providers);
  expect(providers["openai-codex"]).toEqual({});
});

test("include parses explicit provider IDs with whitespace, duplicates, and repeated parameters", () => {
  for (const query of ["", "type=all", "include=all", "include=openai"]) {
    expect(includedOptIn(new URLSearchParams(query))).toEqual([]);
  }
  expect([...includedProviders(new URLSearchParams(
    "include= openai-codex,openai-chatgpt,,openai-codex &include= github-copilot, openai-codex",
  ))]).toEqual(["openai-codex", "openai-chatgpt", "github-copilot"]);
  expect(includedOptIn(new URLSearchParams("include=openai-codex,openai-chatgpt,unknown"))).toEqual([
    "openai-chatgpt",
    "openai-codex",
  ]);
});

test("every opt-in set has its own prebuilt file", () => {
  const sets = optInSets();
  expect(sets).toEqual([[], ["openai-chatgpt"], ["openai-codex"], ["openai-chatgpt", "openai-codex"]]);
  expect(new Set(sets.map(optInSuffix)).size).toBe(sets.length);
  expect(optInSuffix([])).toBe("");
  for (const query of ["include=openai-codex", "include=openai-chatgpt", "include=openai-codex,openai-chatgpt"]) {
    expect(sets).toContainEqual(includedOptIn(new URLSearchParams(query)));
  }
});

// Both generators read the full repository catalog from disk.
test("real catalog retains existing providers, composes types, and leaves v1 alone", async () => {
  const root = path.join(import.meta.dir, "..", "..", "..");
  const providers = await generateV2(path.join(root, "providers"));
  const defaults = providerView(providers, []);
  for (const id of OPT_IN_PROVIDERS) {
    expect(providers[id]).toBeDefined();
    expect(defaults[id]).toBeUndefined();
  }
  expect(Object.keys(defaults)).toEqual(Object.keys(providers).filter((id) => !OPT_IN_PROVIDERS.includes(id)));
  for (const [id, provider] of Object.entries(defaults)) {
    expect(provider).toBe(providers[id]);
  }
  const expanded = filterProvidersByModelType(providerView(providers, OPT_IN_PROVIDERS), ["chat", "decision"]);
  for (const id of OPT_IN_PROVIDERS) expect(expanded[id]).toBeDefined();
  const v1 = await generateCatalog(root);
  for (const id of OPT_IN_PROVIDERS) expect(v1.providers[id]).toBeUndefined();
}, 30_000);
