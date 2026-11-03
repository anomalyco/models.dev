---
name: audit-reasoning-options
description: Audit or write models.dev reasoning controls (capabilities.reasoning) in provider TOML files and reasoning-control PRs. Use when verifying toggle, effort, budget, provider reasoning controls, or citations.
---

# Audit Reasoning Options

`AGENTS.md` → **Reasoning controls** is authoritative. This skill is the workflow.

Provider capability = this host’s HTTP request surface (not the npm package, SDK types, or UI).

## Schema shapes

Controls live in the provider model file (never in `models/`):

```toml
schema = 2
base_model = "…"

[capabilities]
reasoning = { supported = true, toggle = true, effort = ["low", "medium", "high"], budget = { min = 1_024, max = 32_000 } }
```

- `effort` values may include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `default`, sorted low to high — **never dump the full enum**.
- `budget` = reasoning tokens only, not `max_tokens`. Use `budget = {}` when bounds aren't verified.
- `reasoning = { supported = true }` with no `toggle` / `effort` / `budget` = model reasons, **no** caller control. A relay file that leaves controls out silently inherits that, so only do it on purpose.

## Step 1 — classify the host (role, not npm)

| Kind | Definition | Options source |
| --- | --- | --- |
| **First-party lab** | `providers/<id>` **is** the model creator (OpenAI, Anthropic, DeepSeek, Alibaba, Google, …) | That lab’s docs + existing `providers/<lab>/` entries |
| **Multi-model relay** | Hosts many labs (OpenRouter, aggregators, most new “OpenAI-compatible” startups) | Lab entry for the underlying model + same-surface relay peers |

**Critical:** `npm = "@ai-sdk/openai-compatible"` is used by **both** labs (DeepSeek, Alibaba) and relays. It does **not** mean “apply GPT L/M/H gateway defaults.”

- DeepSeek first-party: `thinking.type` + `reasoning_effort` `low`|`high`|`max`
- Alibaba first-party: `enable_thinking` + often `thinking_budget`; Responses API may use `reasoning.effort`
- A random relay of GPT-5.4: usually passthrough `reasoning_effort` with GPT-like levels

Never compare a native Anthropic Messages route to an OpenAI chat-completions relay as if they shared one control surface.

## Step 2 — establish options

1. Resolve underlying model (`base_model` / lab id).
2. Read **first-party** `providers/<lab>/models/…` for that model.
3. If authoring a **relay**, also sample 1–2 established relays of the same model.
4. Copy the **intersection that this host can actually expose**:
   - Effort values from native/peers (may be `high`/`max` only, or `low`/`medium`/`high`, or include `none`/`xhigh`, …)
   - Toggle if native/peers have a real on/off **and** this host forwards it
   - Budget only if a reasoning-budget field exists on this path
5. On relays: if native/peers have caller controls, **do not** leave them out from uncertainty.
6. On labs: match that lab; do not paste another lab’s enum.

### What “baseline” means

**Baseline = the effort (and toggle/budget) set used by the lab and/or same-surface peers for this model.**

It is **not** “always `low`/`medium`/`high`.” That triple is only the usual GPT-style relay case.

| Example | Typical options |
| --- | --- |
| GPT-5.4 on a relay | `effort` `none`/`low`/`medium`/`high`/`xhigh` as peers/native show |
| DeepSeek V4 on DeepSeek or a faithful relay | `toggle` + `effort` `low`/`high`/`max` |
| Qwen3.5 Plus on Alibaba | `toggle` + `budget` (chat path) |
| Always-on thinking model | no controls |

## Step 3 — toggle rules

| Situation | Shape |
| --- | --- |
| `none` ∈ effort **and** other graded levels | `effort` only — **no** `toggle` |
| Separate on/off field + graded effort (no `none` in effort) | `toggle = true` + `effort` |
| Binary on/off only | `toggle = true` |

Toggle requires a **leading top-of-file** wire comment, e.g.:

```toml
# Toggle: thinking.type = enabled|disabled
# Effort: reasoning_effort = low|high|max
```

```toml
# Toggle: enable_thinking true|false
# Budget: thinking_budget
```

Not toggle: split model IDs; UI-only; `effort=low` as “off”; pairing `toggle` with effort that already includes `none`.

## Step 4 — budget rules

- Reasoning-token budget only.
- Legitimate families: older Anthropic extended thinking, some Alibaba/Qwen `thinking_budget`, some older Gemini budgets.
- Not for GPT-5.x effort-only, Claude 4.7+ adaptive effort, DeepSeek V4, or random MoE relays without a budget API.
- Never derive min/max from `limit.output` or context.

## Evidence bar

| Claim | Bar |
| --- | --- |
| Effort/toggle/budget matching first-party lab entry on that lab | Lab docs or existing lab TOML |
| Same options on a relay | Lab + peer relays, or this host docs/test; no contradiction |
| Extra levels beyond lab/peers | This host docs or live meaningful effect |
| No controls | Affirmative no control — not “I didn’t check” |

## Anti-patterns

- Treating every `@ai-sdk/openai-compatible` host as a GPT L/M/H gateway
- Forcing `low`/`medium`/`high` onto DeepSeek V4 (or any narrower native set)
- No controls on a relay of a controlled reasoner from uncertainty
- Full schema effort enum dumps
- Bogus `budget` / bounds from output limits
- `toggle` + `none` inside the same effort list
- Wrong wire comments in examples or files

## Audit workflow

1. Classify host: first-party lab vs multi-model relay.
2. List changed models and proposed options.
3. For each: lab entry + peers → expected shape.
4. Fix invented L/M/H, false no-control entries, dual none+toggle, bad budgets.
5. `bun validate` when authoring.
6. PR body: host kind, wire fields, why this option set.

## PR audit output

- Host classification per provider
- Models and options; verdict per option
- Toggle wire path when present
- Whether baseline was copied from lab vs peers
- Validation result
