// Conversions every source needs, so modules don't each hand-roll them.

import { inferKimiFamily, ModelFamilyValues } from "../family.js";
import { ReasoningEffortV2Values, type ReasoningEffortV2 } from "../schema-v2.js";

/** Rounds away float noise (1.4000000000000001) at six decimals. */
export function round(price: number) {
  return Number(price.toFixed(6));
}

/** A per-token USD price (number or numeric string) as USD per 1M tokens. Undefined when it isn't a finite number. */
export function perMillion(perToken: string | number | undefined | null) {
  if (perToken === undefined || perToken === null || perToken === "") return undefined;
  const value = Number(perToken);
  return Number.isFinite(value) ? round(value * 1_000_000) : undefined;
}

/**
 * Reasoning controls in v2 form: effort sorted low to high, and no separate
 * toggle when `none` is one of the effort levels (AGENTS.md, "Toggle").
 */
export function reasoningControls(controls: {
  effort?: readonly string[];
  toggle?: boolean;
  budget?: { min?: number; max?: number };
}) {
  const effort = controls.effort === undefined
    ? undefined
    : [...new Set(controls.effort)].map((value) => {
      if (!(ReasoningEffortV2Values as readonly string[]).includes(value)) throw new Error(`Unknown reasoning effort: ${value}`);
      return value as ReasoningEffortV2;
    }).sort((a, b) => ReasoningEffortV2Values.indexOf(a) - ReasoningEffortV2Values.indexOf(b));
  return {
    supported: true as const,
    ...(controls.toggle && !effort?.includes("none") ? { toggle: true } : {}),
    ...(effort !== undefined && effort.length > 0 ? { effort } : {}),
    ...(controls.budget !== undefined ? { budget: controls.budget } : {}),
  };
}

/**
 * Lab model ID candidates for a host's `namespace/model` ID: lowercased, with
 * host namespaces renamed to lab IDs (`qwen` → `alibaba`).
 */
export function labCandidates(id: string, namespaces: Record<string, string> = {}) {
  const lowered = id.toLowerCase();
  const slash = lowered.lastIndexOf("/");
  if (slash === -1) return [lowered];
  const namespace = lowered.slice(0, slash);
  const mapped = namespaces[namespace];
  return mapped === undefined ? [lowered] : [`${mapped}${lowered.slice(slash)}`, lowered];
}

/** The longest model family named in a host's ID or display name (Kimi by its own rules). */
export function inferFamily(id: string, name: string) {
  const kimi = inferKimiFamily(id, name);
  if (kimi !== undefined) return kimi;
  const target = `${id} ${name}`.toLowerCase();
  return [...ModelFamilyValues]
    .sort((a, b) => b.length - a.length)
    .find((family) => {
      const value = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (family === "o") return new RegExp(`(^|[^a-z0-9])${value}(?=\\d|$|[^a-z0-9])`).test(target);
      return new RegExp(`(^|[^a-z0-9])${value}(?=$|[^a-z0-9])`).test(target);
    });
}
