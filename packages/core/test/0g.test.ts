import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncProvider, type ExistingModel } from "../src/sync/index.js";
import { MissingReasoningOptionsError } from "../src/sync/missing-reasoning-options.js";
import {
  buildZeroGModel,
  fetchZeroGModels,
  SYNCED_REASONING_HEADER,
  SYNCED_REASONING_MARKER,
  zerog,
  type ZeroGModel,
} from "../src/sync/providers/0g.js";

function context(
  entries: Record<string, ExistingModel>,
  v2: Record<string, Record<string, unknown>> = {},
  headers: Record<string, string> = {},
) {
  return {
    existing: (id: string) => entries[id],
    authored: (id: string) => entries[id],
    v2: (id: string) => v2[id],
    header: (id: string) => headers[id],
  };
}

function zeroGModel(overrides: Partial<ZeroGModel> = {}): ZeroGModel {
  return {
    id: "gpt-4.1",
    object: "model",
    owned_by: "0G Foundation",
    name: "GPT-4.1",
    type: "chatbot",
    context_length: 1_047_576,
    pricing_usd: { prompt: "0.000002", completion: "0.000008" },
    supported_parameters: ["tools", "tool_choice", "stream"],
    ...overrides,
  };
}

test("creates a non-reasoning model as a cost-only base_model overlay", () => {
  const translated = zerog.translateModel(zeroGModel(), context({}));

  expect(translated?.model as unknown).toEqual({
    base_model: "openai/gpt-4.1",
    cost: { input: 2, output: 8 },
  });
});

test("resolves a bare catalog id to its lab entry by normalized match", () => {
  const translated = zerog.translateModel(
    zeroGModel({ id: "gpt-4.1-nano", name: "GPT-4.1 Nano", pricing_usd: { prompt: "0.0000001", completion: "0.0000004" } }),
    context({}),
  );

  expect(translated?.model).toMatchObject({ base_model: "openai/gpt-4.1-nano" });
});

test("publishes the 5-minute cache write price and rounds float artifacts", () => {
  const translated = zerog.translateModel(
    zeroGModel({ pricing_usd: { prompt: "0.0000001234567891", completion: "0.000008", cache_write: "0.0000025", cache_write_1h: "0.000004" } }),
    context({}),
  );

  expect(translated?.model as unknown).toEqual({
    base_model: "openai/gpt-4.1",
    cost: { input: 0.123457, output: 8, cache_write: 2.5 },
  });
});

test("opens a research issue instead of creating a reasoning model", () => {
  const model = zeroGModel({ id: "glm-5.3-flash", name: "GLM-5.3 Flash" });

  expect(() => zerog.translateModel(model, context({}))).toThrow(MissingReasoningOptionsError);
  expect(zerog.missingModelID(model)).toBe("glm-5.3-flash");
});

test("reports a chat model with no lab entry as missing rather than creating it", () => {
  const model = zeroGModel({ id: "0gm-9.9-unknown", name: "0GM 9.9 Unknown" });

  expect(zerog.translateModel(model, context({}))).toBeUndefined();
  expect(zerog.missingModelID(model)).toBe("0gm-9.9-unknown");
});

test("skips media models silently", () => {
  const model = zeroGModel({ id: "flux-2-pro", type: "text-to-image", pricing_usd: {} });

  expect(zerog.sourceID(model)).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  expect(zerog.parseModels({ data: [model, zeroGModel()] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
});

test("updates only the price of an existing overlay", () => {
  const built = buildZeroGModel(
    zeroGModel({ pricing_usd: { prompt: "0.0000025", completion: "0.00001" } }),
    { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel,
  );

  expect(built).toMatchObject({ base_model: "openai/gpt-4.1", cost: { input: 2.5, output: 10 } });
});

test("keeps the published entry when the catalog garbles its price", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel;
  const translated = zerog.translateModel(
    zeroGModel({ pricing_usd: { prompt: "n/a", completion: "0.000008" } }),
    context({ "gpt-4.1": entry }),
  );

  expect(translated?.model as unknown).toEqual(entry);
});

test("refuses a truncated catalog rather than deleting the models it omits", async () => {
  const truncated = () =>
    Promise.resolve(new Response(JSON.stringify({ data: [zeroGModel()] }), { headers: { "content-type": "application/json" } }));

  await expect(fetchZeroGModels(truncated as unknown as typeof fetch))
    .rejects.toThrow(/below the 20 needed to distinguish a retirement from a truncated response/);
});

test("fails the run rather than syncing from a degraded catalog response", async () => {
  const unavailable = () => Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));

  await expect(fetchZeroGModels(unavailable as unknown as typeof fetch)).rejects.toThrow(/503 Service Unavailable/);
});

test("skips a listed model that does not serve, without opening an issue", () => {
  const model = zeroGModel({ id: "qwen2.5-vl-72b-instruct", name: "Qwen2.5-VL-72B-Instruct" });

  expect(zerog.sourceID(model)).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  expect(zerog.parseModels({ data: [model, zeroGModel()] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
});

test("keeps the published entry when the catalog leaves the price out", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } } as ExistingModel;
  const model = zeroGModel({ pricing_usd: {} });

  expect(zerog.parseModels({ data: [model] }).map((m) => m.id)).toEqual(["gpt-4.1"]);
  expect(zerog.translateModel(model, context({ "gpt-4.1": entry }))?.model as unknown).toEqual(entry);
});

test("does not create or report a new row that has no price", () => {
  const model = zeroGModel({ id: "gpt-4.1-nano", name: "GPT-4.1 Nano", pricing_usd: {} });

  expect(zerog.translateModel(model, context({}))).toBeUndefined();
  expect(zerog.missingModelID(model)).toBeUndefined();
  // Not listed by skippedNotice as lacking a lab entry, which it does not.
  expect(zerog.sourceID(model)).toBeUndefined();
});

test("publishes the 1h cache write price when the file lists the default and 1h TTLs", () => {
  const entry = { base_model: "openai/gpt-4.1", cost: { input: 2, output: 8, cache_write: 2.5 } } as ExistingModel;
  const model = zeroGModel({ pricing_usd: { prompt: "0.000002", completion: "0.000008", cache_write: "0.0000025", cache_write_1h: "0.000004" } });

  const listed = zerog.translateModel(model, context({ "gpt-4.1": entry }, { "gpt-4.1": { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } } }));
  expect(listed && "v2Set" in listed ? listed.v2Set : undefined).toEqual({ "cost.text.input.cache.write": { "5m": 2.5, "1h": 4 } });

  const unlisted = zerog.translateModel(model, context({ "gpt-4.1": entry }));
  expect(unlisted && "v2Set" in unlisted ? unlisted.v2Set : undefined).toBeUndefined();
});

const glmFlash = (overrides: Partial<ZeroGModel> = {}) =>
  zeroGModel({ id: "glm-5.3-flash", name: "GLM-5.3 Flash", pricing_usd: { prompt: "0.00000015", completion: "0.0000005" }, ...overrides });
// A reasoning model with no file in the repo.
const minimax = (overrides: Partial<ZeroGModel> = {}) =>
  zeroGModel({ id: "minimax-m3", name: "MiniMax M3", pricing_usd: { prompt: "0.00000027", completion: "0.00000108" }, ...overrides });
const block = (mandatory: unknown, supported_efforts?: unknown) =>
  ({ mandatory, ...(supported_efforts === undefined ? {} : { supported_efforts }), verified_at: "2026-11-24" });
const header = (translated: unknown) =>
  translated !== null && typeof translated === "object" && "header" in translated ? translated.header : undefined;
const notices = (translated: unknown) =>
  translated !== null && typeof translated === "object" && "notices" in translated ? translated.notices : undefined;

test("creates a reasoning model from the catalog's reasoning block, with the synced header", () => {
  const translated = zerog.translateModel(minimax({ reasoning: block(false, ["max", "low", "none"]) }), context({}));

  expect(translated?.model).toMatchObject({
    base_model: "minimax/MiniMax-M3",
    reasoning_options: [{ type: "effort", values: ["none", "low", "max"] }],
  });
  expect(header(translated)).toBe(SYNCED_REASONING_HEADER);
});

test("maps the block's four shapes to models.dev controls", () => {
  const options = (reasoning: unknown) => (zerog.translateModel(minimax({ reasoning }), context({}))?.model as ExistingModel).reasoning_options;

  expect(options(block(false, ["high", "low", "none"]))).toEqual([{ type: "effort", values: ["none", "low", "high"] }]);
  expect(options(block(true, ["max", "low"]))).toEqual([{ type: "effort", values: ["low", "max"] }]);
  expect(options(block(false))).toEqual([{ type: "toggle" }]);
  expect(options(block(true))).toEqual([]);
});

test("the synced header gives the toggle wire path", () => {
  expect(SYNCED_REASONING_HEADER).toContain('# Toggle, when listed: reasoning_effort = "none" turns thinking off.');
});

test("still opens a research issue when the reasoning block is unreadable", () => {
  for (const reasoning of [{ mandatory: "yes" }, block(true, ["low", "low"]), block(true, ["turbo"])]) {
    expect(() => zerog.translateModel(minimax({ reasoning }), context({}))).toThrow(/no readable reasoning block/);
  }
});

test("keeps opening an issue for a GPT-5+ model, whose freeform support needs evidence", () => {
  const model = zeroGModel({ id: "gpt-5.5", name: "GPT-5.5", reasoning: block(false, ["high", "low", "none"]) });

  expect(() => zerog.translateModel(model, context({}))).toThrow(/freeform/);
});

test("ignores a reasoning block on a model whose lab entry does not reason", () => {
  const translated = zerog.translateModel(zeroGModel({ reasoning: block(false) }), context({}));

  expect(translated?.model as unknown).toEqual({ base_model: "openai/gpt-4.1", cost: { input: 2, output: 8 } });
});

test("ignores a reasoning block, readable or not, on an existing model that does not reason", () => {
  const entry = { base_model: "openai/gpt-4.1", reasoning: false, cost: { input: 2, output: 8 } } as ExistingModel;
  for (const reasoning of [block(false), { mandatory: "yes" }]) {
    const translated = zerog.translateModel(zeroGModel({ reasoning }), context({ "gpt-4.1": entry }));
    expect((translated?.model as ExistingModel).reasoning_options).toBeUndefined();
    expect(notices(translated)).toBeUndefined();
  }
});

const syncedMinimax = {
  base_model: "minimax/MiniMax-M3",
  reasoning: true,
  cost: { input: 0.27, output: 1.08 },
  reasoning_options: [{ type: "toggle" }],
} as ExistingModel;

test("updates a file created from a block when the block changes", () => {
  const translated = zerog.translateModel(
    minimax({ reasoning: block(true, ["max", "low"]) }),
    context({ "minimax-m3": syncedMinimax }, {}, { "minimax-m3": SYNCED_REASONING_HEADER }),
  );

  expect((translated?.model as ExistingModel).reasoning_options).toEqual([{ type: "effort", values: ["low", "max"] }]);
});

test("keeps a file's controls when the block goes away or cannot be read", () => {
  const synced = { "minimax-m3": SYNCED_REASONING_HEADER };
  const kept = zerog.translateModel(minimax(), context({ "minimax-m3": syncedMinimax }, {}, synced));
  expect((kept?.model as ExistingModel).reasoning_options).toEqual([{ type: "toggle" }]);
  expect(notices(kept)).toBeUndefined();

  const unreadable = zerog.translateModel(minimax({ reasoning: block(true, ["turbo"]) }), context({ "minimax-m3": syncedMinimax }, {}, synced));
  expect((unreadable?.model as ExistingModel).reasoning_options).toEqual([{ type: "toggle" }]);
  expect(notices(unreadable)).toEqual([
    "0G model minimax-m3 publishes a reasoning block the sync cannot read; its reasoning controls are left as authored",
  ]);
});

const handGlm = {
  base_model: "zhipuai/glm-5.3-flash",
  reasoning: true,
  cost: { input: 0.15, output: 0.5 },
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }, { type: "budget_tokens" }],
} as ExistingModel;

test("never rewrites a hand-authored file, whatever its id, and reports a block that disagrees", () => {
  for (const [id, model] of [["glm-5.3-flash", glmFlash], ["minimax-m3", minimax]] as const) {
    const translated = zerog.translateModel(model({ reasoning: block(false) }), context({ [id]: handGlm }, {}, { [id]: "# Probed by hand.\n" }));

    expect((translated?.model as ExistingModel).reasoning_options).toEqual(handGlm.reasoning_options);
    expect(notices(translated)).toEqual([
      `0G's reasoning block for ${id} (toggle, verified_at 2026-11-24) differs from its hand-authored controls`
        + " (effort low|high|max); re-probe and update the file by hand, or record the block in its header as"
        + " `# Reasoning block reviewed: 2026-11-24`",
    ]);
  }
});

test("treats a file with no header as hand-authored", () => {
  const translated = zerog.translateModel(glmFlash({ reasoning: block(false) }), context({ "glm-5.3-flash": handGlm }));

  expect((translated?.model as ExistingModel).reasoning_options).toEqual(handGlm.reasoning_options);
  expect(notices(translated)).toHaveLength(1);
});

test("stops reporting a disagreeing block once the file records it as reviewed, until it is re-probed", () => {
  const reviewed = { "glm-5.3-flash": "# Probed by hand.\n# Reasoning block reviewed: 2026-11-24 (the hand probe found high works too)\n" };
  const run = (verifiedAt: string) =>
    notices(zerog.translateModel(
      glmFlash({ reasoning: { mandatory: false, verified_at: verifiedAt } }),
      context({ "glm-5.3-flash": handGlm }, {}, reviewed),
    ));

  expect(run("2026-11-24")).toBeUndefined();
  expect(run("2026-12-01")).toHaveLength(1);
});

test("reports nothing when the block agrees with a hand-authored file (a budget it cannot see aside)", () => {
  const translated = zerog.translateModel(glmFlash({ reasoning: block(true, ["max", "high", "low"]) }), context({ "glm-5.3-flash": handGlm }));

  expect(notices(translated)).toBeUndefined();
});

test("the synced header starts with the marker files are told apart by", () => {
  expect(SYNCED_REASONING_HEADER.startsWith(`${SYNCED_REASONING_MARKER}\n`)).toBe(true);
});

async function tempRepo(...files: Array<[string, string]>) {
  const repo = path.join(import.meta.dirname, "..", "..", "..");
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-0g-reasoning-"));
  for (const [from, to] of files) {
    await mkdir(path.dirname(path.join(root, to)), { recursive: true });
    await copyFile(path.join(repo, from), path.join(root, to));
  }
  await mkdir(path.join(root, "providers", "0g", "models"), { recursive: true });
  return path.join(root, "providers", "0g", "models");
}

test("runner-level: creates a file from a block, then follows the block with its header unchanged", async () => {
  const modelsDir = await tempRepo(["models/minimax/MiniMax-M3.toml", "models/minimax/MiniMax-M3.toml"]);
  const run = (reasoning: unknown) => syncProvider({ ...zerog, modelsDir, fetchModels: async () => ({ data: [minimax({ reasoning })] }) }, { openIssues: false });
  const file = path.join(modelsDir, "minimax-m3.toml");

  await run(block(false));
  let written = await readFile(file, "utf8");
  expect(written.startsWith(SYNCED_REASONING_HEADER)).toBe(true);
  expect(written).toContain("reasoning = { supported = true, toggle = true }");

  await run(block(false, ["high", "low", "none"]));
  written = await readFile(file, "utf8");
  expect(written.startsWith(SYNCED_REASONING_HEADER)).toBe(true);
  expect(written).toContain('reasoning = { supported = true, effort = ["none", "low", "high"] }');

  await run(block(true));
  expect(await readFile(file, "utf8")).toContain("reasoning = { supported = true }\n");
  expect((await run(block(true))).updated).toBe(0);
});

test("runner-level: leaves a hand-authored file byte for byte and reports the disagreement", async () => {
  const modelsDir = await tempRepo(
    ["models/zhipuai/glm-5.3-flash.toml", "models/zhipuai/glm-5.3-flash.toml"],
    ["providers/0g/models/glm-5.3-flash.toml", "providers/0g/models/glm-5.3-flash.toml"],
  );
  const file = path.join(modelsDir, "glm-5.3-flash.toml");
  const original = await readFile(file, "utf8");

  const result = await syncProvider(
    { ...zerog, modelsDir, fetchModels: async () => ({ data: [glmFlash({ reasoning: block(true, ["max", "low"]) })] }) },
    { openIssues: false },
  );

  expect(await readFile(file, "utf8")).toBe(original);
  expect(result.notices.join(" ")).toContain("differs from its hand-authored controls");

  // Recorded as reviewed in the header: still unchanged, no longer reported.
  const reviewed = `# Reasoning block reviewed: 2026-11-24\n${original}`;
  await writeFile(file, reviewed);
  const again = await syncProvider(
    { ...zerog, modelsDir, fetchModels: async () => ({ data: [glmFlash({ reasoning: block(true, ["max", "low"]) })] }) },
    { openIssues: false },
  );
  expect(await readFile(file, "utf8")).toBe(reviewed);
  expect(again.notices.join(" ")).not.toContain("differs from");
});
