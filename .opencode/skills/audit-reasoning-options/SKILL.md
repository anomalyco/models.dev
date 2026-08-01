---
name: audit-reasoning-options
description: Audit or write models.dev reasoning_options in provider TOML files and reasoning-option PRs. Use when verifying toggle, effort, budget_tokens, provider reasoning controls, or citations.
---

# Audit Reasoning Options

Use this workflow to add or review `reasoning_options` for a specific provider. Treat these fields as provider capabilities, not provider-agnostic model facts.

Provider capability means the inference service's accepted HTTP request surface. It does not mean the controls exposed by the repository's configured npm package, a preferred SDK, or a typed client wrapper.

`AGENTS.md` **Reasoning options policy** is authoritative. This skill is the detailed workflow.

## Available Options

The schema in `packages/core/src/schema.ts` supports:

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

- `toggle`: The provider offers an explicit way to switch reasoning on and off for the same model ID.
- `effort`: Discrete effort values. Schema allows `null`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `default`. Do not dump the full enum.
- `budget_tokens`: Numeric **reasoning-token** budget only. `min`/`max` optional and only when verified. Not `max_tokens`.
- `reasoning_options = []`: Model reasons; provider exposes **no** user-selectable control.
- Omitted `reasoning_options`: No provider claim authored yet (invalid once `reasoning = true` is set).

## Classify the provider first

1. Read `providers/<id>/provider.toml` (`npm`, `api`, `doc`).
2. Note any per-model `[provider]` overrides.
3. Classify the request surface:
   - **OpenAI-compatible gateway** — `@ai-sdk/openai-compatible` or chat-completions passthrough of `reasoning_effort` / similar.
   - **Native provider** — Anthropic, Google, OpenAI first-party, DeepSeek, Alibaba, etc. with that lab's request shape.
   - **Multi-surface** — e.g. Anthropic Messages + OpenAI compat; audit the surface this model ID actually uses.

Never treat a native Anthropic route and an OpenAI gateway as interchangeable.

## OpenAI-compatible gateway defaults (most PRs)

Vast majority of new providers are OpenAI-compatible gateways.

| Situation | What to author |
| --- | --- |
| Reasoning model; upstream/native or established same-surface peers use effort | **Baseline:** `effort` `low`, `medium`, `high` |
| Extra levels (`none`, `minimal`, `xhigh`, `max`, …) documented or live-proven on this host or clear peers | Add only those extra values |
| Explicit on/off on the **same** model ID | Add `toggle` (with wire path) |
| Always-on thinking; only separate think/instruct IDs; verified no control | `reasoning_options = []` |
| Author “could not re-prove every value” on this host | **Still use baseline effort** if upstream/peers support it — do **not** collapse to `[]` |

### How to establish the baseline

1. Resolve `base_model` / underlying model id.
2. Read native provider TOML for that model (e.g. `providers/openai`, `providers/anthropic`, `providers/deepseek`).
3. Sample 2–3 established OpenAI-compatible peers hosting the same model (OpenRouter, etc.).
4. If those surfaces use discrete effort, author at least `low`/`medium`/`high` unless this provider documents a **narrower** set or rejects them.
5. If native is toggle-only (e.g. many Qwen/GLM hosts) and peers use toggle via `extra_body` / `enable_thinking`, prefer `toggle` over inventing effort.
6. If native is always-on (`[]`) and peers are `[]`, keep `[]`.

Upstream and same-surface peers are **valid positive evidence for the baseline** on gateways. They are not a license to copy exotic values or `budget_tokens` without gateway-appropriate evidence.

## Native provider rules

Match the lab API and existing same-provider entries for that generation:

- Modern Claude (4.6/4.7+ effort / adaptive): effort values as documented — **not** blanket legacy `budget_tokens` on 4.7+.
- Older Claude extended thinking: `budget_tokens` (and effort only if that generation has it).
- OpenAI GPT-5.x: effort including `none`/`xhigh` when that model supports them first-party.
- DeepSeek V4: typically `toggle` + `effort` `high`/`max` (not `xhigh`, not budget).
- Do not paste OpenAI gateway enums onto native SDKs.

## Evidence standard

Use evidence in this order:

1. Provider API reference / model docs for **this** host.
2. Provider OpenAPI, endpoint metadata, playground payloads.
3. Reproducible request on this host (plus invalid value when practical).
4. Official SDK **emitting** a field (positive only).
5. **Same-surface peer** provider entries for the same model (especially OpenAI gateways).
6. Upstream/native model documentation and native provider TOMLs.
7. Secondary sources as supporting context only.

| Claim | Evidence bar |
| --- | --- |
| Gateway baseline `low`/`medium`/`high` | Upstream or same-surface peers sufficient unless this host contradicts |
| Extra effort values, `toggle` | This host docs/test or strong same-surface peer + no contradiction |
| `budget_tokens` + bounds | This host (or native API this host clearly proxies) must expose a **reasoning** budget; bounds verified — never from `limit.output` |
| `reasoning_options = []` | Affirmative “no control” (always-on / split IDs / documented absence) — not uncertainty |

An SDK missing a helper does not prove the HTTP API rejects a field.

## Anti-patterns (reject in review / fix when authoring)

- `reasoning_options = []` on an OpenAI gateway solely because live proof was incomplete.
- Copying the **full** effort schema enum into a model.
- `budget_tokens` on GPT-5.x, Claude 4.7+, DeepSeek V4, or random MoE gateways without a real reasoning-budget API.
- `budget_tokens.max` taken from context or `limit.output`.
- `toggle` because a UI has a switch, or because `-thinking` and instruct are different IDs.
- Claiming gateway options from a **native-only** control shape without passthrough evidence (or the reverse).
- Treating output/`max_tokens` limits as reasoning budgets.

## Toggle verification

Only add `toggle` if all are true:

- Same provider model ID runs with reasoning on and off.
- Caller controls it through a documented or reproduced request.
- Exact field and values are known.

Complete before accepting:

> `<provider model ID>` toggles reasoning with `<request path>` set to `<enabled>` or `<disabled>`.

Not toggle: split model IDs; omit-budget ⇒ auto budget; `effort=low` unless docs say it disables; hybrid marketing copy; UI-only switches.

## Effort verification

- Gateways: start from baseline `low`/`medium`/`high` when applicable (see above).
- Verify exotic values individually before adding.
- Prefer meaningful effect over mere HTTP 200 (gateways often ignore unknown fields).
- Preserve JSON `null` as TOML `null`, not `"null"`.

## Budget verification

- Reasoning tokens only, not total output.
- Cite real request path (`thinking.budget_tokens`, `thinking_budget`, `reasoning.max_tokens`, …).
- Typical legitimate families: older Anthropic extended thinking, some Alibaba/Qwen budgets, some older Gemini budgets.
- Omit unverified min/max; never infer from output/context limits.
- If `0` disables thinking, that may also support `toggle` — verify separately.

## Audit workflow

1. Classify provider surface (`provider.toml` + model overrides).
2. List every changed model and proposed options.
3. Group by API family / adapter.
4. For each model: resolve underlying model, native entry, same-surface peers.
5. Apply gateway baseline vs native rules above.
6. Strip exotic claims without evidence; **restore** baseline effort when `[]` was used incorrectly on a gateway.
7. Confirm no bogus `budget_tokens`.
8. Run `bun validate` and `git diff --check` when authoring.
9. PR body: citations, wire fields, and why baseline vs `[]` vs extras.

## Citations

Prefer PR body for sources. Leading TOML comment blocks are OK for durable URLs (sync strips mid-file comments). Short adjacent comments for exact API syntax of a reasoning option are encouraged when non-obvious.

## PR audit output

Report:

- Models and proposed options.
- Surface classification (gateway vs native).
- Verdict per option: verified, corrected (note from→to), or removed.
- Toggle wire path when applicable.
- When baseline effort was inferred from upstream/peers, say so explicitly.
- Tests and limits.
- Validation result.

When ambiguous: keep gateway **baseline** effort if the model is an effort model on comparable surfaces; drop only unverified **extras**. Use `[]` only for true no-control cases.
