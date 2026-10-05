import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import {
  buildNearAIModel,
  fetchNearAIModels,
  labModelID,
  nearai,
  type NearAIModel,
} from "../src/sync/providers/nearai.js";

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

function nearAIModel(overrides: Partial<NearAIModel> = {}): NearAIModel {
  return {
    id: "Qwen/Qwen3.6-35B-A3B-FP8",
    object: "model",
    created: 1_759_104_000,
    owned_by: "nearai",
    name: "Qwen 3.6 35B A3B FP8",
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
    name: "Qwen 3.6 35B A3B FP8",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    tool_call: true,
    structured_output: true,
    open_weights: true,
    cost: { input: 1.4, output: 4.4, cache_write: 0.5 },
    limit: { context: 202_752, output: 64_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
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

  expect(built).toMatchObject({ modalities: { input: ["text", "image"] } });
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

test("takes no capability from supported_features, which misreports both ways", () => {
  const built = buildNearAIModel(
    nearAIModel({ supported_features: ["tools", "structured_outputs", "reasoning"] }),
    authored({ tool_call: false, structured_output: false, reasoning: false }),
  );

  expect(built).toMatchObject({
    tool_call: false,
    structured_output: false,
    reasoning: false,
  });
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

test("keeps the authored cache price when the catalog publishes an unparseable one", () => {
  const built = buildNearAIModel(
    nearAIModel({ pricing: { input: 1.4, output: 4.4, input_cache_read: "n/a" } }),
    authored({ cost: { input: 1.4, output: 4.4, cache_read: 0.26 } }),
  );

  expect(built).toMatchObject({ cost: { cache_read: 0.26 } });
});

test("keeps an unpriced local entry rather than aborting the run or deleting it", () => {
  const model = nearAIModel();
  const entry = authored({ cost: undefined });
  const translated = nearai.translateModel(model, context({ [model.id]: entry }));

  expect(translated?.id).toBe(model.id);
  expect(translated?.model).toEqual(entry);
});

test("names the models held off the catalog on purpose", () => {
  const notice = nearai.skippedNotice(["openai/privacy-filter"]);

  expect(notice[0]).toContain("held off the catalog on purpose");
  expect(notice[1]).toContain("`openai/privacy-filter`");
});

test("creates a curated model as an override-only base_model overlay", () => {
  const translated = nearai.translateModel(
    nearAIModel({
      id: "z-ai/glm-5.3-flash",
      pricing: { input: 0.15, output: 0.5, input_cache_read: "0.000000035" },
    }),
    context({}),
  );

  expect(translated?.model).toEqual({
    base_model: "zhipuai/glm-5.3-flash",
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    modalities: { input: ["text", "image"] },
    cost: { input: 0.15, output: 0.5, cache_read: 0.035 },
  });
});

test("narrows a create to the inputs the route reports, not the lab's", () => {
  const translated = nearai.translateModel(
    nearAIModel({ id: "z-ai/glm-5.3-flash", input_modalities: ["text", "image"] }),
    context({}),
  );

  expect(translated?.model).not.toHaveProperty("limit");
  expect((translated?.model as { modalities: { input: string[] } }).modalities.input)
    .not.toContain("pdf");
});

test("writes the probed evidence as the created file's leading comment", () => {
  const translated = nearai.translateModel(
    nearAIModel({ id: "z-ai/glm-5.3-flash" }),
    context({}),
  );

  expect(translated?.header).toContain("# Toggle: chat_template_kwargs.enable_thinking");
  expect(translated?.header).toContain("reasoning_tokens: no parameter 394/389/389");
});

test("holds back a live reasoning model nobody has probed", () => {
  expect(() => nearai.translateModel(nearAIModel({ id: "deepseek/deepseek-v9" }), context({})))
    .toThrow(/deepseek\/deepseek-v9: live on NEAR AI Cloud but not published/);
});

test("holds back an uncurated model the catalog does not call a reasoner", () => {
  const model = nearAIModel({ id: "deepseek/deepseek-v9", supported_features: ["tools"] });

  expect(() => nearai.translateModel(model, context({})))
    .toThrow(/live on NEAR AI Cloud but not published/);
});

test("creates nothing for a model curated as deliberately unpublished", () => {
  const translated = nearai.translateModel(
    nearAIModel({ id: "openai/privacy-filter" }),
    context({}),
  );

  expect(translated).toBeUndefined();
});

test("maps the lab namespaces NEAR AI spells differently", () => {
  expect(labModelID("z-ai/glm-5.3-flash")).toBe("zhipuai/glm-5.3-flash");
  expect(labModelID("x-ai/grok-4.6")).toBe("xai/grok-4.6");
  expect(labModelID("Qwen/Qwen3.8-27B")).toBe("alibaba/qwen3.8-27b");
  expect(labModelID("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
});

test("refuses a truncated catalog rather than deleting the models it omits", async () => {
  const truncated = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ object: "list", data: [nearAIModel()] }),
        { headers: { "content-type": "application/json" } },
      ),
    );

  await expect(fetchNearAIModels(truncated as unknown as typeof fetch))
    .rejects.toThrow(/below the 20 needed to distinguish a retirement from a truncated response/);
});

test("fails the run rather than syncing from a degraded catalog response", async () => {
  const unavailable = () =>
    Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));

  await expect(fetchNearAIModels(unavailable as unknown as typeof fetch))
    .rejects.toThrow(/503 Service Unavailable/);
});
