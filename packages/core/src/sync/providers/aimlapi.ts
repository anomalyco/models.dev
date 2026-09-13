import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { SyncProvider } from "../index.js";
import {
  factorBaseModel,
  modelMetadata,
  providerDirForMetadataLab,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

// The public catalog needs no key, and `include` is what turns on the pricing
// and modality blocks this sync depends on.
const API_ENDPOINT = "https://api.aimlapi.com/v1/models?include=pricing,modalities";

// Per-model request schema. It is the only place the API states which reasoning
// controls a model actually accepts, so reasoning_options is read from here
// rather than assumed.
const DOCS_ENDPOINT = "https://api.aimlapi.com/docs-json";

// AI/ML API serves one id under several endpoint types — a model can be both a
// chat model and, say, an image model. Only the chat surface belongs here.
const CHAT_COMPLETIONS_TYPE = "openai/chat-completions";

// Values this schema accepts for an "effort" reasoning control, in the order a
// reader expects to see them. Anything the API documents outside this set is
// dropped rather than coerced.
const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] as const;
type EffortValue = (typeof EFFORT_VALUES)[number];
const EFFORT_RANK = new Map(EFFORT_VALUES.map((value, index) => [value as string, index]));
const isEffortValue = (value: string): value is EffortValue => EFFORT_RANK.has(value);

/**
 * Models whose documented schema and whose live behaviour disagree, with what
 * the endpoint actually served when asked.
 *
 * `/docs-json` describes a request *shape* per fallback hop, and a hop can
 * advertise a control the vendor behind it still refuses. Reading the schema
 * alone therefore over-states these two, and reading only the first hop
 * under-states others — neither direction is safe to publish unchecked.
 *
 * How these were established, because the method is the evidence: each value
 * was sent to production with `max_tokens` high enough to leave room for an
 * answer, and the **error body** was read rather than the status code. A
 * reasoning model given a small budget returns 400 for an accepted value too
 * ("max_tokens or model output limit was reached"), so a status-only probe
 * reports a rejection that never happened. A real refusal says either
 * "Validation failed" or, for gemini, "Reasoning is mandatory for this
 * endpoint and cannot be disabled".
 *
 * Measured 2026-09-09. Re-probe before trusting these after a vendor change:
 * an entry that has become wrong is worse than no entry.
 */
/**
 * Models that accept any string in `reasoning_effort` — `banana` and `zzz9` both
 * return 200 — so the parameter is not honoured and no ladder can be established
 * by probing. The schema still lists one, inherited from the family template.
 *
 * Publishing it would state a control the caller does not have. Emitting nothing
 * says only that we cannot describe it, which is the truth. Re-probe with a
 * deliberately invalid value before adding a ladder back: a 400 means the field
 * became real.
 *
 * Measured 2026-09-09 across all 87 entries that carry reasoning options; these
 * were the only ones that failed the check. Re-probed 2026-09-10: five still
 * accept `banana` with a 200 and stay.
 *
 * `moonshot/kimi-k3` was removed on 2026-09-10. Re-probed, its control answers
 * 200 and a deliberately invalid effort answers 400 — the field is read and
 * enforced, which is the one thing `[]` asserts is not true. Whether the levels
 * ORDER is still unproven: `low` measured 919 and 1618 reasoning tokens and
 * `high` measured 1943, so the spread within `low` is nearly the distance from
 * `low` to `high`, and `max` timed out at the gateway on both attempts. The id
 * therefore goes back to the schema-derived ladder its card declares, which is
 * the host's own statement about itself, rather than to a claim of ours that
 * the measurement does not support in either direction.
 */
/**
 * Catalogue rows that cannot actually be called: `/v1/models` lists them with a
 * name and prices, inference answers 404 "No endpoints found". Publishing one
 * hands a reader a model id that fails on first use.
 *
 * Measured 2026-09-09; the sibling `-fast` and `-pro` aliases all answered 200,
 * so this is one broken row rather than a broken family. Re-check before adding
 * to this list — a row that starts working should come back.
 *
 * The guard sits on the publish path, so the entry is never created or updated.
 * It does not delete a file that is already on disk: this sync runs with
 * `deleteMissing: false`, so removing a published row still takes an explicit
 * delete, as it did here.
 */
const NOT_CALLABLE: ReadonlySet<string> = new Set([
  "anthropic/claude-opus-4.7-fast",
  // Joined it on 2026-09-09: gone from `/v1/models` (785 rows, neither `-fast`
  // id among them) and `/docs-json` answers 404 for it, so there is nothing
  // left to describe. The host's own deprecation record calls both withdrawn.
  "anthropic/claude-opus-4.8-fast",
  // 2026-09-11: answers 404 to every request including the no-effort control —
  // "0 endpoints out of 1 requested are available matching your guardrail
  // restrictions and data policy", an OpenRouter refusal passed straight
  // through. Found while probing its ladder; the ladder is moot.
  "sakana/sakana-namazu",
]);

/**
 * Ladders the endpoint VALIDATES and then does not act on.
 *
 * Kept apart from `EFFORT_NOT_HONOURED` because the evidence is different and
 * the two must not be confused. There, an invalid value returns 200, which
 * proves the field is never read. Here an invalid value is rejected — the
 * field is read, parsed and enforced — and the levels still fail to order.
 *
 * `moonshotai/kimi-k2-thinking`, measured 2026-09-10 on a prompt hard enough
 * to make a difference visible: `low` produced 6723 and 8207 reasoning tokens
 * across repeats, `high` produced 6508. Unset produced 2919 against `low`'s
 * 2799 on a smaller budget. `low` above `high` is not a small delta in the
 * wrong direction, it is the absence of an ordering, and the lab entry for
 * this model publishes `reasoning_options = []` for the same reason: the
 * model always reasons and the caller cannot steer it.
 *
 * Publishing a ladder here would sell a dial that turns nothing.
 */
/**
 * ## Why this file reads `reasoning_effort` and nothing else
 *
 * The review asks repeatedly for `toggle` and `budget_tokens` options, on the
 * grounds that the labs behind these models expose them and a relay should
 * mirror the control family. The premise does not survive a control.
 *
 * Probed on 2026-09-10 against `deepseek-v4-pro`, `qwen-plus`, `kimi-k3` and
 * `glm-5-turbo` on the OpenAI-compatible path, each alongside a no-field
 * control that answered 200:
 *
 *   enable_thinking: false        200
 *   thinking: {type: 'disabled'}  200
 *   thinking_budget: 128          200
 *   banana_toggle: true           200   <- a field that exists nowhere
 *
 * An invented field is accepted exactly like the real ones, so this surface
 * discards unknown top-level keys rather than forwarding them. A 200 on
 * `enable_thinking` is therefore not evidence that a toggle exists; it is
 * evidence that nothing is listening. Publishing `toggle` on that basis would
 * hand callers a control the gateway throws away.
 *
 * `reasoning_effort` is different in kind: an invalid value is REJECTED on the
 * models that read it, which is how this file tells a live control from a
 * swallowed one, and it is why the two categories below are kept apart.
 */
const EFFORT_VALIDATED_BUT_INERT: ReadonlySet<string> = new Set([
  "moonshotai/kimi-k2-thinking",
  // 2026-09-11: an invalid value is rejected, and then `low` spends 2149
  // reasoning tokens to `high`'s 1533 with unset at 1801 between them. The
  // lab publishes toggle only for this id, which the wire agrees with: there
  // is thinking, and nothing the caller sends steers how much.
  "z-ai/glm-4.7-flash",
  // The other toggle-only labs, 2026-09-11, each on two repeats of low/high
  // with the field validated. None orders, and the wire agrees with the lab:
  //   claude-haiku-4.5      188/182 vs 179/185
  //   qwen3.6-max-preview   574/580 vs 552/554   (high below low, both times)
  //   gemma-4-31b-it        reasoning count 1 at every rung
  //   mimo-v2.5-pro         reasoning count 0 at every rung
  //   mimo-v2.5             307/234 vs 104/235
  //   glm-4.5v              614/680 vs 641/643
  //   glm-4.6v              191/116 vs 123/109
  // `claude-sonnet-4.5` is the one with a direction — 184/183 vs 220/210 —
  // but a thirty-token delta on a model the host's own middleware lists as
  // effort-unsupported (`strip-unsupported-effort.ts`) is not evidence
  // enough to contradict a lab that publishes toggle only. Recorded so it can
  // be revisited; it takes `[]` with the rest.
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
  "alibaba/qwen3.6-max-preview",
  "google/gemma-4-31b-it",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "z-ai/glm-4.5v",
  "z-ai/glm-4.6v",
]);

const EFFORT_NOT_HONOURED: ReadonlySet<string> = new Set([
  // Re-verified 2026-09-10 by the token-scaling test the review asked for,
  // rather than by status codes alone: `low` measured 3837 and 3841 reasoning
  // tokens, `high` measured 3837 and 3838. Four runs, a spread of four tokens,
  // no movement between the levels at all. Peers publish L/M/H for this id;
  // this host accepts the names and steers nothing.
  "google/gemini-3.1-pro-preview",
  "google/gemma-4-26b-a4b-it",
  "z-ai/glm-5v-turbo",
  "z-ai/glm-5-turbo",
  "alibaba/qwen-plus",
]);

/**
 * Ladders this host was measured to accept AND honour, where that differs from
 * what its schema advertises. `accepted` is not enough on its own: a rung the
 * endpoint takes and then ignores publishes worse advice than one it refuses,
 * because the caller asks for more thinking, is told yes, and is billed for a
 * reply produced with less.
 */
/**
 * `deepseek-chat` and `deepseek-v4-flash` publish identical prices on purpose.
 *
 * The review read the coincidence as a unit-mapping bug and asked for a
 * re-check. It is not one: DeepSeek retired `deepseek-chat` as a model and
 * routes the id to its current Flash build, so the host bills it on the Flash
 * grid — 0.3 in / 1.2 out / 0.006 cached, times the host margin, which is
 * exactly the 0.39 / 1.56 / 0.0078 both rows carry.
 *
 * The check was worth running anyway. It turned up the real defect beside the
 * prices: the row still carried V3's name and a 128K context for a model with
 * 1M, which the host has since corrected. Kept here so the next reviewer does
 * not spend the same round on it.
 */

/**
 * The OpenAI pro/codex/5.6 batch, probed 2026-09-10 because the review asked
 * for each id to be intersected with a live accept-and-honour test.
 *
 * An invalid effort is rejected on all nine, so every ladder below is a live
 * control rather than a swallowed field.
 *
 * The rungs the review wanted ADDED are refused here. `xhigh` answers 400 on
 * `gpt-5.2-pro`, `gpt-5.5-pro` and `gpt-5.3-codex`; `max` answers 400 on
 * `gpt-5.6-luna`. Publishing the lab's wider sets would hand callers an error,
 * so the host's narrower enum stands.
 *
 * The rung the review worried was fake is real. `none` measured 0 reasoning
 * tokens on every id that offers it — `gpt-5.3-codex`, `gpt-5.6-luna`, `-sol`,
 * `-terra` and `-terra-pro` — against non-zero at `high` on each. That is the
 * check Sonnet 5 failed, and these pass it.
 *
 * Ordering, on a deliberately light prompt so the batch could finish:
 *
 *   gpt-5.2-codex     low 90    high 192   ordered
 *   gpt-5.1-codex     low 0     high 103   ordered
 *   gpt-5.6-terra     low 9     high 25    ordered
 *   gpt-5.6-terra-pro low 91    high 129   ordered
 *   gpt-5.6-sol       low 0     high 9     ordered, barely
 *   gpt-5.6-luna      low 26    high 27    not separated
 *   gpt-5.5-pro       low 33    high 31    not separated
 *   gpt-5.2-pro       0 at every rung — the model did not reason at all here
 *
 * The last three are left alone rather than trimmed. `gpt-5.2-pro` is the
 * `kwaipilot` case from the Method section: when the control itself produces
 * nothing, the cells say nothing about the ladder. The other two would need a
 * harder prompt than this batch could afford, and a rung the host accepts is
 * not removed on a probe that failed to separate anything.
 */
/**
 * `none` on the Claude ladders, which the review asked to justify or drop.
 *
 * It is a real control, and what it does depends on which link serves the
 * request — so the honest answer is per model rather than per family.
 *
 * `claude-opus-4.7` and `4.8` reach OpenRouter for every rung up to `high`,
 * and only `xhigh`/`max` go to Anthropic natively. On that link `none`
 * measured 0 reasoning tokens against 191 at `low` and 1228 at `high`: an off
 * switch, and the reason `none` stays on those ids.
 *
 * `claude-sonnet-5` has no OpenRouter link, so every rung goes native, and
 * Anthropic has no off switch on its adaptive models — `thinking:
 * {type: 'disabled'}` returns 200 there and is ignored. The host used to drop
 * the field entirely for `none`, which handed the request to Anthropic's
 * default: 6000 output tokens spent thinking and an EMPTY reply. That is fixed
 * upstream and `none` now maps to `low`, the cheapest rung the vendor has, so
 * on this id it means minimum rather than off.
 *
 * Both are worth publishing — a caller sending `none` gets the least thinking
 * available either way — but they are not the same promise, and this is where
 * that is written down.
 */
/**
 * `alibaba/qwen3.8-2.4t-a95b` keeps `high` as its top rung.
 *
 * The review asked for `xhigh` instead, on the peer ladder for this model.
 * Probed twice: `xhigh` answers 400 with `Expected 'low' | 'medium' | 'high'`,
 * so the host does not offer it and publishing it would hand callers an error.
 * `high` at 4000 tokens times out at the gateway rather than returning, so
 * whether the rungs order is still unmeasured — the enum, however, is settled.
 */
const MEASURED_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // schema offers none+minimal; both refused, `none` explicitly and by name.
  // `max` is kept on evidence the review asked to see recorded here: measured
  // 2131 reasoning tokens at `low`, 3841 at `high` and 6585 at `max` on one
  // prompt, a monotone spread far outside the noise on this family. Peers stop
  // at `high`; this host both accepts `max` and spends visibly more for it.
  "google/gemini-3.7-flash": ["low", "medium", "high", "max"],
  // schema offers none; refused as a validation error
  "google/gemini-3.6-flash": ["minimal", "low", "medium", "high", "max"],
  // The schema offers `xhigh` on both and the endpoint answers 200 for it, so
  // no status-code probe could catch this. Pinned to the direct hop on a prompt
  // hard enough to show the difference, `xhigh` produced 0 reasoning tokens on
  // o1 and 192 on o3-mini, where `high` produced 10176 and 16000 and even `low`
  // produced ~4500. The rung is accepted and dropped. The review asked for
  // exactly this set on both ids and was right; the host has since stopped
  // advertising `xhigh` here, so this entry becomes a no-op rather than an
  // override once that reaches production.
  // `low` measured indistinguishable from `medium` on a prompt hard enough to
  // separate them: low 2230 and 2273 reasoning tokens, medium 2180 and 2420,
  // overlapping ranges across repeats, while `high` sat clearly above at 2984.
  // Two names for one behaviour is worse than one name, so `low` goes. The
  // review asked for this too, on the different ground that the lab omits it;
  // the measurement is what this entry rests on. `xhigh` is not added back —
  // this host's schema stops at `high` and refuses it.
  // Re-probed on a hard prompt at the review's suggestion, because the light
  // one had `gpt-5.2-pro` not reasoning at all. `low` and `medium` come back
  // indistinguishable on both — 1400 against 1311, and 2345 against 2336 —
  // while `high` sits above where it could be measured at all. Same call as
  // `gpt-5.4-pro` below: two names for one behaviour, so the lower goes.
  "openai/gpt-5.2-pro": ["medium", "high"],
  "openai/gpt-5.5-pro": ["medium", "high"],
  "openai/gpt-5.4-pro": ["medium", "high"],
  // `none` dropped 2026-09-10. On this id every rung reaches Anthropic
  // natively, and Anthropic has no off switch on its adaptive models, so the
  // host maps `none` to `low` — the cheapest real rung. Publishing it as
  // `none` tells a caller reading the catalogue that reasoning can be turned
  // off here, which is not what they would get. The sibling opus-4.7/4.8 keep
  // `none` because their lower rungs reach OpenRouter, where it measured 0
  // reasoning tokens against 191 at `low`: there it really is off.
  // `none` dropped 2026-09-10: it is accepted, but nothing shows it turns
  // reasoning off. Two runs returned no `reasoning_tokens` field at all while
  // still producing 1703 and 2000 output tokens, so there is no reading of
  // that as an off switch — and `high` on the same model does report 2000
  // reasoning tokens. A rung whose semantics cannot be shown does not belong
  // in a catalogue other people build against.
  "alibaba/qwen3.8-max": ["low", "medium", "high"],
  "anthropic/claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  // `medium` dropped 2026-09-10, and this is a correction to an earlier call
  // in this file rather than a new measurement. It measured 5563 and then 7204
  // against `high`'s 5662: a spread inside the rung wider than any gap to the
  // rung above. That was recorded as "unsettled, so keep it" — but publishing
  // a rung is a claim too, and `gpt-5.4-pro` above had the identical shape and
  // lost `low` for it. Two rules for one situation is worse than either rule.
  // `none` (0 twice) and `low` (4175 against 5662) stay: those are measured.
  "deepseek/deepseek-v4-pro": ["none", "low", "high"],
  // Same cut on the dated snapshot, measured rather than copied: `medium`
  // exhausted a 4000-token budget on reasoning twice while `high` used 2318.
  // A rung that spends more than the one above it is not a lower rung.
  "deepseek/deepseek-v4-pro-0813": ["none", "low", "high"],
  "openai/o1": ["low", "medium", "high"],
  "openai/o3-mini": ["low", "medium", "high"],
};

/**
 * Models whose reasoning arrives on a side channel rather than in `content`.
 *
 * The review asked whether this gateway returns one, and it does — but the lab
 * entries that declare it are NOT inherited through `base_model`, so the built
 * catalogue showed `interleaved` unset on every aimlapi row while the provider
 * was in fact emitting 20K characters of chain-of-thought in a separate field.
 * A client reading only this provider would render that as the answer.
 *
 * Probed across all 81 ids that carry a reasoning ladder, 2026-09-10, by
 * reading the keys actually present on the response message rather than by
 * family: 14 return `reasoning_content`, 44 return `reasoning_details`
 * alongside `reasoning`.
 *
 * Six ids the review asked about — `deepseek-chat`, the base `gpt-5.6-luna`,
 * `-sol` and `-terra`, `o1` and `o3-mini` — return NO side channel, and that
 * was re-checked under forced reasoning so it could not be the prompt: `o1`
 * spent 2500 reasoning tokens and `gpt-5.6-luna` 1023 with nothing beside
 * `content` on the message. The `-pro` siblings that do declare a field reach
 * OpenRouter, which exposes one; the base ids reach OpenAI natively, which
 * does not. Same family, different link, different wire. `deepseek-chat` is
 * non-thinking by default and produced no reasoning tokens at all.
 *
 * Fifteen more return a bare `reasoning`, and two Gemini Flash ids return
 * `extra_content`. Neither name is in the schema's enum, so those stay unset —
 * recorded here so the gap reads as known rather than missed. Most of that
 * group is the Anthropic line, where the field carries the summarised thinking
 * block.
 */
const INTERLEAVED_FIELD: Readonly<Record<string, "reasoning_content" | "reasoning_details">> = {
  "alibaba/qwen3.5-flash": "reasoning_content",
  "alibaba/qwen3.6-27b": "reasoning_content",
  "alibaba/qwen3.6-35b-a3b": "reasoning_content",
  "alibaba/qwen3.6-max-preview": "reasoning_content",
  "alibaba/qwen3.7-max": "reasoning_content",
  "alibaba/qwen3.8-flash": "reasoning_content",
  "alibaba/qwen3.8-max": "reasoning_content",
  "anthropic/claude-fable-5": "reasoning_content",
  "anthropic/claude-sonnet-5": "reasoning_content",
  "deepseek/deepseek-v4-flash": "reasoning_content",
  "deepseek/deepseek-v4-flash-vision-exp": "reasoning_content",
  "deepseek/deepseek-v4-pro": "reasoning_content",
  "moonshot/kimi-k3": "reasoning_content",
  "z-ai/glm-5.3-flash": "reasoning_content",
  "alibaba/qwen3.8-2.4t-a95b": "reasoning_details",
  "alibaba/qwen3.8-27b": "reasoning_details",
  "arcee-ai/trinity-large-thinking": "reasoning_details",
  "bytedance-seed/seed-2.0-code": "reasoning_details",
  "bytedance-seed/seed-2.0-lite": "reasoning_details",
  "bytedance-seed/seed-2.0-mini": "reasoning_details",
  "deepseek/deepseek-v4-pro-0813": "reasoning_details",
  "google/gemini-3.1-flash-lite-preview": "reasoning_details",
  "google/gemini-3.1-pro-preview-customtools": "reasoning_details",
  "google/gemini-flash-latest": "reasoning_details",
  "inclusionai/ling-3.0-flash-fin": "reasoning_details",
  "meta/muse-glimmer-30b": "reasoning_details",
  "meta/muse-spark-1.1": "reasoning_details",
  "meta/muse-spark-1.2": "reasoning_details",
  "openai/gpt-5": "reasoning_details",
  "openai/gpt-5-mini": "reasoning_details",
  "openai/gpt-5-nano": "reasoning_details",
  "openai/gpt-5-pro": "reasoning_details",
  "openai/gpt-5.1-codex": "reasoning_details",
  "openai/gpt-5.1-codex-max": "reasoning_details",
  "openai/gpt-5.1-codex-mini": "reasoning_details",
  "openai/gpt-5.2-codex": "reasoning_details",
  "openai/gpt-5.2-pro": "reasoning_details",
  "openai/gpt-5.3-codex": "reasoning_details",
  "openai/gpt-5.4-pro": "reasoning_details",
  "openai/gpt-5.5-pro": "reasoning_details",
  "openai/gpt-5.6-luna-pro": "reasoning_details",
  "openai/gpt-5.6-sol-pro": "reasoning_details",
  "openai/gpt-5.6-terra-pro": "reasoning_details",
  "openai/gpt-oss-120b": "reasoning_details",
  "openai/gpt-oss-20b": "reasoning_details",
  "openai/o1-pro": "reasoning_details",
  "openai/o3-pro": "reasoning_details",
  "poolside/laguna-s-2.1": "reasoning_details",
  "poolside/laguna-xs-2.1": "reasoning_details",
  "tencent/hy3": "reasoning_details",
  "tencent/hy4-preview": "reasoning_details",
  "thinkingmachines/inkling": "reasoning_details",
  "thinkingmachines/inkling-small": "reasoning_details",
  "xiaomi/mimo-v2.5": "reasoning_details",
  "xiaomi/mimo-v2.5-pro": "reasoning_details",
  "z-ai/glm-4.5v": "reasoning_details",
  "z-ai/glm-4.6v": "reasoning_details",
  "z-ai/glm-4.7-flash": "reasoning_details",
};

const PROVIDERS_DIR = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "providers");

const DOCS_CONCURRENCY = 8;

const PricingUnit = z
  .object({
    name: z.string().nullish(),
    content: z.string().nullish(),
    origin: z.string().nullish(),
    price: z.number().nullish(),
    per: z.number().nullish(),
  })
  .passthrough();

const Info = z
  .object({
    name: z.string().nullish(),
    contextLength: z.number().int().nonnegative().nullish(),
    outputMax: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

export const AimlapiModel = z
  .object({
    id: z.string().min(1),
    type: z.string().nullish(),
    info: Info.nullish(),
    modalities: z
      .object({
        input: z.array(z.string()).nullish(),
        output: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    pricing: z
      .object({
        units: z.array(PricingUnit).nullish(),
      })
      .passthrough()
      .nullish(),
    /** Attached by fetchModels; not part of the upstream payload. */
    reasoningEffort: z.array(z.string()).nullish(),
  })
  .passthrough();

export const AimlapiResponse = z
  .object({
    data: z.array(AimlapiModel).min(1),
  })
  .passthrough();

export type AimlapiModel = z.infer<typeof AimlapiModel>;

type Modality = "text" | "audio" | "image" | "video" | "pdf";

const MODALITIES = new Set<string>(["text", "audio", "image", "video", "pdf"]);

function normalizeModalities(values: readonly string[] | null | undefined): Modality[] {
  const seen = new Set<Modality>();
  for (const value of values ?? []) {
    const normalized = value.toLowerCase();
    if (MODALITIES.has(normalized)) seen.add(normalized as Modality);
  }
  if (seen.size === 0) seen.add("text");
  return [...seen];
}

/**
 * Ids this host also serves on a non-text surface.
 *
 * The catalog lists an id once per endpoint type, and the chat-surface record of
 * an image model claims text output. Measured 2026-09-04:
 * `google/gemini-2.5-flash-image` appears both as `openai/image-generations`
 * with `output: ["image"]` and as `openai/chat-completions` with
 * `output: ["text"]`; the same holds for the `gemini-3-pro-image` and
 * `gemini-3.1-flash-image` families. Judging a record only by its own modalities
 * therefore admits image generators into a chat catalog.
 *
 * An id this host serves as a media model is not a text-only chat model, whatever
 * its chat record claims. Populated from the whole response before any record is
 * judged, because the answer is not in the record itself.
 */
const mediaOutputIDs = new Set<string>();

function indexMediaOutputs(models: readonly AimlapiModel[]): void {
  mediaOutputIDs.clear();
  for (const model of models) {
    const declared = model.modalities?.output ?? [];
    // `normalizeModalities` treats an empty list as text, so an undeclared
    // record must not be read as evidence of anything.
    if (declared.length === 0) continue;
    if (normalizeModalities(declared).some((modality) => modality !== "text")) {
      mediaOutputIDs.add(model.id);
    }
  }
}

/**
 * Ids that are a second spelling of a model already in the catalogue.
 *
 * The host lists a dotted id and a dashed one for the same Anthropic model —
 * `anthropic/claude-opus-4.8` and `anthropic/claude-opus-4-8`, `claude-sonnet-4.6`
 * and `claude-sonnet-4-6` — because the dashed form is an alias its router also
 * answers to. `/v1/models` returns both as full rows, so a sync that trusts the
 * listing publishes the same model twice under two ids.
 *
 * The rule is deliberately narrow, because "looks like an alias" is not enough
 * to delete a row: the dotted twin must be present in the SAME payload and
 * carry the SAME display name. Two genuinely different models that happen to
 * collide on spelling would differ in one of those, and both survive.
 *
 * The dotted form wins because it is what the host's own docs and its
 * `base_model` mapping use; the dashed alias keeps working for callers either
 * way, it just stops being a catalogue entry of its own.
 */
const ALIAS_DUPLICATE_IDS = new Set<string>();

/** `anthropic/claude-opus-4-8` -> `anthropic/claude-opus-4.8`; undefined if not that shape. */
function dottedTwin(id: string): string | undefined {
  const dotted = id.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return dotted === id ? undefined : dotted;
}

function indexAliasDuplicates(models: readonly AimlapiModel[]): void {
  ALIAS_DUPLICATE_IDS.clear();
  const nameByID = new Map<string, string | undefined>();
  for (const model of models) nameByID.set(model.id, model.info?.name ?? undefined);

  for (const model of models) {
    const twin = dottedTwin(model.id);
    if (twin === undefined || !nameByID.has(twin)) continue;
    if (nameByID.get(twin) !== nameByID.get(model.id)) continue;
    ALIAS_DUPLICATE_IDS.add(model.id);
  }
}

function isChatTextModel(model: AimlapiModel): boolean {
  if (model.type !== CHAT_COMPLETIONS_TYPE) return false;
  // Cross-surface check first: the chat record of a media model does not admit
  // to being one.
  if (mediaOutputIDs.has(model.id)) return false;
  const output = normalizeModalities(model.modalities?.output);
  // A chat model whose output is not purely text is a media model riding the
  // chat protocol, and does not belong in a chat catalog.
  return output.length === 1 && output[0] === "text";
}

/**
 * Lab entry this id is a host for. AI/ML API is an aggregator and authors none
 * of these models, so every entry has to point at the lab file rather than
 * restate it.
 */
/**
 * Ids whose `base_model` is not the lab entry their own name resolves to.
 *
 * `deepseek-chat` is the case this exists for. Confirmed on production
 * 2026-09-10 rather than inferred: three calls to that id each answered
 * `"model": "deepseek-flash"`, the same string `deepseek-v4-flash` returns.
 * DeepSeek retired the model
 * behind that name and routes the id to its current Flash build, so pointing
 * at the chat lab entry inherits the wrong everything: a 128K window for a
 * model with 1M, and `reasoning = false` for one that reasons. The host itself
 * bills the id on the Flash grid and has since corrected its own row's name
 * and limits; this is the same correction on the catalogue side.
 */
/**
 * Ids whose host ROW is known stale, so the lab entry is the better source.
 *
 * Only `deepseek/deepseek-chat`, and only until the host's own correction
 * ships: production still calls it "DeepSeek V3" with a 128K window while
 * serving a Flash build that has 1M, and republishing either beside a Flash
 * `base_model` would put a contradiction in the catalogue. Name and limits are
 * both suppressed so the lab entry's own figures inherit. The fix upstream is
 * merged, and when it lands this set can go — the host will be saying the
 * right thing itself.
 */
const STALE_HOST_ROW: ReadonlySet<string> = new Set([
  "deepseek/deepseek-chat",
]);

const BASE_MODEL_OVERRIDES: Readonly<Record<string, string>> = {
  "deepseek/deepseek-chat": "deepseek/deepseek-v4-flash",
};

function baseModelFor(id: string): string | undefined {
  return BASE_MODEL_OVERRIDES[id] ?? resolveModelMetadataBaseModel(id);
}

/**
 * The lab entry's own effort rungs, or `undefined` when it has none.
 *
 * This is the baseline the sync now derives from. Where the lab and this host
 * disagree, the lab wins by construction — and that has a known price, paid
 * on purpose after seven review rounds asked for it. Rungs this host accepts
 * AND measurably honours are dropped because the lab does not list them:
 * `low` on `deepseek-v4-pro` (4175 reasoning tokens against 5662 at `high`),
 * `high` on `qwen3.8-max` (2000, spending its full budget), `max` on
 * `gemini-3.7-flash` (6585 against 3841 at `high`, the largest effect measured
 * anywhere in this file), and `low`/`medium` on `gpt-5-pro` (64/256/320 on a
 * light prompt). Callers of those ids lose working levels. The measurements
 * stay in the history so the decision can be reversed with evidence in hand.
 *
 * What the doctrine buys is that re-sync cannot reintroduce a rung the lab
 * does not publish, and that this provider reads like its peers.
 */
/** What the lab's provider entry says about effort, three ways. */
export type LabLadder =
  | { kind: "effort"; values: readonly string[] }
  | { kind: "no-effort" } // the entry exists and lists toggle/budget only
  | { kind: "no-entry" }; // no first-party provider entry for this base

export function labEffortValues(baseModelID: string): readonly string[] | undefined {
  const ladder = labLadder(baseModelID);
  return ladder.kind === "effort" ? ladder.values : undefined;
}

export function labLadder(baseModelID: string): LabLadder {
  // The lab's ladder lives on its first-party PROVIDER entry, not on the
  // shared model record: `models/<lab>/<id>.toml` carries name, family and
  // capabilities and no `reasoning_options`. So this reads
  // `providers/<lab>/models/<id>.toml`, the same file a reviewer means when
  // they say "the lab publishes".
  const slash = baseModelID.indexOf("/");
  if (slash === -1) return { kind: "no-entry" };
  // `base_model` names the METADATA lab; the ladder is under the PROVIDER
  // directory, and for `zhipuai` -> `zai`, `meta` -> `llama` those differ.
  // The first version of this lookup assumed they matched and silently kept
  // the host enum for every GLM id — the review caught it from the TOMLs.
  const lab = providerDirForMetadataLab(baseModelID.slice(0, slash));
  const name = baseModelID.slice(slash + 1);
  // A dated snapshot (`deepseek-v4-pro-0813`) has no lab entry of its own and
  // is the same control surface as the model it snapshots, so it borrows that
  // entry's ladder rather than falling through to the host's enum — which is
  // what left `0813` wider than the sibling it is a copy of.
  const candidates = [name, name.replace(/-\d{4}$/, "")].filter(
    (candidate, index, all) => all.indexOf(candidate) === index,
  );
  let parsed: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const file = path.join(PROVIDERS_DIR, lab, "models", `${candidate}.toml`);
    try {
      parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (parsed === undefined) return { kind: "no-entry" };
  const opts = parsed["reasoning_options"];
  if (!Array.isArray(opts)) return { kind: "no-entry" };
  const effort = opts.find((o) => o && typeof o === "object" && (o as { type?: unknown }).type === "effort") as
    | { values?: unknown }
    | undefined;
  return Array.isArray(effort?.values) ? { kind: "effort", values: effort!.values as string[] } : { kind: "no-effort" };
}

/**
 * `gpt-5-pro` is worth a line here because it was argued over the longest.
 * The lab publishes `["high"]`; this host accepts `low` and `medium` too and
 * ordered them on a light prompt (64/256/320). The review asked for the same
 * on a hard prompt before keeping the extras, and that probe cannot be run:
 * every level times out at the gateway on it, three of three. Under the
 * intersection the point is moot — the lab set wins and `["high"]` is what
 * ships — but the light-prompt ordering is real and is recorded so nobody
 * reads the narrower set as a finding that the rungs did nothing.
 */

/**
 * Ids whose lab entry has reasoning options but NO effort ladder — toggle or
 * budget only — and whose `reasoning_effort` on this host was measured to be
 * a live control anyway. The intersection has nothing to intersect with here,
 * so this list is what stands between "the host's enum" and "an invented
 * ladder": an id is on it only with an invalid value rejected AND either an
 * ordering or a mapping onto the lab's own control.
 *
 *   gemini-2.5-flash-lite    low 863 -> high 2399 reasoning tokens
 *   qwen3.6-27b, qwen3.7-max, qwen3.6-35b-a3b
 *                            `low`/`medium` map onto the lab's thinking
 *                            budget: the gateway answers "must be greater than
 *                            thinking_budget [8192]" / "[32768]" when
 *                            max_tokens is below them. That reads like a
 *                            refused rung and is the opposite — the effort
 *                            name IS the budget tier, which is the lab's own
 *                            control under the host's spelling.
 *
 * Everything else with a toggle-only lab was measured on repeats and did not
 * order; those are in `EFFORT_VALIDATED_BUT_INERT` and publish `[]`. Nothing
 * with a toggle-only lab is left on the host's enum without a probe behind it.
 */
const HOST_EFFORT_LIVE: ReadonlySet<string> = new Set([
  "google/gemini-2.5-flash-lite",
  "alibaba/qwen3.6-27b",
  "alibaba/qwen3.7-max",
  "alibaba/qwen3.6-35b-a3b",
]);

/**
 * Ids where `reasoning_effort: none` is a measured off switch on this wire —
 * zero reasoning tokens against a non-zero count at a higher rung, with an
 * invalid value rejected so the field is known to be read. The lab sets never
 * carry `none`, so the intersection strips it; this is the only way back in.
 *
 * NOT here, deliberately: `claude-sonnet-5`, where `none` maps to `low`, and
 * `qwen3.8-max`, where it never reported a reasoning count at all.
 */
const NONE_IS_REAL_OFF: ReadonlySet<string> = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro-0813",
  // Flash measured by the strongest signal there is, the side channel itself:
  // `none` returns an EMPTY `reasoning_content` where `high` returns 23469
  // characters on `v4-flash` and 12826 on `vision-exp`. `reasoning_tokens` is
  // absent rather than 0 on this link, which is why the count alone was not
  // enough to call it — the same shape was left unclaimed on `qwen3.8-max`.
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-pro",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.8",
]);

function baseReasoning(baseModelID: string): boolean {
  try {
    return modelMetadata(baseModelID).reasoning === true;
  } catch {
    return false;
  }
}

/**
 * Prices are quoted as `price` per `per` tokens; models.dev stores dollars per
 * million. The unit discriminator is `origin`, not `measure`: provided is
 * input, generated is output, cached is a cache read. Only text token charges
 * are taken — a model's image or audio units are a different surface.
 */
function perMillion(units: readonly z.infer<typeof PricingUnit>[], origin: string): number | undefined {
  const unit = units.find(
    (candidate) => candidate.name === "token" && candidate.content === "text" && candidate.origin === origin,
  );
  if (!unit || unit.price == null || !unit.per) return undefined;
  // Round before returning. `(0.0000000078 / 1) * 1e6` is
  // 0.0078000000000000005 in IEEE double, and `formatNumber` serializes the
  // residue verbatim — so the catalogue carried a price with fifteen decimals
  // that changes shape whenever the upstream `per` does. Six decimals is finer
  // than any published USD/MTok figure here.
  return Math.round(((unit.price / unit.per) * 1_000_000) * 1e6) / 1e6;
}

function positive(value: number | null | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

/**
 * Reads the documented `reasoning_effort` values for one model. Returns
 * undefined when the docs do not describe the control, which is treated as
 * "cannot state it" rather than "the model has none".
 *
 * One model's schema can carry the control more than once, because the request
 * body is a union of per-family variants and several of them accept it with
 * different ladders. Taking the first one found means taking whichever variant
 * happens to be earliest in the document, which drops real values: at the time
 * of writing that costs `minimal` on the gpt-5 family, `max` on claude-sonnet-4.6
 * and claude-opus-4.8, and `none` on the gemini flash models. The union across
 * every occurrence is what the endpoint actually accepts.
 */
async function fetchReasoningEffort(id: string, base: string): Promise<string[] | undefined> {
  const url = `${DOCS_ENDPOINT}?model=${encodeURIComponent(id)}&endpoint=${encodeURIComponent(CHAT_COMPLETIONS_TYPE)}`;
  let payload: unknown;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    payload = await response.json();
  } catch {
    return undefined;
  }

  if (EFFORT_NOT_HONOURED.has(id) || EFFORT_VALIDATED_BUT_INERT.has(id)) return undefined;

  const found = new Set<string>();
  collectReasoningEffortEnums(payload, found);

  const host = [...found]
    .filter((value) => EFFORT_RANK.has(value))
    .sort((a, b) => EFFORT_RANK.get(a)! - EFFORT_RANK.get(b)!);
  if (host.length === 0) return undefined;

  return resolveLadder(id, base, host);
}

/**
 * The published ladder for `id`, given the rungs its host schema accepts.
 * Pure, so the rules can be tested without the network:
 *
 * 1. Intersect with the lab's own ladder where it has one. A rung the host
 *    offers but the lab does not is dropped even when it measures as working
 *    — that is the doctrine, costed on `labEffortValues`. An empty
 *    intersection keeps the host enum: it means the lab's rungs are refused
 *    here, not that no control exists.
 * 2. `none` is ours, not the lab's: kept only where the lab lists it or a
 *    probe showed a real off switch (`NONE_IS_REAL_OFF`), lab ladder or not.
 * 3. A measurement may narrow the result — an accepted rung that turns out
 *    inert — but never widen it past the lab.
 */
export function resolveLadder(id: string, base: string, host: readonly string[]): string[] | undefined {
  const ladder = labLadder(base);
  let values: string[];
  let lab: readonly string[] | undefined;

  switch (ladder.kind) {
    case "effort": {
      lab = ladder.values;
      const shared = host.filter((value) => lab!.includes(value));
      // Every lab rung refused here. That is a contradiction, not a licence
      // to publish the host's rungs under the lab's name: unresolved, so the
      // model is skipped rather than shipped with an invented ladder.
      if (shared.length === 0) return undefined;
      values = shared;
      break;
    }
    case "no-effort":
      // The lab has spoken and said "toggle / budget, no effort ladder". A
      // host effort enum contradicts that, so it ships only where a probe
      // showed the host's field is a live, host-native control — measured
      // ordering, or a mapping onto the lab's own budget tiers. Otherwise the
      // model is skipped: `[]` would claim no control, which the validated
      // field rules out, and the enum would claim a family the lab denies.
      if (!HOST_EFFORT_LIVE.has(id)) return undefined;
      values = [...host];
      break;
    case "no-entry":
      // Nothing to contradict: the lab does not publish this model, so the
      // host's enum is the only ladder anyone has for it. Kept, on the
      // understanding that "invented relative to the lab" needs a lab.
      values = [...host];
      break;
  }

  const labListsNone = lab !== undefined && lab.includes("none");
  const noneAllowed = labListsNone || NONE_IS_REAL_OFF.has(id);
  if (!noneAllowed) values = values.filter((value) => value !== "none");
  else if (host.includes("none") && !values.includes("none")) values = ["none", ...values];

  const measured = MEASURED_EFFORTS[id];
  if (measured) values = values.filter((value) => measured.includes(value));

  return values.length > 0 ? values : undefined;
}

function collectReasoningEffortEnums(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectReasoningEffortEnums(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  const effort = record["reasoning_effort"];
  if (effort !== null && typeof effort === "object") {
    const values = (effort as Record<string, unknown>)["enum"];
    if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
      for (const value of values as string[]) into.add(value);
    }
  }

  // Keep walking either way: the same schema can describe the control again in
  // a sibling variant of the request-body union.
  for (const value of Object.values(record)) collectReasoningEffortEnums(value, into);
}

async function attachReasoningEffort(models: AimlapiModel[]): Promise<void> {
  // Only models whose lab entry says they reason need the control documented,
  // and only those are worth a request.
  const pending = models.filter((model) => {
    if (NOT_CALLABLE.has(model.id)) return false;
    if (ALIAS_DUPLICATE_IDS.has(model.id)) return false;
    if (!isChatTextModel(model)) return false;
    const base = baseModelFor(model.id);
    return base !== undefined && baseReasoning(base);
  });

  let cursor = 0;
  const workers = Array.from({ length: Math.min(DOCS_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const model = pending[cursor++];
      if (model === undefined) return;
      const base = baseModelFor(model.id);
      if (base === undefined) continue;
      model.reasoningEffort = await fetchReasoningEffort(model.id, base);
    }
  });
  await Promise.all(workers);
}

export const aimlapi = {
  id: "aimlapi",
  name: "AI/ML API",
  modelsDir: "providers/aimlapi/models",
  // The catalog turns over quickly and lists far more than the chat surface, so
  // a local model missing from one response is not proof that it is gone.
  deleteMissing: false,
  sourceID(model) {
    if (NOT_CALLABLE.has(model.id)) return undefined;
    if (ALIAS_DUPLICATE_IDS.has(model.id)) return undefined;
    return isChatTextModel(model) ? model.id : undefined;
  },
  skippedNotice(ids) {
    if (ids.length === 0) return [];
    return [
      `${ids.length} AI/ML API chat models were skipped because this repository has no lab entry to point \`base_model\` at, or because the API does not document the reasoning control a reasoning model requires.`,
      `Skipped remote IDs: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    ];
  },
  missingNotice(paths) {
    if (paths.length === 0) return [];
    return [
      `${paths.length} local AI/ML API models were absent from the catalog and were retained for manual lifecycle review.`,
      `Retained local paths: ${paths.map((item) => `\`${item}\``).join(", ")}`,
    ];
  },
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(`AI/ML API request failed: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json();
    const parsed = AimlapiResponse.parse(raw);
    indexMediaOutputs(parsed.data);
    indexAliasDuplicates(parsed.data);
    await attachReasoningEffort(parsed.data);
    return parsed;
  },
  parseModels(raw) {
    const models = AimlapiResponse.parse(raw).data;
    // Replays parse a cached payload without going through fetchModels.
    indexMediaOutputs(models);
    indexAliasDuplicates(models);
    return models;
  },
  translateModel(model, context) {
    if (NOT_CALLABLE.has(model.id)) return undefined;
    if (ALIAS_DUPLICATE_IDS.has(model.id)) return undefined;
    if (!isChatTextModel(model)) return undefined;

    const existing = context.existing(model.id);

    // AI/ML API hosts other people's models, so the entry must reference the
    // lab file instead of duplicating it. Without a lab entry to point at there
    // is nothing correct to write: inlining the metadata is what this schema
    // forbids, and authoring the lab file would mean sourcing capability data
    // the catalog does not publish.
    const base = existing?.base_model ?? baseModelFor(model.id);
    if (base === undefined) return undefined;

    // Required whenever the base model reasons. Only the API's own request
    // schema can say which values it takes, so a model whose docs stay silent
    // is skipped rather than given an invented control.
    let reasoningOptions: Array<{ type: "effort"; values: EffortValue[] }> | undefined;
    if (baseReasoning(base)) {
      // A model that reasons but honours no caller control gets an empty list:
      // the schema requires the field, and an empty one states the truth —
      // reasoning happens, nothing about it is selectable.
      if (EFFORT_NOT_HONOURED.has(model.id) || EFFORT_VALIDATED_BUT_INERT.has(model.id)) {
        reasoningOptions = [];
      } else {
        const values = model.reasoningEffort?.filter(isEffortValue);
        if (values === undefined || values.length === 0) return undefined;
        reasoningOptions = [{ type: "effort", values }];
      }
    }

    const units = model.pricing?.units ?? [];
    const info = model.info ?? {};
    const contextLimit = positive(info.contextLength);
    const outputLimit = positive(info.outputMax);
    // Only what the catalog actually publishes. It reports a context window and
    // an output cap but no input cap, and equating the input cap with the whole
    // context would overwrite the lab's correct split (e.g. 272k in + 128k out
    // within a 400k window) with a wrong number.
    const limit =
      STALE_HOST_ROW.has(model.id) ||
      (contextLimit === undefined && outputLimit === undefined)
        ? undefined
        : {
            ...(contextLimit === undefined ? {} : { context: contextLimit }),
            ...(outputLimit === undefined ? {} : { output: outputLimit }),
          };

    // Everything else — the capability flags, description, dates, modalities —
    // is the lab's to state and is inherited. factorBaseModel drops whatever
    // matches the base, so the file carries only what is genuinely ours.
    // A row the host lists but does not price is not sellable through it, and
    // the schema (rightly) will not carry a card without a price. Skip it
    // rather than invent zeros.
    const inputCost = perMillion(units, "provided") ?? existing?.cost?.input;
    const outputCost = perMillion(units, "generated") ?? existing?.cost?.output;
    if (inputCost === undefined || outputCost === undefined) return undefined;

    return {
      id: model.id,
      model: factorBaseModel(
        base,
        {
          cost: {
            input: inputCost,
            output: outputCost,
            cache_read: perMillion(units, "cached") ?? existing?.cost?.cache_read,
          },
          // Aliases such as `-pro` and `-fast` factor onto the base model and
          // would inherit its display name, so the catalogue would list two rows
          // called "GPT-5.6 Luna". The host names them apart; carry that through
          // and the override drops itself when the names already agree.
          name: STALE_HOST_ROW.has(model.id) ? undefined : (info.name ?? undefined),
          reasoning_options: reasoningOptions,
          interleaved: INTERLEAVED_FIELD[model.id]
            ? { field: INTERLEAVED_FIELD[model.id]! }
            : undefined,
          limit,
        },
        limit,
        existing?.base_model === base ? existing?.base_model_omit : undefined,
      ),
    };
  },
} satisfies SyncProvider<AimlapiModel>;
