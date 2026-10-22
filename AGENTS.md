# Agent Guidelines for models.dev

Catalog-only. This file is how to add and maintain **models** and **providers**. Nothing else.

## Validate

```bash
bun validate
bun run v1:check
```

Run both after every catalog change. `bun validate` must pass before a PR is mergeable; it rejects any model file without `schema = 2`.

`bun run v1:check` (or `bun run v1:check <ref>`) protects the published v1 API (`api.json`, etc.), which is still generated from these files. It compares the v1 output with the merge-base of `origin/dev`, lists every changed field, every model added to or removed from v1, and changed files that still use generic modalities, and exits 1 if v1 changed. Keep v1 changes to additive or clearly sourced fixes, and list them in the PR.

## Two concepts: lab models vs providers

| | Lab model file | Provider model file |
| --- | --- | --- |
| **What** | Facts about a model that are true on every host | How a specific API host serves that model |
| **Where** | `models/<lab-id>/<model-id>.toml` | `providers/<provider-id>/models/.../<id>.toml` |
| **Examples** | `models/anthropic/claude-opus-4-6.toml`, `models/openai/gpt-5.4.toml` | `providers/openrouter/models/anthropic/claude-opus-4.6.toml` |
| **Contains** | name, description, family, dates, modalities, base capabilities, limits, weights, … | reasoning controls, `structured_output`, cache, service tiers, cost, `status`, APIs, and **only real overrides** |

- **Labs** create models (Anthropic, OpenAI, Google, DeepSeek, Alibaba, …).
- **Providers** host or relay them (the lab’s own API, OpenRouter, Bedrock, a random OpenAI-compatible gateway, …).

Filename (minus `.toml`) is the model `id`. **Never** put an `id` field in the TOML. Schema is strict (`packages/core/src/schema-v2.ts`); unknown keys fail validation.

### Lab file

```toml
schema = 2
name = "Claude Opus 5.5"
description = "…"
family = "claude-opus"
open_weights = false
knowledge = "2026-06"
release_date = "2026-09-22"
# last_updated: only when it differs from release_date

[modalities]
input = ["text", "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = true }
temperature = false
top_p = false
top_k = false

[limit]
context = 1_000_000
output = 128_000
```

Required: `name`, `description`, `open_weights`, `release_date`, `[modalities]`, `[capabilities]` (`tools`, `reasoning = { supported = … }`, and explicit `temperature`, `top_p`, `top_k`), and `[limit]`. Recommended: `family`, `knowledge`, `type` (defaults to `"chat"`; set it on `image`, `video`, `embedding`, `reranking`, `decision`, `transcription`, `speech`, `realtime` models), `license`, `links`, `weights`, `benchmarks`.

- There is no `attachment` field. It is derived from whether `modalities.input` has anything besides text.
- Use MIME types where the lab documents them (`image/png`, `application/pdf`) instead of generic `image` / `pdf`.
- Reasoning controls, `structured_output`, cache, and service tiers never go in lab files; they are per host.

### Provider model file

```toml
schema = 2
base_model = "anthropic/claude-opus-5-5"

[capabilities]
reasoning = { supported = true, effort = ["low", "medium", "high", "xhigh", "max"] }
structured_output = true
system_updates = true
effort_updates = true
cache = { supported = true, implicit = false, explicit = { ttl = ["5m", "1h"], max_breakpoints = 4, targets = ["tools", "system", "messages"], min_tokens = 512 } }
service_tier = ["fast"]

[cost.text.input]
price = 4
cache = { read = 0.2, write = { "5m" = 5, "1h" = 8 } }

[cost.text.output]
price = 20

[[cost.multipliers]]
when = { service_tier = { equals = "fast" } }
factor = 2

[experimental.modes.fast]
body = { speed = "fast" }
```

- Mid-conversation flags record what the API accepts (per its docs, confirmed live), not whether the model obeys: `system_updates` (system/developer messages after the conversation starts, sent in place), `effort_updates` (a per-turn effort change that keeps the cache, e.g. OpenAI `configuration_update`, Anthropic per-message `output_config`), `tools.updates` (adding/removing tools mid-conversation while keeping the cache, e.g. Anthropic `tool_addition`/`tool_removal`, OpenAI Responses `additional_tools`). Tool search is `tools.search`.
- A mode without a cost takes the base prices times the multiplier for its service tier: the mode's `service_tier`, or its name when unset (OpenAI's `fast` mode sets `service_tier = "priority"`).
- Models v1 shouldn't publish (e.g. realtime, audio, transcription and speech models) set `v2_only = true` in their lab and provider files. v1 output leaves them out; v2-only labs still work as `base_model`.

### APIs (`[api.<protocol>]`)

A model's `[api.<protocol>]` tables (`chat-completions`, `responses`, `messages`, …) are its complete list of APIs, in order, and replace the provider's default API. Each table can set `base_url`, `sdk = { aisdk, opencodeai }` and `compatibility.reasoning_field` / `replay_reasoning`; anything left out comes from the provider (`base_url` from `api` or the SDK's default URL, `sdk.aisdk` from `npm`, `sdk.opencodeai` from the provider's `opencodeai`, but only when the table takes the provider's `npm`: a table naming another `aisdk` must name its own `opencodeai` or gets none). v1 only reads the first table, as its `provider` and `interleaved` fields.

```toml
[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }
```

- `opencodeai` (provider.toml's top-level field, or `sdk.opencodeai`) is an `@opencode/ai` entry point: `@opencode/ai/providers/<path>` (e.g. `@opencode/ai/providers/openai/chat`), or `@opencode/ai/protocols/<name>` for APIs with no provider entry point (`openai-images`, `openai-speech`, `openai-transcription`). v1 never publishes it.
- `"none"` in `sdk.aisdk`, `sdk.opencodeai` or the provider's `opencodeai` says no package supports that API: nothing is filled in (e.g. `sdk = { aisdk = "none" }` on a decision model's `[api.systemone]`).
- `legacy_shape = "responses" | "completions"` is v1-only: it keeps a v1 `provider.shape` that repeats the SDK's default. Sync writes and keeps it; don't add it by hand.

## When to use `base_model` (blocker)

**If the provider did not create the model, the provider entry must use `base_model`.**

1. Identify the underlying lab model.
2. If `models/<lab>/<model>.toml` is missing, **add it** (a complete lab file, not a stub) under the lab that made the model, then point `base_model` at it.
3. Provider file stays override-only (see below).

### Exceptions (full inline definition allowed)

Use a full standalone provider model file (every required lab field plus provider fields, no `base_model`) only when:

- The provider **is** the lab (first-party host of its own model), **or**
- The model is **unique to that host**: private beta alias, custom/fine-tune, or something with no sensible shared lab identity elsewhere.

If you can name the lab model, it belongs in `models/` and the host uses `base_model`. Do not skip creating `models/` just because the file did not exist yet.

### Override-only provider files

After `base_model = "…"`, write **only** provider-specific fields or values that **differ** from the base. Never restate identical data.

**Do not copy from base when unchanged:** `name`, `description`, `family`, dates, `knowledge`, `open_weights`, `temperature` / `top_p` / `top_k`, matching `[modalities]` / `[limit]`, etc.

**Usually provider-authored:** `capabilities.reasoning` controls, `structured_output`, `cache`, `service_tier`, mid-conversation flags, `[cost.*]`, `status`, `[api.*]`, `experimental`, plus real deltas (smaller context, PDF-only input, different display `name`).

Optional:

```toml
base_model_omit = ["limit.input"]  # drop inherited keys after merge
```

### Merge behavior

- Plain objects (`[limit]`, `[modalities]`, `[capabilities]`, inline tables like `reasoning = { … }`) → deep-merge
- Arrays and primitives → child replaces parent
- Omitted fields → inherited from `models/`
- `base_model` / `base_model_omit` are parse-time only; they do not appear in generated JSON
- Missing `base_model` target → validation error

## Adding a provider

```
providers/<provider-id>/
  provider.toml
  logo.svg                 # required
  models/.../*.toml
```

### `provider.toml`

```toml
name = "Example"
npm = "@ai-sdk/openai-compatible"   # or the native AI SDK package
opencodeai = "@opencode/ai/providers/openai-compatible" # the host's own entry point if @opencode/ai has one
env = ["EXAMPLE_API_KEY"]
api = "https://api.example.com/v1" # required for openai-compatible
doc = "https://example.com/docs"
```

Every provider sets `opencodeai` for its default API (`npm` + `api`); the generator doesn't guess it. Use the host's own `@opencode/ai/providers/<host>` entry when there is one, else the generic one for the protocol (`openai-compatible`, `openai-compatible/responses`, `anthropic-compatible`), or `"none"`.

A v1-only alias provider (for example `azure-cognitive-services`) has a `provider.toml` with `[v1_alias] provider = "<id>"`, plus optional `env` renames for `${VAR}` templates, and no `models/` directory. Edit models in the target provider.

### Logo (blocker for new providers)

- Path: `providers/<provider-id>/logo.svg`
- Use `currentColor` for fills/strokes; no hardcoded colors, no fixed width/height
- Prefer square `viewBox` (e.g. `0 0 24 24`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <!-- paths -->
</svg>
```

### Sync modules (recommended, not a blocker)

If the provider has a rich catalog API that can populate model data or authoritatively remove models it no longer serves, add a sync module (see `sync.md`). Thin endpoints stay hand-authored. Sync patches files in place: it updates the fields it owns and keeps everything else (cache, overrides, multipliers, cache TTLs). If a patch can't reproduce the synced fields, sync leaves the file and reports a notice.

## Cost (always USD)

- **Token prices are USD per million tokens.** Never publish EUR, CNY, CHF, etc. as if they were USD. Convert and note rate/date in a **top-of-file** comment.
- Text prices live in `[cost.text.input]` (`price`, `cache = { read, write }`) and `[cost.text.output]` (`price`, `reasoning`). Audio/image/video use `[cost.audio.input]` etc.; non-token units set `unit` (`character`, `image`, `megapixel`, `second`, `minute`; priced per unit).
- Cache writes with several TTLs: `write = { "5m" = 6.25, "1h" = 10 }`. v1 only gets the first TTL listed.
- **Context-based pricing → overrides** keyed on `context`. The threshold is where that band starts; no duplicate thresholds.
- Service tiers, regions, and time-of-day pricing → `[[cost.multipliers]]`.

```toml
[cost.text.input]
price = 2.5
cache = { read = 0.25 }

[[cost.text.input.overrides]]
when = { context = { gt = 272_000 } }
price = 5
cache = { read = 0.5 }

[cost.text.output]
price = 15

[[cost.text.output.overrides]]
when = { context = { gt = 272_000 } }
price = 22.5
```

### Comments in TOML

Sync re-serializes many provider files and **drops every comment except a leading header block**. Put sources/rationale **above the first key** (before `schema = 2`). Short comments next to the reasoning controls for exact API syntax are fine when the file is not sync-owned.

## Reasoning controls

Any provider model whose resolved `capabilities.reasoning.supported` is `true` **must** author its controls for **this host’s** API in `[capabilities] reasoning = { … }`. Details: `.opencode/skills/audit-reasoning-options/SKILL.md`.

| Key | Meaning |
| --- | --- |
| `toggle = true` | Same model ID can be turned on/off via a request field |
| `effort = [...]` | Graded levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), sorted low to high |
| `budget = {}` / `budget = { min = 1_024 }` | A real reasoning-token budget field |
| `default = { type = "effort", value = "high" }` | Optional default (`toggle` / `effort` / `budget`) |
| none of the above | Always-on, no caller control |

### 1. Classify the host (not the npm package)

| Host kind | Who | How to pick controls |
| --- | --- | --- |
| **First-party lab** | Provider **is** the lab (OpenAI, Anthropic, DeepSeek, Alibaba, Google, …) | Match that lab’s real API and existing `providers/<lab>/` entries for the same generation. |
| **Multi-model relay / gateway** | Hosts many labs’ models (OpenRouter, Bedrock-as-relay, random OpenAI-compat aggregators, …) | Copy the **underlying model’s** controls from the lab’s provider entry + established same-surface peers. |

**`npm = "@ai-sdk/openai-compatible"` does not mean “gateway.”** DeepSeek and Alibaba are first-party labs that use that package with **lab-specific** fields (`thinking.type`, `enable_thinking`, `thinking_budget`, …). Classify by **who runs the API**, not by the AI SDK package name.

### 2. Baseline effort = native / peer set (not a fixed enum)

Do **not** invent a universal `low`/`medium`/`high` for every reasoner.

1. Open `providers/<lab>/models/…` for the underlying model (and 1–2 solid peers on the same kind of host).
2. Author **that** effort list (and toggle/budget if those entries have them and this host exposes the same kind of control).
3. Common cases:
   - GPT-style on relays → often `low` / `medium` / `high` (add `none` / `xhigh` only if native/peers have them)
   - DeepSeek V4 → `toggle` + `low` / `high` / `max` (no `medium`; the lab maps minimal→low and medium/xhigh→high)
   - Always-on / no control → `reasoning = { supported = true }`
4. On relays: **do not** leave controls out just because you could not re-test this host. No controls means **no caller control**, not uncertainty.
5. Never invent `budget` unless this host (or the lab API it clearly proxies) has a real **reasoning** budget field. Not `max_tokens`.

### 3. Toggle

Same model ID, on and off, via a known request field. Separate `-thinking` / instruct IDs are not a toggle.

| Host control | Author |
| --- | --- |
| Effort includes `none` **and** other graded levels | **Only** `effort` with `none`; **no** `toggle` |
| Separate on/off control **and** graded effort (no `none` in effort) | `toggle = true` **+** `effort` with the **actual** levels |
| Binary on/off only | `toggle = true` alone |

Every `toggle` needs a **leading top-of-file comment** with the exact wire path (sync strips mid-file comments).

```toml
# Toggle: thinking.type = enabled|disabled
# Effort: reasoning_effort = low|high|max
schema = 2
base_model = "deepseek/deepseek-v4-pro-0813"

[capabilities]
reasoning = { supported = true, toggle = true, effort = ["low", "high", "max"] }
```

```toml
# Toggle: enable_thinking true|false
# Budget: thinking_budget (integer reasoning tokens)
schema = 2
base_model = "alibaba/qwen3.5-plus"

[capabilities]
reasoning = { supported = true, toggle = true, budget = {} }
```

```toml
# Off is effort=none; graded levels, no toggle
schema = 2
base_model = "openai/gpt-5.4"

[capabilities]
reasoning = { supported = true, effort = ["none", "low", "medium", "high", "xhigh"] }
```

## Platform naming quirks

### Bedrock

- Dated: `-v1:0` suffix (`anthropic.claude-3-5-sonnet-20241022-v1:0.toml`)
- Latest/undated: bare `-v1` (`anthropic.claude-opus-4-6-v1.toml`)
- Region prefixes: `us.`, `eu.`, `global.` (default has no prefix)

### Vertex AI

- Dated: `@YYYYMMDD` (`claude-opus-4-5@20251101.toml`)
- Latest/undated: `@default` (`claude-opus-4-6@default.toml`)

## Review checklist

### Blockers

- [ ] Every model file is v2 (`schema = 2`)
- [ ] New provider has compliant `logo.svg`
- [ ] Non-lab hosts use `base_model`; missing lab metadata was **added** under `models/` when needed (complete lab file, not a stub)
- [ ] Provider `base_model` files are override-only (no duplicated identical fields; no provider-only keys like reasoning controls, cache or cost in `models/`)
- [ ] Reasoning models have host-specific `capabilities.reasoning` controls per policy above
- [ ] Costs are USD
- [ ] `bun validate` passes; `bun run v1:check` changes are intended and listed

### Strongly recommended

- [ ] PR body cites pricing/docs/API for data changes
- [ ] Sync module if the provider catalog is rich enough (`sync.md`)
- [ ] Leading TOML comment for sources on hand-authored files
