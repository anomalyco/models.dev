import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatToml, groups, providers, syncProvider, type ExistingModel } from "../src/sync/index.js";
import { fetchVoidModels, voidApi } from "../src/sync/providers/void-api.js";

const base = {
  name: "Fixture", description: "Fixture model", attachment: false, reasoning: false,
  tool_call: true, open_weights: true, release_date: "2025-01-01", last_updated: "2025-01-01",
  modalities: { input: ["text"], output: ["text"] }, limit: { context: 10000, output: 1000 },
};
const row = (id = "route", base_model: string | null = "lab/plain") => ({
  id, object: "model", created: 1700000000, owned_by: "lab", base_model,
  pricing: { unit: "USD_per_million_tokens", input: "1.25", output: "2", cache_read: "0", cache_write: "0.5" },
});
const envelope = (...data: unknown[]) => ({ object: "list", data });
const parsed = (raw: unknown = row()) => voidApi.parseModels(envelope(raw))[0]!;
function context(
  authored: Record<string, ExistingModel> = {},
  metadata: Record<string, Record<string, unknown>> = { "lab/plain": base },
  firstParty: Record<string, ExistingModel> = {},
) {
  return {
    authored: (id: string) => authored[id], existing: (id: string) => authored[id],
    authoredIDs: () => Object.keys(authored), metadata: (id: string) => metadata[id],
    firstParty: (id: string) => firstParty[id],
    authoredHeader: () => "# Toggle: thinking.type = enabled|disabled\n",
  };
}

test("registered provider and aggregator; explicit base creates override-only prices", () => {
  expect(providers["void-api"]).toBe(voidApi);
  expect(groups.aggregators).toContain("void-api");
  expect(voidApi.translateModel(parsed(), context())?.model).toEqual({
    base_model: "lab/plain", cost: { input: 1.25, output: 2, cache_read: 0, cache_write: 0.5 },
  });
  expect(voidApi.translateModel(parsed(row("looks-like-plain", null)), context())).toBeUndefined();
});

test("same-base authored deltas survive; changed identity is skipped without stale overrides", () => {
  const local: ExistingModel = { base_model: "lab/plain", description: "curated", status: "beta", limit: { context: 5000, output: 100 }, cost: { input: 99, output: 99, input_audio: 7 } };
  const updated = voidApi.translateModel(parsed(), context({ route: local }))!;
  expect(updated.model).toMatchObject({ description: "curated", status: "beta", limit: local.limit, cost: { input: 1.25, output: 2, input_audio: 7 } });
  expect(voidApi.translateModel(parsed(row("route", "lab/other")), context({ route: local }, { "lab/other": base }))).toBeUndefined();
});

test("reasoners require verified same-base Void controls, including explicit always-on []", () => {
  const metadata = { "lab/plain": { ...base, reasoning: true } };
  expect(voidApi.translateModel(parsed(), context({}, metadata))).toBeUndefined();
  for (const reasoning_options of [[], [{ type: "effort" as const, values: ["high" as const] }], [{ type: "toggle" as const }]]) {
    const ctx = context({ peer: { base_model: "lab/plain", reasoning_options } }, metadata);
    expect(voidApi.translateModel(parsed(), ctx)?.model.reasoning_options).toEqual(reasoning_options);
  }
  expect(voidApi.translateModel(parsed(), context({ peer: { base_model: "lab/other", reasoning_options: [] } }, metadata))).toBeUndefined();
  expect(voidApi.translateModel(parsed(), context({ a: { base_model: "lab/plain", reasoning_options: [] }, b: { base_model: "lab/plain", reasoning_options: [{ type: "toggle" }] } }, metadata))).toBeUndefined();
  const noWire = { ...context({ peer: { base_model: "lab/plain", reasoning_options: [{ type: "toggle" }] } }, metadata), authoredHeader: () => "# Unrelated note\n" };
  expect(voidApi.translateModel(parsed(), noWire)).toBeUndefined();
});

test("first-party controls are translated without any Void entries or route-name guessing", () => {
  const metadata = { "anthropic/future": { ...base, reasoning: true }, "openai/future": { ...base, reasoning: true } };
  const firstParty: Record<string, ExistingModel> = {
    "anthropic/future": { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "xhigh", "max"] }, { type: "budget_tokens", min: 1024 }] },
    "openai/future": { reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "minimal", "high", "xhigh", "max"] }] },
  };
  const ctx = context({}, metadata, firstParty);
  const claude = voidApi.translateModel(parsed(row("opaque-new-route", "anthropic/future")), ctx)!;
  expect(claude.model.reasoning_options).toEqual(firstParty["anthropic/future"]!.reasoning_options);
  expect(claude.header).toContain("thinking.budget_tokens (chat only)");
  expect(claude.header).toContain("thinking.type = enabled|disabled");
  expect(claude.header).toContain("chat only");
  const gpt = voidApi.translateModel(parsed(row("not-a-gpt-id", "openai/future")), ctx)!;
  expect(gpt.model.reasoning_options).toEqual(firstParty["openai/future"]!.reasoning_options);
  expect(gpt.header).toContain("reasoning.effort");
  expect(gpt.header).not.toContain("Toggle");
  expect(gpt.model).not.toHaveProperty("name");
  expect(voidApi.translateModel(parsed(row("gpt-looks-known", null)), ctx)).toBeUndefined();
});

test("unsupported native controls are filtered, never replaced with invented levels or []", () => {
  const translate = (baseID: string, reasoning_options: ExistingModel["reasoning_options"]) => voidApi.translateModel(
    parsed(row("route", baseID)), context({}, { [baseID]: { ...base, reasoning: true } }, { [baseID]: { reasoning: true, reasoning_options } }),
  );
  expect(translate("openai/future", [{ type: "toggle" }, { type: "budget_tokens" }, { type: "effort", values: [null, "default", "high"] }])?.model.reasoning_options).toEqual([{ type: "effort", values: ["high"] }]);
  expect(translate("anthropic/future", [{ type: "effort", values: ["none", "default", "low", "max"] }])?.model.reasoning_options).toEqual([{ type: "effort", values: ["low", "max"] }]);
  expect(translate("anthropic/future", [{ type: "effort", values: ["default", null] }])).toBeUndefined();
  expect(translate("anthropic/future", [{ type: "budget_tokens", min: 1024, max: 32000 }])?.model.reasoning_options).toEqual([{ type: "budget_tokens", min: 1024, max: 32000 }]);
  expect(translate("openai/future", [{ type: "toggle" }])).toBeUndefined();
  expect(translate("unknown/future", [])).toBeUndefined();
  expect(translate("anthropic/future", undefined)).toBeUndefined();
  expect(translate("anthropic/future", [])?.model.reasoning_options).toEqual([]);
});

test("authored host overrides win over native translation; native beats peers for new routes", () => {
  const metadata = { "anthropic/future": { ...base, reasoning: true } };
  const native: ExistingModel = { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] };
  const local: ExistingModel = { base_model: "anthropic/future", reasoning_options: [{ type: "budget_tokens", min: 1024 }], provider: { body: { thinking: { type: "enabled" } } }, status: "beta" };
  const ctx = context({ route: local, peer: { base_model: "anthropic/future", reasoning_options: [] } }, metadata, { "anthropic/future": native });
  expect(voidApi.translateModel(parsed(row("route", "anthropic/future")), ctx)?.model).toMatchObject(local);
  expect(voidApi.translateModel(parsed(row("new", "anthropic/future")), ctx)?.model.reasoning_options).toEqual(native.reasoning_options);
  expect(voidApi.translateModel(parsed(row("off", "anthropic/future")), context({ off: { base_model: "anthropic/future", reasoning: false } }, metadata))?.model.reasoning_options).toBeUndefined();
});

test("missing, unknown and incomplete metadata/omissions all need review", () => {
  for (const raw of [{ ...row(), base_model: undefined }, row("route", null), row("route", "lab/unknown")]) {
    const model = parsed(raw);
    expect(voidApi.translateModel(model, context())).toBeUndefined();
    expect(voidApi.missingModelID(model)).toBe("route");
  }
  expect(voidApi.translateModel(parsed(), context({}, { "lab/plain": { ...base, limit: { context: 10 } } }))).toBeUndefined();
  expect(voidApi.translateModel(parsed(), context({ route: { base_model: "lab/plain", base_model_omit: ["limit.output"] } }))).toBeUndefined();
});

test("schema fails closed for empty envelopes, duplicates, unsafe paths and invalid prices", () => {
  const invalid = [null, [], envelope(), { object: "bad", data: [row()] }, envelope(row(), row()), envelope(row("Route"), row("route")),
    ...["../escape", "a/../escape", "/absolute", "a\\b", "a//b", "a/%2e%2e/b"].map((id) => envelope(row(id))),
    ...["-1", "NaN", "Infinity", "", " 1", "1e999", "9".repeat(400)].map((input) => envelope({ ...row(), pricing: { ...row().pricing, input } })),
    envelope({ ...row(), pricing: { ...row().pricing, unit: "USD_per_token" } }),
    envelope({ ...row(), created: 1.5 }), envelope({ ...row(), object: "other" }),
  ];
  for (const raw of invalid) expect(() => voidApi.parseModels(raw)).toThrow();
  expect(parsed(row("lab/nested:v1@region")).id).toBe("lab/nested:v1@region");
});

test("fetch uses public endpoint, timeout, and rejects HTTP/network/JSON failures", async () => {
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe("https://void-api.tech/v1/models");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(envelope(row()));
  }) as unknown as typeof fetch;
  expect(await fetchVoidModels(fetcher)).toEqual(envelope(row()));
  await expect(fetchVoidModels((async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("503");
  await expect(fetchVoidModels((async () => { throw new Error("timeout"); }) as unknown as typeof fetch)).rejects.toThrow("timeout");
  await expect(fetchVoidModels((async () => new Response("not json")) as unknown as typeof fetch)).rejects.toThrow();
});

async function fixture(run: (root: string, modelsDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "void-sync-"));
  const modelsDir = path.join(root, "providers/void-api/models");
  await mkdir(modelsDir, { recursive: true });
  await mkdir(path.join(root, "models/lab"), { recursive: true });
  await Bun.write(path.join(root, "models/lab/plain.toml"), formatToml({ id: "plain", ...base } as any));
  await Bun.write(path.join(root, "models/lab/reasoner.toml"), formatToml({ id: "reasoner", ...base, reasoning: true } as any));
  try { await run(root, modelsDir); } finally { await rm(root, { recursive: true, force: true }); }
}

test("runner fixture dry run, create/update/idempotence; authored metadata not expanded", async () => fixture(async (_, modelsDir) => {
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row()) };
  const dry = await syncProvider(provider, { dryRun: true });
  expect(dry.created).toBe(1);
  expect(await Bun.file(path.join(modelsDir, "route.toml")).exists()).toBe(false);
  expect((await syncProvider(provider)).created).toBe(1);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  const file = path.join(modelsDir, "route.toml");
  await Bun.write(file, (await Bun.file(file).text()).replace('base_model = "lab/plain"', '# curated header\nbase_model = "lab/plain"\nstatus = "beta"'));
  provider.fetchModels = async () => envelope({ ...row(), pricing: { ...row().pricing, input: "3" } });
  expect((await syncProvider(provider)).updated).toBe(1);
  const text = await Bun.file(file).text();
  expect(text).toContain("# curated header");
  expect(text).toContain('status = "beta"');
  expect(text).toContain("input = 3");
  expect(text).not.toContain("release_date");
  expect((await syncProvider(provider)).status).toBe("unchanged");
}));

test("runner generates reasoners from zero Void TOMLs using canonical first-party identities", async () => fixture(async (root, modelsDir) => {
  expect(await readdir(modelsDir)).toEqual([]);
  for (const lab of ["anthropic", "openai"]) {
    await mkdir(path.join(root, "models", lab), { recursive: true });
    await mkdir(path.join(root, "providers", lab, "models"), { recursive: true });
  }
  for (const [lab, id] of [["anthropic", "future"], ["openai", "future"], ["anthropic", "always"], ["anthropic", "budget-only"], ["anthropic", "unmapped"], ["anthropic", "ambiguous"]]) {
    await Bun.write(path.join(root, "models", lab!, `${id}.toml`), formatToml({ id, ...base, reasoning: true } as any));
  }
  const writeNative = async (lab: string, id: string, model: ExistingModel) => Bun.write(path.join(root, "providers", lab, "models", `${id}.toml`), formatToml({ id, ...model } as any));
  await writeNative("anthropic", "future", { ...base, reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }], provider: { npm: "@ai-sdk/anthropic", body: { native_only: true } }, cost: { input: 99, output: 99 } } as ExistingModel);
  await writeNative("anthropic", "future-dated", { base_model: "anthropic/future", reasoning_options: [] });
  await writeNative("openai", "future-dated", { base_model: "openai/future", reasoning_options: [{ type: "effort", values: ["none", "high", "xhigh", "max"] }] });
  await writeNative("anthropic", "always", { base_model: "anthropic/always", reasoning_options: [] });
  await writeNative("anthropic", "budget-only", { base_model: "anthropic/budget-only", reasoning_options: [{ type: "budget_tokens", min: 1024 }] });
  await writeNative("anthropic", "ambiguous-a", { base_model: "anthropic/ambiguous", reasoning_options: [] });
  await writeNative("anthropic", "ambiguous-b", { base_model: "anthropic/ambiguous", reasoning_options: [{ type: "toggle" }] });
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(
    row("arbitrary/claude-route", "anthropic/future"), row("chatgpt-route", "openai/future"), row("always", "anthropic/always"),
    row("budget", "anthropic/budget-only"), row("unmapped", "anthropic/unmapped"), row("ambiguous", "anthropic/ambiguous"), row("unknown", "anthropic/missing"),
  ) };
  const dry = await syncProvider(provider, { dryRun: true });
  expect(dry.created).toBe(4);
  expect(await readdir(modelsDir)).toEqual([]);
  const result = await syncProvider(provider);
  expect(result.created).toBe(4);
  expect((Bun.TOML.parse(await Bun.file(path.join(modelsDir, "budget.toml")).text()) as Record<string, unknown>).reasoning_options).toEqual([{ type: "budget_tokens", min: 1024 }]);
  for (const id of ["unmapped", "ambiguous", "unknown"]) expect(result.notices.join("\n")).toContain(`\`${id}\``);
  const text = await Bun.file(path.join(modelsDir, "arbitrary/claude-route.toml")).text();
  const claude = Bun.TOML.parse(text) as Record<string, unknown>;
  expect(claude).toEqual({ base_model: "anthropic/future", reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }], cost: { input: 1.25, output: 2, cache_read: 0, cache_write: 0.5 } });
  expect(text).toContain("# Toggle: thinking.type = enabled|disabled");
  expect((Bun.TOML.parse(await Bun.file(path.join(modelsDir, "chatgpt-route.toml")).text()) as Record<string, unknown>).reasoning_options).toEqual([{ type: "effort", values: ["none", "high", "xhigh", "max"] }]);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  await writeNative("anthropic", "future", { ...base, reasoning: true, reasoning_options: [{ type: "effort", values: ["medium"] }] } as ExistingModel);
  expect((await syncProvider(provider)).updated).toBe(1);
  const updated = await Bun.file(path.join(modelsDir, "arbitrary/claude-route.toml")).text();
  expect((Bun.TOML.parse(updated) as Record<string, unknown>).reasoning_options).toEqual([{ type: "effort", values: ["medium"] }]);
  expect(updated).not.toContain("# Toggle:");
}));

test("runner preserves missing/changed-base files and paused models; issue flow is selective", async () => fixture(async (_, modelsDir) => {
  const texts: Record<string, string> = {
    changed: 'base_model = "lab/plain"\ndescription = "stale override"\n[cost]\ninput = 9\noutput = 9\n',
    unknown: 'base_model = "lab/plain"\n', paused: 'base_model = "lab/plain"\n',
  };
  for (const [id, text] of Object.entries(texts)) await Bun.write(path.join(modelsDir, `${id}.toml`), text);
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row("safe"), row("changed", "lab/reasoner"), row("unknown", null), row("unverified", "lab/reasoner")) };
  const result = await syncProvider(provider, { dryRun: true, openIssues: true });
  expect(result.created).toBe(1);
  expect(result.deleted).toBe(0);
  expect(result.updated).toBe(0);
  expect(result.notices.join("\n")).toContain("changed base");
  expect(result.notices.join("\n")).toContain("deleteMissing=false");
  for (const id of ["changed", "unknown", "unverified"]) expect(result.notices.join("\n")).toContain(`[missing-model] void-api: ${id}`);
  expect(result.notices.join("\n")).not.toContain("[missing-model] void-api: safe");
  await syncProvider(provider);
  for (const [id, text] of Object.entries(texts)) expect(await Bun.file(path.join(modelsDir, `${id}.toml`)).text()).toBe(text);
}));

test("runner failed and empty responses never write or remove local models", async () => fixture(async (_, modelsDir) => {
  const file = path.join(modelsDir, "route.toml");
  const original = 'base_model = "lab/plain"\n';
  await Bun.write(file, original);
  for (const fetchModels of [async () => envelope(), async () => envelope(row(), row()), async () => { throw new Error("network"); }]) {
    await expect(syncProvider({ ...voidApi, modelsDir, fetchModels })).rejects.toThrow();
    expect(await Bun.file(file).text()).toBe(original);
  }
}));

test("runner copies only same-base Void reasoning controls with wire header; updates preserve controls", async () => fixture(async (_, modelsDir) => {
  const peer = '# Toggle: thinking.type = enabled|disabled\nbase_model = "lab/reasoner"\nreasoning_options = [{ type = "toggle" }]\n';
  await Bun.write(path.join(modelsDir, "peer.toml"), peer);
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row("new-reasoner", "lab/reasoner"), row("peer", "lab/reasoner")) };
  const result = await syncProvider(provider);
  expect(result.created).toBe(1);
  expect(result.updated).toBe(1);
  const text = await Bun.file(path.join(modelsDir, "new-reasoner.toml")).text();
  expect(text).toContain("# Toggle: thinking.type = enabled|disabled");
  expect((Bun.TOML.parse(text) as Record<string, unknown>).reasoning_options).toEqual([{ type: "toggle" }]);
  expect((await syncProvider(provider)).status).toBe("unchanged");
}));

test("missingModelID independently protects existing files even with deletion enabled", async () => fixture(async (_, modelsDir) => {
  const file = path.join(modelsDir, "unknown.toml");
  const original = 'base_model = "lab/plain"\n';
  await Bun.write(file, original);
  const result = await syncProvider({ ...voidApi, modelsDir, deleteMissing: true, fetchModels: async () => envelope(row("unknown", null)) });
  expect(result.deleted).toBe(0);
  expect(await Bun.file(file).text()).toBe(original);
}));


test("provider can be imported directly in a fresh runtime", () => {
  const result = Bun.spawnSync([process.execPath, "-e", 'import { voidApi } from "./packages/core/src/sync/providers/void-api.ts"; console.log(voidApi.id)']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("void-api");
});

test("generated fingerprint protects manual controls and preserves unrelated header notes", async () => fixture(async (root, modelsDir) => {
  await mkdir(path.join(root, "models/anthropic"), { recursive: true });
  await mkdir(path.join(root, "providers/anthropic/models"), { recursive: true });
  await Bun.write(path.join(root, "models/anthropic/future.toml"), formatToml({ id: "future", ...base, reasoning: true } as any));
  const nativeFile = path.join(root, "providers/anthropic/models/future.toml");
  const writeNative = (values: string[]) => Bun.write(nativeFile, formatToml({ id: "future", base_model: "anthropic/future", reasoning_options: [{ type: "effort", values }] } as any));
  await writeNative(["low", "high"]);
  const provider = { ...voidApi, modelsDir, fetchModels: async () => envelope(row("route", "anthropic/future")) };
  await syncProvider(provider);
  const file = path.join(modelsDir, "route.toml");
  const original = await Bun.file(file).text();
  await Bun.write(file, "# Curated note\n" + original);
  await writeNative(["medium"]);
  expect((await syncProvider(provider)).updated).toBe(1);
  expect(await Bun.file(file).text()).toContain("# Curated note");
  await Bun.write(file, (await Bun.file(file).text()).replace('["medium"]', '["max"]'));
  await writeNative(["low"]);
  expect((await syncProvider(provider)).status).toBe("unchanged");
  expect(await Bun.file(file).text()).toContain('["max"]');
}));

test("safe base corrections reset generated controls; manual overrides still require review", () => {
  const metadata = { "anthropic/old": { ...base, reasoning: true }, "openai/new": { ...base, reasoning: true } };
  const native: Record<string, ExistingModel> = {
    "anthropic/old": { reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] },
    "openai/new": { reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "xhigh"] }] },
  };
  const old = voidApi.translateModel(parsed(row("route", "anthropic/old")), context({}, metadata, native))!;
  const ctx = { ...context({ route: old.model as ExistingModel }, metadata, native), authoredHeader: () => old.header };
  expect(voidApi.translateModel(parsed(row("route", "openai/new")), ctx)?.model).toMatchObject({ base_model: "openai/new", reasoning_options: native["openai/new"]!.reasoning_options });
  expect(voidApi.translateModel(parsed(row("route", "openai/new")), { ...ctx, authored: () => ({ ...old.model, status: "beta" } as ExistingModel) })).toBeUndefined();
  expect(voidApi.translateModel(parsed(row("route", "openai/new")), { ...ctx, authored: () => ({ ...old.model, cost: { input: 1, output: 2, input_audio: 3 } } as ExistingModel) })).toBeUndefined();
  const unavailable = { ...ctx, firstParty: () => undefined };
  expect(voidApi.translateModel(parsed(row("route", "anthropic/old")), unavailable)).toBeUndefined();
  const off = voidApi.translateModel(parsed(row("route", "anthropic/old")), { ...ctx, authored: () => ({ ...old.model, reasoning: false } as ExistingModel) })!;
  expect(off.model.reasoning_options).toBeUndefined();
  expect(off.header).not.toContain("# Effort:");
});
