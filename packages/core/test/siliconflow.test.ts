import { expect, test } from "bun:test";

import type { ExistingModel } from "../src/sync/index.js";
import { groups, providers } from "../src/sync/index.js";
import {
  fetchSiliconFlowModels,
  parseSiliconFlowModels,
  siliconflow,
  siliconflowCn,
  type SiliconFlowModel,
} from "../src/sync/providers/siliconflow.js";

// Two rows of GET https://api.siliconflow.cn/v1/models?sub_type=chat
// (2026-10-22), plus one fine-tune preset the endpoint also lists.
const CHAT_LIST = {
  object: "list",
  data: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model", created: 0, owned_by: "" },
    { id: "Pro/zai-org/GLM-5.2", object: "model", created: 0, owned_by: "" },
    { id: "LoRA/Qwen/Qwen2.5-7B-Instruct", object: "model", created: 0, owned_by: "" },
  ],
};

const [V41_ROW, GLM_ROW] = parseSiliconFlowModels(CHAT_LIST) as [SiliconFlowModel, SiliconFlowModel];

function context(entries: Record<string, ExistingModel>) {
  return { existing: (id: string) => entries[id], authored: (id: string) => entries[id] };
}

const BASE_OVERLAY: ExistingModel = { base_model: "deepseek/deepseek-v4-flash" };

// A full provider entry, so AuthoredModel has to accept every preserved field.
const FULL_ENTRY: ExistingModel = {
  name: "DeepSeek V3.2",
  description: "DeepSeek chat model for instruction following, coding, and analysis",
  attachment: false,
  reasoning: true,
  reasoning_options: [{ type: "toggle" }],
  tool_call: true,
  release_date: "2026-06-01",
  last_updated: "2026-06-01",
  modalities: { input: ["text"], output: ["text"] },
  open_weights: true,
  limit: { context: 164_000, output: 164_000 },
};

test("parses chat rows and ignores fine-tune presets", () => {
  expect(parseSiliconFlowModels(CHAT_LIST).map((model) => model.id)).toEqual([
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "Pro/zai-org/GLM-5.2",
  ]);
});

test("fails instead of treating a rejected sub_type filter as an empty catalog", () => {
  // The API answers an unsupported `sub_type` with 200 and null data.
  expect(() => parseSiliconFlowModels({ object: "list", data: null })).toThrow(/no model list/);
});

test("requests the chat filter with the host key", async () => {
  let seen: { url: string; authorization: string | null } | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    return new Response(JSON.stringify(CHAT_LIST), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchSiliconFlowModels({ endpoint: "https://api.siliconflow.cn/v1", key: "sk-test" }, fetcher);

  expect(seen?.url).toBe("https://api.siliconflow.cn/v1/models?sub_type=chat");
  expect(seen?.authorization).toBe("Bearer sk-test");
});

test("reports a failed request without leaking the key", async () => {
  const fetcher = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
  const error = await fetchSiliconFlowModels(
    { endpoint: "https://api.siliconflow.com/v1", key: "sk-secret" },
    fetcher,
  ).then(
    () => new Error("expected the request to fail"),
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

  expect(error.message).toContain("401");
  expect(error.message).not.toContain("sk-secret");
});

test("does not author a model that has no local file", () => {
  expect(siliconflowCn.translateModel(V41_ROW, context({}))).toBeUndefined();
});

test("keeps a base_model overlay byte-for-byte", () => {
  const translated = siliconflowCn.translateModel(GLM_ROW, context({ [GLM_ROW.id]: BASE_OVERLAY }));
  const model = (translated as { model?: unknown } | undefined)?.model;
  expect(model).toEqual(BASE_OVERLAY);
});

test("keeps every authored field of a full entry", () => {
  const translated = siliconflowCn.translateModel(V41_ROW, context({ [V41_ROW.id]: FULL_ENTRY }));
  const model = (translated as { model?: unknown } | undefined)?.model;
  expect(model).toEqual(FULL_ENTRY);
});

test("reports every remote chat id for the missing-model issue flow", () => {
  expect(siliconflowCn.sourceID?.(V41_ROW)).toBe("deepseek-ai/DeepSeek-V4.1-Flash");
  expect(siliconflowCn.skipCreates).toBe(true);
  expect(siliconflowCn.deleteMissing).toBe(false);
  expect(siliconflowCn.trackMissingModels).toBe(true);
});

test("requires the host-specific key", async () => {
  const [cnKey, globalKey] = [process.env.SILICONFLOW_CN_API_KEY, process.env.SILICONFLOW_API_KEY];
  delete process.env.SILICONFLOW_CN_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  try {
    await expect(siliconflowCn.fetchModels()).rejects.toThrow("SILICONFLOW_CN_API_KEY");
    await expect(siliconflow.fetchModels()).rejects.toThrow("SILICONFLOW_API_KEY");
  } finally {
    if (cnKey !== undefined) process.env.SILICONFLOW_CN_API_KEY = cnKey;
    if (globalKey !== undefined) process.env.SILICONFLOW_API_KEY = globalKey;
  }
});

test("is registered for both hosts and the direct group", () => {
  expect(providers.siliconflow).toBe(siliconflow);
  expect(providers["siliconflow-cn"]).toBe(siliconflowCn);
  expect(groups.direct).toContain("siliconflow");
  expect(groups.direct).toContain("siliconflow-cn");
});
