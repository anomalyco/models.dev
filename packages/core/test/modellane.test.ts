import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildModellaneModel,
  modellane,
  modellaneReasoningOptions,
  picoUsdToPerMillion,
  type ModellaneModel,
} from "../src/sync/providers/modellane.js";

// One row of https://usemodellane.com/v1/public/models (2026-11-28).
function modellaneModel(overrides: Partial<ModellaneModel> = {}): ModellaneModel {
  return {
    id: "modellane-glm-5.3-flash-abliterated",
    name: "GLM-5.3 Flash Abliterated",
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 1_000_000,
    inputModalities: ["text", "image"],
    features: ["streaming", "tools", "json_mode", "vision", "reasoning"],
    reasoningEfforts: ["low", "high", "max"],
    pricing: {
      inputPicoUsdPerToken: "240000",
      cachedInputPicoUsdPerToken: "80000",
      outputPicoUsdPerToken: "1000000",
    },
    ...overrides,
  };
}

function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    base_model: "zhipuai/glm-5.3-flash",
    name: "GLM-5.3 Flash Abliterated",
    reasoning: true,
    cost: { input: 0.24, output: 1, cache_read: 0.08 },
    limit: { context: 1_048_576, output: 1_000_000 },
    ...overrides,
  } as ExistingModel;
}

const resolved = {
  limit: { context: 1_048_576, output: 1_000_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
} as ExistingModel;

test("converts pico-USD per token to USD per million tokens", () => {
  expect(picoUsdToPerMillion("240000")).toBe(0.24);
  expect(picoUsdToPerMillion("38000")).toBe(0.038);
  expect(picoUsdToPerMillion("10000000")).toBe(10);

  const built = buildModellaneModel(
    modellaneModel({ pricing: { inputPicoUsdPerToken: "500000", cachedInputPicoUsdPerToken: "300000", outputPicoUsdPerToken: "5000000" } }),
    authored(),
    resolved,
  );
  expect(built).toMatchObject({ cost: { input: 0.5, cache_read: 0.3, output: 5 } });
});

test("writes catalog limits and keeps hand-authored fields", () => {
  const built = buildModellaneModel(modellaneModel({ contextWindowTokens: 262_144, maxOutputTokens: 65_536 }), authored(), resolved);

  expect(built).toMatchObject({
    base_model: "zhipuai/glm-5.3-flash",
    name: "GLM-5.3 Flash Abliterated",
    reasoning: true,
    limit: { context: 262_144, output: 65_536 },
  });
});

test("keeps inherited limits and modalities while the catalog agrees", () => {
  const built = buildModellaneModel(modellaneModel(), authored({ limit: undefined }), resolved);

  expect(built.limit).toBeUndefined();
  expect(built.modalities).toBeUndefined();
});

test("writes input modalities when the catalog differs from the file", () => {
  const built = buildModellaneModel(modellaneModel({ inputModalities: ["text"] }), authored(), resolved);

  expect(built.modalities).toEqual({ input: ["text"], output: ["text"] });
});

test("skips models without a file and fails on malformed inventories", () => {
  const none = { existing: () => undefined, authored: () => undefined };
  expect(modellane.translateModel(modellaneModel(), none)).toBeUndefined();
  expect(modellane.sourceID(modellaneModel())).toBe("modellane-glm-5.3-flash-abliterated");

  expect(() => modellane.parseModels({ models: [] })).toThrow();
  expect(() => modellane.parseModels({ models: [modellaneModel(), modellaneModel()] })).toThrow(/twice/);
  expect(() => modellane.parseModels({ models: [modellaneModel({ pricing: { inputPicoUsdPerToken: "0.24", outputPicoUsdPerToken: "1" } })] })).toThrow();
});

test("writes the catalog's effort levels low to high, none included", () => {
  expect(buildModellaneModel(modellaneModel(), authored(), resolved).reasoning_options).toEqual([
    { type: "effort", values: ["low", "high", "max"] },
  ]);
  expect(
    modellaneReasoningOptions(modellaneModel({ reasoningEfforts: ["max", "none", "high", "low"] }), authored()),
  ).toEqual([{ type: "effort", values: ["none", "low", "high", "max"] }]);
});

test("keeps authored reasoning controls when the catalog has none to give", () => {
  const kept = [{ type: "effort", values: ["low", "high"] }] as NonNullable<ExistingModel["reasoning_options"]>;
  const file = authored({ reasoning_options: kept });

  expect(modellaneReasoningOptions(modellaneModel({ reasoningEfforts: undefined }), file)).toEqual(kept);
  expect(modellaneReasoningOptions(modellaneModel({ reasoningEfforts: ["low", "turbo"] }), file)).toEqual(kept);
  expect(modellaneReasoningOptions(modellaneModel(), authored({ reasoning: false }))).toBeUndefined();
});

test("an empty effort list means no caller control", () => {
  expect(modellaneReasoningOptions(modellaneModel({ reasoningEfforts: [] }), authored())).toEqual([]);
});
