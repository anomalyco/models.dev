// Builds, patches, and writes v2 provider model files from v1 fields. Shared by
// the migration script and sync, so both write the same TOML.

import { toCostV2 } from "./generate-v2.js";
import { ReasoningOption } from "./schema.js";
import type { CostV2, CostWhenV2, InputCostV2, OutputCostV2 } from "./schema-v2.js";
import { roundPrice } from "./translate.js";

type Doc = Record<string, any>;

const IDENTITY = [
  "type",
  "name",
  "description",
  "family",
  "open_weights",
  "knowledge",
  "release_date",
  "last_updated",
  "license",
  "status",
] as const;

// v1 fields → the v2 provider model file they stand for (without the header).
// `protocol` is the API the model is served on, for `provider` and `interleaved`
// fields that don't set a shape (the migration script resolves it).
export function providerModelToV2(model: Record<string, any>, protocol?: string): Doc {
  for (const field of ["body", "headers"]) {
    if (model.provider?.[field] !== undefined) throw new Error(`provider.${field} has no v2 field yet`);
  }
  const doc: Doc = { schema: 2 };
  if (model.base_model !== undefined) doc.base_model = model.base_model;
  if (model.base_model_omit !== undefined) doc.base_model_omit = model.base_model_omit;
  for (const key of IDENTITY) {
    if (model[key] === undefined) continue;
    if (key === "last_updated" && model.last_updated === model.release_date) continue;
    doc[key] = model[key];
  }
  if (model.modalities !== undefined) {
    const mime = (value: string) => (value === "pdf" ? "application/pdf" : value);
    doc.modalities = {
      input: model.modalities.input.map(mime),
      output: model.modalities.output.map(mime),
    };
  }

  const capabilities: Doc = {};
  if (model.tool_call !== undefined) capabilities.tools = { supported: model.tool_call };
  if (model.reasoning !== undefined || model.reasoning_options !== undefined) {
    capabilities.reasoning = reasoningSupport(model);
  }
  for (const key of ["structured_output", "temperature"]) {
    if (model[key] !== undefined) capabilities[key] = model[key];
  }
  if (Object.keys(capabilities).length > 0) doc.capabilities = capabilities;
  if (model.limit !== undefined) doc.limit = model.limit;
  const api = apiEntry(model, protocol);
  if (api !== undefined) doc.api = api;

  const cost: Doc | undefined = model.cost && toCostV2(model.cost);
  const multipliers: Doc[] = [];
  const modes: Doc = {};
  for (const [name, mode] of Object.entries<any>(model.experimental?.modes ?? {})) {
    const bodyTier = mode.provider?.body?.service_tier;
    const tier = typeof bodyTier === "string" ? bodyTier : name;
    const factor = mode.cost && model.cost && uniformFactor(model.cost, mode.cost);
    const existing = multipliers.find((item) => item.when.service_tier.equals === tier);
    if (factor !== undefined && existing === undefined) {
      multipliers.push({ when: { service_tier: { equals: tier } }, factor });
    } else if (factor !== undefined && existing?.factor !== factor) {
      throw new Error(`two prices for service tier ${tier}`);
    }
    const next: Doc = {};
    if (tier !== name) next.service_tier = tier;
    if (mode.provider?.body !== undefined) next.body = mode.provider.body;
    if (mode.provider?.headers !== undefined) next.headers = mode.provider.headers;
    // Prices that aren't a plain multiple of the base stay on the mode.
    if (mode.cost !== undefined && factor === undefined) next.cost = toCostV2(mode.cost);
    modes[name] = next;
  }
  if (cost !== undefined) {
    if (multipliers.length > 0) cost.multipliers = multipliers;
    doc.cost = cost;
  }
  if (Object.keys(modes).length > 0) doc.experimental = { modes };
  return doc;
}

// v1 `provider` and `interleaved` → the model's `[api.<protocol>]` table.
function apiEntry(model: Record<string, any>, fallback: string | undefined) {
  const { provider, interleaved } = model;
  if (provider === undefined && interleaved === undefined) return undefined;
  const shape = provider?.shape;
  const protocol =
    shape === "responses" ? "responses" : shape === "completions" ? "chat-completions" : fallback;
  if (protocol === undefined) throw new Error("provider and interleaved need the model's API protocol");
  const entry: Doc = {};
  if (provider?.api !== undefined) entry.base_url = provider.api;
  if (provider?.npm !== undefined) entry.sdk = { aisdk: provider.npm };
  if (interleaved === true) entry.compatibility = { replay_reasoning: true };
  else if (interleaved !== undefined) entry.compatibility = { reasoning_field: interleaved.field };
  return { [protocol]: entry };
}

// Applies a v1 change (`before` → `after`) to an existing v2 file. Fields whose
// v1 view didn't change keep their v2 data (MIME modalities, cache TTLs, extra
// capabilities, multipliers); changed prices are updated in place.
export function patchModelV2(doc: Doc, before: Record<string, any>, after: Record<string, any>): Doc {
  const next = providerModelToV2(after, Object.keys(doc.api ?? {})[0]);
  // `reasoning` and `tool_call` may be inherited from the lab on one side, as in sameV1Model.
  const same = (...keys: string[]) =>
    keys.every(
      (key) =>
        ((key === "reasoning" || key === "tool_call") && (before[key] === undefined || after[key] === undefined)) ||
        stable(before[key]) === stable(after[key]),
    );

  if (same("modalities") && doc.modalities !== undefined) next.modalities = doc.modalities;

  const capabilities: Doc = { ...doc.capabilities };
  const owned: Array<[string, string[]]> = [
    ["tools", ["tool_call"]],
    ["reasoning", ["reasoning", "reasoning_options"]],
    ["structured_output", ["structured_output"]],
    ["temperature", ["temperature"]],
  ];
  for (const [key, fields] of owned) {
    if (same(...fields)) continue;
    if (next.capabilities?.[key] === undefined) delete capabilities[key];
    else capabilities[key] = next.capabilities[key];
  }
  if (Object.keys(capabilities).length > 0) next.capabilities = capabilities;
  else delete next.capabilities;

  if (same("cost", "experimental")) {
    if (doc.cost === undefined) delete next.cost;
    else next.cost = doc.cost;
    if (doc.experimental === undefined) delete next.experimental;
    else next.experimental = doc.experimental;
  } else if (next.cost !== undefined && doc.cost !== undefined) {
    // Tiers whose mode has a synced price get their multiplier from that price.
    const modeTiers = Object.entries<any>(next.experimental?.modes ?? {})
      .filter(([name]) => after.experimental?.modes?.[name]?.cost !== undefined)
      .map(([name, mode]) => mode.service_tier ?? name);
    next.cost = patchCost(doc.cost, next.cost, new Set(modeTiers));
    for (const [name, mode] of Object.entries<any>(next.experimental?.modes ?? {})) {
      const capabilities = doc.experimental?.modes?.[name]?.capabilities;
      if (capabilities !== undefined) mode.capabilities = capabilities;
    }
  }
  if (same("provider", "interleaved") && doc.api !== undefined) next.api = doc.api;
  if (doc.metadata !== undefined) next.metadata = doc.metadata;
  if (doc.v2_only !== undefined) next.v2_only = doc.v2_only;
  return next;
}

// Modes priced by a multiplier in the v2 file whose v1 price sync only carried
// over unchanged. Their price keeps following the multiplier.
export function multiplierModes(
  doc: Doc,
  before: Record<string, any>,
  after: Record<string, any>,
) {
  return Object.entries<any>(doc.experimental?.modes ?? {})
    .filter(([name, mode]) => {
      if (mode.cost !== undefined) return false;
      const previous = before.experimental?.modes?.[name]?.cost;
      return previous !== undefined && stable(previous) === stable(after.experimental?.modes?.[name]?.cost);
    })
    .map(([name]) => name);
}

export function withoutModeCosts<T extends Record<string, any>>(model: T, names: string[]): T {
  if (names.length === 0) return model;
  const copy = structuredClone(model) as Doc;
  for (const name of names) delete copy.experimental?.modes?.[name]?.cost;
  return copy as T;
}

function patchCost(current: Doc, next: Doc, modeTiers: Set<string>): Doc {
  const result: Doc = structuredClone(current);
  for (const modality of ["text", "audio"]) {
    for (const direction of ["input", "output"]) {
      const target = result[modality]?.[direction];
      const source = next[modality]?.[direction];
      if (source === undefined) {
        if (target !== undefined) delete result[modality][direction];
        continue;
      }
      if (target === undefined) {
        (result[modality] ??= {})[direction] = source;
        continue;
      }
      patchPrices(target, source);
      const overrides: Doc[] = [];
      for (const override of source.overrides ?? []) {
        const match = target.overrides?.find((item: Doc) => sameTier(item.when, override.when));
        if (match === undefined) overrides.push(override);
        else overrides.push(patchPrices(match, override));
      }
      // Overrides v1 can't express (anything but a context tier) stay as they are.
      for (const override of target.overrides ?? []) {
        if (!isContextTier(override.when)) overrides.push(override);
      }
      if (overrides.length > 0) target.overrides = overrides;
      else delete target.overrides;
    }
    if (result[modality] !== undefined && Object.keys(result[modality]).length === 0) {
      delete result[modality];
    }
  }

  // Multipliers for tiers with a mode come from the new prices; the rest
  // (region, tiers without a mode) are kept.
  const derived: Doc[] = next.multipliers ?? [];
  const kept = (current.multipliers ?? []).filter(
    (item: Doc) => !modeTiers.has(item.when?.service_tier?.equals),
  );
  const multipliers = [...derived, ...kept];
  if (multipliers.length > 0) result.multipliers = multipliers;
  else delete result.multipliers;
  return result;
}

function patchPrices(target: Doc, source: Doc) {
  for (const key of ["price", "reasoning", "unit"]) {
    if (source[key] === undefined) delete target[key];
    else target[key] = source[key];
  }
  if (source.cache === undefined) {
    delete target.cache;
    return target;
  }
  const cache = (target.cache ??= {});
  cache.read = source.cache.read;
  if (source.cache.read === undefined) delete cache.read;
  const write = source.cache.write;
  if (write === undefined) delete cache.write;
  else if (typeof cache.write === "object" && typeof write === "number") {
    // Keep the TTL record, scaling every TTL by the change to the first one.
    const entries = Object.entries<number>(cache.write);
    const ratio = write / entries[0]![1];
    cache.write = Object.fromEntries(entries.map(([ttl, price]) => [ttl, roundPrice(price * ratio)]));
  } else cache.write = write;
  return target;
}

function isContextTier(when: unknown) {
  const keys = Object.keys((when ?? {}) as object);
  return keys.length === 1 && keys[0] === "context";
}

// v1 tiers only carry a size, so a file's `gte` tier matches a synced `gt` tier
// at the same size, and keeps its own operator.
function sameTier(a: unknown, b: unknown) {
  if (stable(a) === stable(b)) return true;
  const size = (when: any) => when?.context?.gt ?? when?.context?.gte;
  return isContextTier(a) && isContextTier(b) && size(a) !== undefined && size(a) === size(b);
}

// Compares two v1 models the way v2 files can express them: v2 always states
// `reasoning` and `tool_call` when it sets them and derives `attachment`, while v1
// files may inherit or omit them.
export function sameV1Model(a: Record<string, any>, b: Record<string, any>) {
  const left = normalizeV1(a);
  const right = normalizeV1(b);
  for (const key of ["reasoning", "attachment", "tool_call"]) {
    if (left[key] === undefined || right[key] === undefined) {
      delete left[key];
      delete right[key];
    }
  }
  return stable(left) === stable(right);
}

export function normalizeV1(model: Record<string, any>) {
  const { id: _id, ...copy } = structuredClone(model) as Doc;
  for (const tier of copy.cost?.tiers ?? []) tier.tier = { type: "context", ...tier.tier };
  if (copy.reasoning_options !== undefined) {
    copy.reasoning_options = copy.reasoning_options.map((option: unknown) =>
      ReasoningOption.parse(option),
    );
  }
  return copy;
}

function reasoningSupport(model: Record<string, any>) {
  if (model.reasoning === false) return { supported: false };
  const options = (model.reasoning_options ?? []).map((option: unknown) =>
    ReasoningOption.parse(option),
  );
  const support: Doc = { supported: true };
  for (const option of options) {
    if (option.type === "toggle") support.toggle = true;
    if (option.type === "effort") {
      support.effort = option.values.map((value: string | null) => value ?? "default");
    }
    if (option.type === "budget_tokens") {
      support.budget = Object.fromEntries(
        Object.entries({ min: option.min, max: option.max }).filter(([, v]) => v !== undefined),
      );
    }
  }
  return support;
}

function uniformFactor(base: Record<string, number>, mode: Record<string, number>) {
  const keys = Object.keys(base).filter((key) => key !== "tiers" && key !== "context_over_200k");
  if (keys.length !== Object.keys(mode).length || base.input === undefined) return undefined;
  const factor = roundPrice(mode.input! / base.input);
  return keys.every((key) => roundPrice(base[key]! * factor) === mode[key]) ? factor : undefined;
}

// Writes a v2 provider model file body (no header).
export function formatModelV2(doc: Doc) {
  const out: string[] = [];
  for (const key of ["schema", "v2_only", "base_model", "base_model_omit", ...IDENTITY]) {
    if (doc[key] !== undefined) out.push(`${key} = ${formatTomlValue(doc[key])}`);
  }
  for (const table of ["modalities", "capabilities", "limit"]) {
    if (doc[table] !== undefined) out.push("", `[${table}]`, ...tableLines(doc[table]));
  }
  for (const [protocol, entry] of Object.entries<Doc>(doc.api ?? {})) {
    out.push("", `[api.${formatKey(protocol)}]`, ...tableLines(entry));
  }
  if (doc.cost !== undefined) out.push(...costLines(doc.cost));
  for (const [name, mode] of Object.entries<any>(doc.experimental?.modes ?? {})) {
    const { cost, ...rest } = mode;
    out.push("", `[experimental.modes.${name}]`, ...tableLines(rest));
    if (cost !== undefined) out.push(...costLines(cost, `experimental.modes.${name}.cost`));
  }
  if (doc.metadata !== undefined) out.push("", "[metadata]", ...tableLines(doc.metadata));
  return `${out.join("\n").trimEnd()}\n`;
}

function costLines(cost: CostV2, prefix = "cost") {
  const out: string[] = [];
  for (const [modality, prices] of Object.entries(cost)) {
    if (modality === "multipliers" || prices === undefined) continue;
    const { input, output } = prices as { input?: InputCostV2; output?: OutputCostV2 };
    for (const [direction, entry] of [
      ["input", input],
      ["output", output],
    ] as const) {
      if (entry === undefined) continue;
      const { overrides, ...rest } = entry as Doc;
      out.push("", `[${prefix}.${modality}.${direction}]`, ...tableLines(rest));
      for (const override of overrides ?? []) {
        const { when, ...fields } = override as { when: CostWhenV2 };
        out.push(
          "",
          `[[${prefix}.${modality}.${direction}.overrides]]`,
          `when = ${formatTomlValue(when)}`,
          ...tableLines(fields),
        );
      }
    }
  }
  for (const multiplier of cost.multipliers ?? []) {
    out.push("", `[[${prefix}.multipliers]]`, ...tableLines(multiplier));
  }
  return out;
}

function tableLines(fields: Record<string, unknown>) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${formatKey(key)} = ${formatTomlValue(value)}`);
}

export function formatTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_")
      : String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${formatKey(key)} = ${formatTomlValue(item)}`);
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }
  throw new Error(`Cannot write ${String(value)} as TOML`);
}

function formatKey(key: string) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
