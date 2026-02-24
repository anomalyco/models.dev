import { describe, it, expect } from "bun:test";
import { flattenProviders } from "./data";

const mockApi = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-3-5-haiku-20241022": {
        id: "claude-3-5-haiku-20241022",
        name: "Claude 3.5 Haiku",
        family: "claude-haiku",
        reasoning: false,
        tool_call: true,
        attachment: true,
        temperature: true,
        open_weights: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0.8, output: 4.0 },
        limit: { context: 200_000, output: 8_192 },
        release_date: "2024-11-04",
        last_updated: "2024-11-04",
      },
    },
  },
};

describe("flattenProviders", () => {
  it("creates one row per model", () => {
    const rows = flattenProviders(mockApi as any);
    expect(rows).toHaveLength(1);
  });

  it("adds providerId and providerName to each row", () => {
    const [row] = flattenProviders(mockApi as any);
    expect(row.providerId).toBe("anthropic");
    expect(row.providerName).toBe("Anthropic");
  });

  it("adds modelId to each row", () => {
    const [row] = flattenProviders(mockApi as any);
    expect(row.modelId).toBe("claude-3-5-haiku-20241022");
  });

  it("preserves model fields", () => {
    const [row] = flattenProviders(mockApi as any);
    expect(row.name).toBe("Claude 3.5 Haiku");
    expect(row.cost?.input).toBe(0.8);
    expect(row.limit.context).toBe(200_000);
  });

  it("filters out alpha models", () => {
    const apiWithAlpha = {
      ...mockApi,
      test: {
        name: "Test",
        models: {
          "alpha-model": {
            ...mockApi.anthropic.models["claude-3-5-haiku-20241022"],
            status: "alpha",
          },
        },
      },
    };
    const rows = flattenProviders(apiWithAlpha as any);
    expect(rows).toHaveLength(1); // alpha filtered out
  });
});
