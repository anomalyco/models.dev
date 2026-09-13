import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AuthoredModel, ModelMetadata, Provider } from "../src/index.js";

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

describe("parameters schema", () => {
  const metadata = {
    id: "lab/model",
    name: "Example Model",
    description: "Example model for parameter schema tests",
    open_weights: true,
  };

  test("accepts total-only parameters with source", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: {
          total: 30_500_000_000,
          source: "https://huggingface.co/lab/model/blob/main/config.json",
        },
      }).success,
    ).toBe(true);
  });

  test("accepts total-only estimate without source", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 30_500_000_000, estimate: true },
      }).success,
    ).toBe(true);
  });

  test("rejects parameters with neither source nor estimate", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 30_500_000_000 },
      }).success,
    ).toBe(false);

    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 30_500_000_000, estimate: false },
      }).success,
    ).toBe(false);
  });

  test("accepts MoE total with active and architecture", () => {
    const result = ModelMetadata.safeParse({
      ...metadata,
      parameters: {
        total: 671_000_000_000,
        active: 37_000_000_000,
        architecture: "moe",
        source: "https://huggingface.co/lab/model/blob/main/config.json",
      },
    });

    expect(result.success).toBe(true);
  });

  test("rejects active exceeding total", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: {
          total: 3_000_000_000,
          active: 30_000_000_000,
          architecture: "moe",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects zero or negative totals", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 0 },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown parameter fields", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 1_000, layers: 32 },
      }).success,
    ).toBe(false);
  });

  test("rejects invalid source URLs", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: { total: 1_000, source: "not-a-url" },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown architecture values", () => {
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: {
          total: 1_000,
          architecture: "sparse",
          source: "https://huggingface.co/lab/model/blob/main/config.json",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects active parameters when architecture is not a MoE variant", () => {
    // hybrid with MoE routing is allowed alongside moe
    expect(
      ModelMetadata.safeParse({
        ...metadata,
        parameters: {
          total: 32_000_000_000,
          active: 9_000_000_000,
          architecture: "hybrid",
          source: "https://huggingface.co/lab/model/blob/main/config.json",
        },
      }).success,
    ).toBe(true);

    for (const architecture of ["dense", undefined] as const) {
      expect(
        ModelMetadata.safeParse({
          ...metadata,
          parameters: {
            total: 30_500_000_000,
            active: 3_000_000_000,
            architecture,
            source: "https://huggingface.co/lab/model/blob/main/config.json",
          },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects fractional parameter counts", () => {
    for (const parameters of [
      { total: 30_500_000_000.5 },
      { total: 30_500_000_000, active: 3_200_000_000.5, architecture: "moe" },
    ]) {
      expect(
        ModelMetadata.safeParse({
          ...metadata,
          parameters: {
            ...parameters,
            source: "https://huggingface.co/lab/model/blob/main/config.json",
          },
        }).success,
      ).toBe(false);
    }
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
