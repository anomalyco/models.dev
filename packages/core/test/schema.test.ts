import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AuthoredModel, Provider } from "../src/index.js";

type AuthoredModelData = z.infer<typeof AuthoredModel>;

const dateFields = ["knowledge", "release_date", "last_updated"] as const;

describe("model schema", () => {
  test("rejects unknown nested model configuration fields", () => {
    const result = AuthoredModel.safeParse({
      ...baseModel({}),
      cost: {
        input: 1,
        output: 2,
        cache_reed: 0.1,
      },
      provider: {
        npm: "example-sdk",
        typo: true,
      },
      experimental: {
        typo: true,
        modes: {
          fast: {
            typo: true,
            provider: {
              typo: true,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "cost",
        "provider",
        "experimental",
        "experimental.modes.fast",
        "experimental.modes.fast.provider",
      ]),
    );
  });

  test("requires reasoning_options when reasoning is true", () => {
    const model = baseModel({ reasoning: true });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });

  test("accepts empty reasoning_options when reasoning is true", () => {
    const model = baseModel({
      reasoning: true,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(true);
  });

  test("rejects reasoning_options when reasoning is false", () => {
    const model = baseModel({
      reasoning: false,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });

  test("accepts calendar-valid model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-02",
        "2024-02-29",
        "2000-02-29",
        "2026-12-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(true);
      }
    }
  });

  test("rejects impossible model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-00",
        "2026-13",
        "2025-02-29",
        "1900-02-29",
        "2026-02-30",
        "2026-04-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
  });
});

describe("cost tiers", () => {
  function withTiers(tiers: unknown) {
    return AuthoredModel.safeParse({
      ...baseModel({}),
      cost: { input: 1, output: 2, tiers },
    });
  }

  test("keeps accepting context tiers authored without an explicit type", () => {
    const result = withTiers([{ tier: { size: 200_000 }, input: 2, output: 4 }]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.cost?.tiers?.[0]?.tier).toEqual({
      type: "context",
      size: 200_000,
    });
  });

  test("accepts time tiers with UTC windows", () => {
    expect(
      withTiers([
        {
          tier: { type: "time", windows: ["01:00-04:00", "06:00-10:00"] },
          input: 0.44,
          output: 1.32,
          cache_read: 0.014,
        },
      ]).success,
    ).toBe(true);
  });

  test("accepts a window that wraps past midnight", () => {
    expect(
      withTiers([
        { tier: { type: "time", windows: ["22:00-02:00"] }, input: 2, output: 4 },
      ]).success,
    ).toBe(true);
  });

  test("rejects malformed windows", () => {
    for (const window of [
      "1:00-4:00",
      "24:00-25:00",
      "01:00",
      "01:00-04:60",
      "01:00 - 04:00",
    ]) {
      expect(
        withTiers([
          { tier: { type: "time", windows: [window] }, input: 2, output: 4 },
        ]).success,
      ).toBe(false);
    }
  });

  test("rejects a window that starts and ends at the same minute", () => {
    expect(
      withTiers([
        { tier: { type: "time", windows: ["01:00-01:00"] }, input: 2, output: 4 },
      ]).success,
    ).toBe(false);
  });

  test("rejects a time tier with no windows", () => {
    expect(
      withTiers([{ tier: { type: "time", windows: [] }, input: 2, output: 4 }])
        .success,
    ).toBe(false);
  });

  test("rejects overlapping windows within one tier", () => {
    expect(
      withTiers([
        {
          tier: { type: "time", windows: ["01:00-04:00", "03:00-06:00"] },
          input: 2,
          output: 4,
        },
      ]).success,
    ).toBe(false);
  });

  test("rejects overlapping windows across tiers, including midnight wraps", () => {
    expect(
      withTiers([
        { tier: { type: "time", windows: ["22:00-02:00"] }, input: 2, output: 4 },
        { tier: { type: "time", windows: ["01:00-03:00"] }, input: 3, output: 5 },
      ]).success,
    ).toBe(false);
  });

  test("accepts adjacent windows, since the end is exclusive", () => {
    expect(
      withTiers([
        {
          tier: { type: "time", windows: ["01:00-04:00", "04:00-06:00"] },
          input: 2,
          output: 4,
        },
      ]).success,
    ).toBe(true);
  });

  test("rejects duplicate context sizes alongside a time tier", () => {
    expect(
      withTiers([
        { tier: { size: 200_000 }, input: 2, output: 4 },
        { tier: { size: 200_000 }, input: 3, output: 5 },
        { tier: { type: "time", windows: ["01:00-04:00"] }, input: 4, output: 6 },
      ]).success,
    ).toBe(false);
  });

  test("rejects unknown keys inside a tier", () => {
    expect(
      withTiers([
        {
          tier: { type: "time", windows: ["01:00-04:00"], timezone: "UTC" },
          input: 2,
          output: 4,
        },
      ]).success,
    ).toBe(false);
  });
});

describe("provider schema", () => {
  const mergeGatewayProvider = {
    id: "merge-gateway",
    name: "Merge Gateway",
    env: ["MERGE_GATEWAY_API_KEY"],
    npm: "merge-gateway-ai-sdk-provider",
    api: "https://api-gateway.merge.dev/v1/ai-sdk",
    doc: "https://docs.merge.dev/merge-gateway",
    models: {},
  };

  test("accepts Merge Gateway's native package with its OpenAI-compatible API", () => {
    expect(Provider.safeParse(mergeGatewayProvider).success).toBe(true);
  });

  test("requires the compatibility API for the Merge Gateway package", () => {
    const { api: _api, ...providerWithoutApi } = mergeGatewayProvider;

    expect(Provider.safeParse(providerWithoutApi).success).toBe(false);
  });
});

function baseModel(overrides: Partial<AuthoredModelData>) {
  return {
    id: "example/model",
    name: "Example Model",
    description: "Example model for schema validation and regression tests",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    open_weights: false,
    limit: {
      context: 1_000,
      output: 100,
    },
    cost: {
      input: 1,
      output: 2,
    },
    ...overrides,
  };
}
