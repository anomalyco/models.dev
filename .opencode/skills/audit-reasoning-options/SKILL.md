---
name: audit-reasoning-options
description: Audit or write models.dev reasoning_options in provider TOML files and reasoning-option PRs. Use when verifying toggle, effort, budget_tokens, provider reasoning controls, or citations.
---

# Audit Reasoning Options

`AGENTS.md` → **Reasoning options** is authoritative. This skill is the workflow.

Provider capability = this host’s HTTP request surface (not the npm package, SDK types, or UI).

## Schema shapes

```toml
[[reasoning_options]]
type = "toggle"

[[reasoning_options]]
type = "effort"
values = ["low", "medium", "high"]

[[reasoning_options]]
type = "budget_tokens"
min = 1_024
max = 32_000
```

- `effort` values may include `null`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `default` — **never dump the full enum**.
- `budget_tokens` = reasoning tokens only, not `max_tokens`. Bounds only when verified.
- `[]` = model reasons, **no** caller control. Omitted = not authored (invalid once `reasoning = true`).

## Step 1 — classify the host (role, not npm)

| Kind | Definition | Options source |
| --- | --- | --- |
| **First-party lab** | `providers/<id>` **is** the model creator (OpenAI, Anthropic, DeepSeek, Alibaba, Google, …) | That lab’s docs + existing `providers/<lab>/` entries |
| **Multi-model relay** | Hosts many labs (OpenRouter, aggregators, most new “OpenAI-compatible” startups) | Lab entry for the underlying model + same-surface relay peers |

**Critical:** `npm = "@ai-sdk/openai-compatible"` is used by **both** labs (DeepSeek, Alibaba) and relays. It does **not** mean “apply GPT L/M/H gateway defaults.”

- DeepSeek first-party: `thinking.type` + `reasoning_effort` `high`|`max`
- Alibaba first-party: `enable_thinking` + often `thinking_budget`; Responses API may use `reasoning.effort`
- A random relay of GPT-5.4: usually passthrough `reasoning_effort` with GPT-like levels

Never compare a native Anthropic Messages route to an OpenAI chat-completions relay as if they shared one control surface.

## Step 2 — establish options

1. Resolve underlying model (`base_model` / lab id).
2. Read **first-party** `providers/<lab>/models/…` for that model.
3. If authoring a **relay**, also sample 1–2 established relays of the same model.
4. Use native/peer controls as the baseline, then reconcile exact-host evidence:
   - Effort values from native/peers (may be `high`/`max` only, or `low`/`medium`/`high`, or include `none`/`xhigh`, …)
   - Toggle if native/peers have a real on/off **and** this host forwards it
   - Budget only if a reasoning-budget field exists on this path
5. On relays: if native/peers have caller controls, **do not** write `[]` from uncertainty.
6. On labs: match that lab; do not paste another lab’s enum.

Match the exact host SKU **and model revision** before comparing controls. An undated alias can serve a different revision from a lab's current alias or a dated peer. Host wire names also differ: `xhigh` on a gateway does not establish `xhigh` on an upstream renderer that calls that level `max`. Resolve conflicting sets with exact-host evidence; do not union the enums or silently assume a mapping.

### What “baseline” means

**Baseline = the effort (and toggle/budget) set used by the lab and/or same-surface peers for this model.**

It is **not** “always `low`/`medium`/`high`.” That triple is only the usual GPT-style relay case.

| Example | Typical options |
| --- | --- |
| GPT-5.4 on a relay | `effort` `none`/`low`/`medium`/`high`/`xhigh` as peers/native show |
| DeepSeek V4 on DeepSeek or a faithful relay | `toggle` + `effort` `high`/`max` |
| Qwen3.5 Plus on Alibaba | `toggle` + `budget_tokens` (chat path) |
| Always-on thinking model | `[]` |

## Step 3 — toggle rules

| Situation | Shape |
| --- | --- |
| `none` ∈ effort **and** other graded levels | `effort` only — **no** `toggle` |
| Separate on/off field + graded effort (no `none` in effort) | `toggle` + `effort` |
| Binary on/off only | `toggle` |

Toggle requires a **leading top-of-file** wire comment, e.g.:

```toml
# Toggle: thinking.type = enabled|disabled
# Effort: reasoning_effort = high|max
```

```toml
# Toggle: enable_thinking true|false
# Budget: thinking_budget
```

Not toggle: split model IDs; UI-only; `effort=low` as “off”; pairing `toggle` with effort that already includes `none`.

An automatic/adaptive mode is not necessarily graded effort. Inspect its semantics: if it lets the model choose whether to think, document it separately from the explicit on/off pair. A `toggle` header must name only that pair. Do not invent effort values to encode a third mode the schema cannot represent; state the representation limit without claiming that the API lacks the mode.

## Step 4 — budget rules

- Reasoning-token budget only.
- Legitimate families: older Anthropic extended thinking, some Alibaba/Qwen `thinking_budget`, some older Gemini budgets.
- Not for GPT-5.x effort-only, Claude 4.7+ adaptive effort, DeepSeek V4, or random MoE relays without a budget API.
- Never derive min/max from `limit.output` or context.
- Host extensions can legitimately exceed the lab/peer baseline. For each such budget, cite the host's definition of **reasoning tokens** and a request example with the exact nesting. For example, Parasail's GPT-OSS [model-specific notes](https://docs.parasail.io/parasail-docs/products/overview/model-specific-notes#gpt-oss-reasoning-control) define `custom_params.thinking_budget` as "Upper bound on internal reasoning tokens." Do not remove a documented host extension merely because another host only exposes effort.

## Evidence bar

| Claim | Bar |
| --- | --- |
| Effort/toggle/budget matching first-party lab entry on that lab | Lab docs or existing lab TOML |
| Same options on a relay | Lab + peer relays, or this host docs/test; no contradiction |
| Extra levels beyond lab/peers | This host docs or live meaningful effect |
| `[]` | Affirmative no control — not “I didn’t check” |

Distinguish a published capability contract from an implementation clue:

- Host documentation with token semantics or an exact request example can establish a control without a paid inference call. Quote the relevant text in the leading TOML header when peer controls differ.
- A catalog's discovered model-file template is not necessarily the active deployment template. An upstream tokenizer signature or a generic `chat_template_kwargs` field alone does not prove a custom renderer forwards every argument.
- If a specific forwarding gap is known, resolve it with current deployment evidence or retain only the supported subset. Do not label an explicitly unverified path as verified, and do not replace uncertainty with `[]`.
- A successful HTTP response alone does not show that an effort field was honored. A behavior check needs a meaningful effect, validation error, or authoritative renderer/configuration evidence.
- For authenticated probes, hold the prompt and sampling settings fixed and cap output tokens. Where supported, compare `prompt_token_ids` via `return_token_ids=true` to establish that effort reaches rendering; different levels can have equal prompt lengths. Pair on/off checks with reported reasoning usage. Accepted invalid values may silently fall back, and equal token counts alone do not prove two levels are aliases. Record the exact SKU, date, wire fields, request settings, and observed effect in the leading header; never record credentials.

## Anti-patterns

- Treating every `@ai-sdk/openai-compatible` host as a GPT L/M/H gateway
- Forcing `low`/`medium`/`high` onto DeepSeek V4 (or any narrower native set)
- `[]` on a relay of a controlled reasoner from uncertainty
- Full schema effort enum dumps
- Bogus `budget_tokens` / bounds from output limits
- `toggle` + `none` inside the same effort list
- Wrong wire comments in examples or files

## Audit workflow

1. Classify host: first-party lab vs multi-model relay.
2. Verify exact request IDs against the host catalog/API; preserve unusual aliases verbatim and use subfolders only for actual `/` characters.
3. List changed models and proposed options, including model revisions and exact wire paths.
4. For each: lab entry + same-surface peers → baseline; reconcile host differences with a quoted source or meaningful behavior check.
5. Fix invented levels, false `[]`, dual none+toggle, bad budgets, and mode/effort conflation.
6. Put sources, wire semantics, and representation limits in leading TOML comments; sync may drop later comments.
7. Run `bun validate` when authoring. It checks catalog/schema consistency, not live request IDs or deployed control behavior.
8. PR body: host kind, wire fields, why this option set, evidence checked, and any unresolved deployment check. Do not mark unresolved checks complete.

## PR audit output

- Host classification per provider
- Models and options; verdict per option
- Toggle wire path when present
- Whether baseline was copied from lab vs peers
- Validation result
