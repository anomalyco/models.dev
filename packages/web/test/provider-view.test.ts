import { expect, test } from "bun:test";
import { Providers, RenderedPages, SearchIndexJson } from "../src/render";

test("default website and search do not offer the opt-in provider", () => {
  expect(Providers["openai-codex"]).toBeUndefined();
  expect(Providers["github-copilot"]).toBeDefined();
  expect(RenderedPages.has("/providers/openai-codex")).toBe(false);
  expect(RenderedPages.has("/providers/github-copilot")).toBe(true);
  expect(SearchIndexJson).not.toContain("openai-codex");
  for (const page of RenderedPages.values()) {
    expect(page.html).not.toContain("/providers/openai-codex");
  }
});
