import { expect, test } from "bun:test";
import { OPT_IN_PROVIDERS } from "@models.dev/core";
import { Providers, RenderedPages, SearchIndexJson } from "../src/render";

test("default website and search do not offer the opt-in providers", () => {
  expect(Providers["github-copilot"]).toBeDefined();
  expect(RenderedPages.has("/providers/github-copilot")).toBe(true);
  for (const id of OPT_IN_PROVIDERS) {
    expect(Providers[id]).toBeUndefined();
    expect(RenderedPages.has(`/providers/${id}`)).toBe(false);
    expect(SearchIndexJson).not.toContain(id);
    for (const page of RenderedPages.values()) {
      expect(page.html).not.toContain(`/providers/${id}`);
    }
  }
});
