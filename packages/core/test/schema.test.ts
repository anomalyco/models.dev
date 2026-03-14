import { describe, expect, it } from "bun:test";
import { Model, Provider } from "../src/schema.js";

// ── Minimal valid model fixture ───────────────────────────────────────────────
const validModel = {
  id: "test-model",
  name: "Test Model",
  attachment: false,
  reasoning: false,
  tool_call: true,
  open_weights: false,
  release_date: "2024-01",
  last_updated: "2024-06",
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 128000, output: 4096 },
} as const;

// ── Minimal valid provider fixture ────────────────────────────────────────────
const validProvider = {
  id: "test-provider",
  name: "Test Provider",
  npm: "@ai-sdk/openai",
  env: ["TEST_API_KEY"],
  doc: "https://example.com/docs",
  models: {},
};

describe("Model schema", () => {
  it("accepts a minimal valid model", () => {
    const result = Model.safeParse(validModel);
    expect(result.success).toBe(true);
  });

  it("accepts a model with all optional fields", () => {
    const result = Model.safeParse({
      ...validModel,
      family: "gpt",
      temperature: true,
      structured_output: true,
      knowledge: "2024-09",
      status: "beta",
      cost: { input: 2.5, output: 10.0, cache_read: 0.25, cache_write: 3.125 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra (unknown) fields due to .strict()", () => {
    const result = Model.safeParse({ ...validModel, unknown_field: "oops" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required name", () => {
    const { name: _name, ...noName } = validModel;
    const result = Model.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it("rejects empty model name", () => {
    const result = Model.safeParse({ ...validModel, name: "" });
    expect(result.success).toBe(false);
  });

  // 1b: reasoning error message was wrong — validate the field validates correctly
  it("rejects negative reasoning cost", () => {
    const result = Model.safeParse({
      ...validModel,
      reasoning: true,
      cost: { input: 1, output: 1, reasoning: -5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const reasoningError = result.error.issues.find(
        (i) => i.path.includes("reasoning") && i.path.includes("cost"),
      );
      expect(reasoningError).toBeDefined();
      // Verify the error message is about reasoning, not input
      expect(reasoningError?.message).toContain("Reasoning price");
    }
  });

  it("rejects negative input cost", () => {
    const result = Model.safeParse({
      ...validModel,
      cost: { input: -1, output: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const inputError = result.error.issues.find(
        (i) => i.path.includes("input") && i.path.includes("cost"),
      );
      expect(inputError?.message).toContain("Input price");
    }
  });

  it("rejects cost.reasoning when reasoning=false", () => {
    const result = Model.safeParse({
      ...validModel,
      reasoning: false,
      cost: { input: 1, output: 1, reasoning: 5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.error.issues.find((i) =>
        i.path.includes("reasoning"),
      );
      expect(err).toBeDefined();
    }
  });

  it("accepts cost.reasoning when reasoning=true", () => {
    const result = Model.safeParse({
      ...validModel,
      reasoning: true,
      cost: { input: 1, output: 1, reasoning: 5 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts context_over_200k pricing", () => {
    const result = Model.safeParse({
      ...validModel,
      cost: {
        input: 3,
        output: 15,
        context_over_200k: { input: 6, output: 30 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid modality values", () => {
    const result = Model.safeParse({
      ...validModel,
      modalities: { input: ["text", "telepathy"], output: ["text"] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid input modalities", () => {
    const result = Model.safeParse({
      ...validModel,
      modalities: { input: ["text", "audio", "image", "video", "pdf"], output: ["text"] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid status values", () => {
    for (const status of ["alpha", "beta", "deprecated"] as const) {
      const result = Model.safeParse({ ...validModel, status });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid status values", () => {
    const result = Model.safeParse({ ...validModel, status: "production" });
    expect(result.success).toBe(false);
  });

  it("accepts valid date formats", () => {
    expect(
      Model.safeParse({ ...validModel, release_date: "2024-01" }).success,
    ).toBe(true);
    expect(
      Model.safeParse({ ...validModel, release_date: "2024-01-15" }).success,
    ).toBe(true);
  });

  it("rejects invalid date formats", () => {
    expect(
      Model.safeParse({ ...validModel, release_date: "2024" }).success,
    ).toBe(false);
    expect(
      Model.safeParse({ ...validModel, release_date: "01-2024" }).success,
    ).toBe(false);
    expect(
      Model.safeParse({ ...validModel, release_date: "not-a-date" }).success,
    ).toBe(false);
  });

  it("accepts interleaved as boolean true", () => {
    const result = Model.safeParse({ ...validModel, reasoning: true, interleaved: true });
    expect(result.success).toBe(true);
  });

  it("accepts interleaved as object with field", () => {
    const result = Model.safeParse({
      ...validModel,
      reasoning: true,
      interleaved: { field: "reasoning_content" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects interleaved with invalid field value", () => {
    const result = Model.safeParse({
      ...validModel,
      reasoning: true,
      interleaved: { field: "invalid_field" },
    });
    expect(result.success).toBe(false);
  });
});

describe("Provider schema", () => {
  it("accepts a minimal valid provider", () => {
    const result = Provider.safeParse(validProvider);
    expect(result.success).toBe(true);
  });

  it("rejects openai-compatible without api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@ai-sdk/openai-compatible",
    });
    expect(result.success).toBe(false);
  });

  it("accepts openai-compatible with api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.example.com/v1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects openrouter without api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@openrouter/ai-sdk-provider",
    });
    expect(result.success).toBe(false);
  });

  it("accepts anthropic without api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@ai-sdk/anthropic",
    });
    expect(result.success).toBe(true);
  });

  it("accepts anthropic with optional api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@ai-sdk/anthropic",
      api: "https://custom.anthropic.endpoint.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown provider npm with api field", () => {
    const result = Provider.safeParse({
      ...validProvider,
      npm: "@ai-sdk/some-other-provider",
      api: "https://example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty env array", () => {
    const result = Provider.safeParse({ ...validProvider, env: [] });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields due to .strict()", () => {
    const result = Provider.safeParse({
      ...validProvider,
      unknown_field: "oops",
    });
    expect(result.success).toBe(false);
  });
});
