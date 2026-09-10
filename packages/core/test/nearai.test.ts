import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildNearAIModel,
  type NearAIModel,
} from "../src/sync/providers/nearai.js";

function nearAIModel(overrides: Partial<NearAIModel> = {}): NearAIModel {
  return {
    id: "zai-org/GLM-5.1-FP8",
    object: "model",
    created: 1_759_104_000,
    owned_by: "zai-org",
    name: "GLM 5.1 FP8",
    pricing: { input: 1.4, output: 4.4, input_cache_read: "0.00000026" },
    context_length: 202_752,
    max_output_length: 16_384,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: ["tools", "structured_outputs", "reasoning"],
    ...overrides,
  };
}

// A full provider definition rather than a base_model overlay, so these assert
// the mapping itself instead of how factorBaseModel diffs against a lab file.
function authored(overrides: Record<string, unknown> = {}): ExistingModel {
  return {
    name: "GLM 5.1 FP8",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 1.4, output: 4.4, cache_write: 0.5 },
    limit: { context: 202_752, output: 64_000 },
    modalities: { input: ["text", "pdf"], output: ["text"] },
    ...overrides,
  } as ExistingModel;
}

test("keeps hand-authored reasoning when the catalog omits the feature", () => {
  const built = buildNearAIModel(
    nearAIModel({ supported_features: ["tools"] }),
    authored(),
  );

  expect(built).toMatchObject({
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  });
});

test("converts the per-token cache price to dollars per million tokens", () => {
  const built = buildNearAIModel(nearAIModel(), authored());

  expect(built).toMatchObject({ cost: { cache_read: 0.26 } });
});

test("rounds away the catalog's floating point artifacts", () => {
  const built = buildNearAIModel(
    nearAIModel({ pricing: { input: 1.4000000000000001, output: 4.4 } }),
    authored(),
  );

  expect(built).toMatchObject({ cost: { input: 1.4, output: 4.4 } });
});

test("preserves a locally authored cost the catalog does not publish", () => {
  const built = buildNearAIModel(nearAIModel(), authored());

  expect(built).toMatchObject({ cost: { cache_write: 0.5 } });
});

test("caps context at the lower of local and gateway, and never raises it", () => {
  const built = buildNearAIModel(
    nearAIModel({ owned_by: "nearai", context_length: 1_000_000 }),
    authored({ limit: { context: 202_752, output: 131_072 } }),
  );

  expect(built).toMatchObject({ limit: { context: 202_752 } });
});

test("ignores the context a relayed route reports, which can round below the lab", () => {
  const built = buildNearAIModel(
    nearAIModel({ owned_by: "openai", context_length: 1_000_000 }),
    authored({ limit: { context: 1_047_576, output: 32_768 } }),
  );

  expect(built).toMatchObject({ limit: { context: 1_047_576 } });
});

test("leaves the output limit authored, since max_output_length is not enforced", () => {
  const built = buildNearAIModel(
    nearAIModel({ max_output_length: 16_384 }),
    authored({ limit: { context: 202_752, output: 131_072 } }),
  );

  expect(built).toMatchObject({ limit: { output: 131_072 } });
});

test("retains a modality the gateway does not advertise", () => {
  const built = buildNearAIModel(nearAIModel(), authored());

  expect(built).toMatchObject({ modalities: { input: ["text", "pdf"] } });
});

test("does not widen a hand-narrowed modality the gateway over-reports", () => {
  const built = buildNearAIModel(
    nearAIModel({ input_modalities: ["text", "image"] }),
    authored({ modalities: { input: ["text"], output: ["text"] } }),
  );

  expect(built).toMatchObject({ modalities: { input: ["text"] } });
});

test("ignores an output modality the catalog schema cannot express", () => {
  const built = buildNearAIModel(
    nearAIModel({ output_modalities: ["embedding"] }),
    authored(),
  );

  expect(built).toMatchObject({ modalities: { output: ["text"] } });
});

test("never withdraws a capability the catalog stops advertising", () => {
  const built = buildNearAIModel(
    nearAIModel({ supported_features: [] }),
    authored(),
  );

  expect(built).toMatchObject({ tool_call: true, structured_output: true });
});

test("leaves attachment as authored when the gateway claims an image route", () => {
  const built = buildNearAIModel(
    nearAIModel({ input_modalities: ["text", "image"] }),
    authored({ attachment: false, modalities: { input: ["text"], output: ["text"] } }),
  );

  expect(built).toMatchObject({ attachment: false });
});

test("routes an overlay through the base model rather than inlining it", () => {
  const built = buildNearAIModel(
    nearAIModel({ id: "anthropic/claude-sonnet-4-5" }),
    authored({ base_model: "anthropic/claude-sonnet-4-5" }),
  );

  expect(built).toMatchObject({
    base_model: "anthropic/claude-sonnet-4-5",
    cost: { input: 1.4, output: 4.4 },
  });
});

test("refuses to sync a model with no locally authored pricing", () => {
  expect(() => buildNearAIModel(nearAIModel(), authored({ cost: undefined })))
    .toThrow(/incomplete local pricing/);
});
