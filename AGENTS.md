# Agent Guidelines for models.dev

Catalog-only. This file is how to add and maintain **models** and **providers**. Nothing else.

## Validate

```bash
bun validate
bun run v1:check
```

Run both after every catalog change. `bun validate` must pass before a PR is mergeable; it rejects any model file without `schema = 2`.

`bun run v1:check` (or `bun run v1:check <ref>`) protects the published v1 API (`api.json`, etc.), which is still generated from these files. It compares the v1 output with the merge-base of `origin/dev`, lists every changed field, every model added to or removed from v1, and changed files that still use generic modalities, and exits 1 if v1 changed.

**Never break v1.** The published v1 API (`api.json` and its views) must stay backward compatible:

- **No new modalities in v1.** v1 only allows `text`, `audio`, `image`, `video` and `pdf` (`packages/core/src/schema.ts`). v2-only values (MIME types, `embedding`, `decision`, `reranking`) must translate to one of these or stay out of v1.
- **No v1 schema changes.** Don't add, remove, rename or retype v1 fields, and don't add allowed values to existing v1 enums. Those changes go in v2.
- **Data changes inside the v1 schema** (e.g. a corrected price or URL) must be clearly sourced fixes, listed in the PR, and approved by a maintainer. Run the full `bun run v1:check` and read its output.

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
cache = { explicit = { ttl = ["5m", "1h"], max_breakpoints = 4, targets = ["tools", "system", "messages"], min_tokens = 512 } }
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

- `cache = false` means the host doesn't cache prompts. Otherwise list the kinds it supports, `implicit` and/or `explicit`, each `true` or a details table. A kind that isn't listed isn't supported. If a host caches but doesn't say how, use `{ implicit = true }`; Anthropic-style caching that needs `cache_control` markers is `explicit`.
- Mid-conversation flags record what the API accepts, not whether the model obeys. Each one needs a message sent inside the conversation history; changing a top-level request parameter between turns never counts, even if the cache happens to survive.
  - `system_updates`: the API accepts a system/developer message after the conversation starts and keeps it in place (the cache before it survives; moved to the top or rejected = false).
  - `effort_updates`: a message in the history changes effort for the next turn and keeps the cache: OpenAI Responses `configuration_update`, Anthropic per-message `output_config`. Changing `reasoning_effort`, a thinking toggle or a budget on the next request doesn't count.
  - `tools.updates`: a message in the history adds (or removes) tools and keeps the cache: Anthropic `tool_addition`/`tool_removal`, OpenAI Responses `additional_tools`, Kimi K3's tool-carrying system message. Add-only counts; note "add only" in the file comment. Changing the top-level `tools` list doesn't count. Tool search is `tools.search`.
- These three flags default to false. Be conservative: set one to `true` only when the host has an explicit, documented way to do it (or passes requests through to a lab that documents it) and you're sure it works there; confirm live when you can. A server that happens to keep the cache isn't enough. Otherwise leave it out (don't write `= false`; `bun validate` rejects it). The v2 API always publishes them as `true` or `false`, with a left-out flag published as `false`.
- Put a flag at the top level only when it holds on every API the model lists. When it holds on some of them only, leave the top level out and set it on those APIs instead, e.g. `[api.messages]` with `capabilities = { effort_updates = true }` (`system_updates`, `effort_updates` and `tools = { updates = true }` are allowed there).
- A mode without a cost takes the base prices times the multiplier for its service tier: the mode's `service_tier`, or its name when unset (OpenAI's `fast` mode sets `service_tier = "priority"`).
- Web search fees go in `[cost.web_search]`: `price` is USD per 1,000 searches (or search requests, as the host bills them). Prices by search depth are `[[cost.web_search.overrides]]` with `when = { search_context_size = { equals = "high" } }`. v1 has no web search price.
- A plain-number multiplier `factor` (`factor = 1.1`) multiplies every price, `web_search` included; the object form (`factor = { text = 1.1, audio = 1.1 }`) multiplies only the prices it names, so use it when the host's multiplier covers token prices only.
- Models v1 shouldn't publish (e.g. realtime, audio, transcription and speech models) set `v2_only = true` in their lab and provider files. v1 output leaves them out; v2-only labs still work as `base_model`.

### APIs (`[api.<protocol>]`)

A model's `[api.<protocol>]` tables (`chat-completions`, `responses`, `messages`, …) are its complete list of APIs, in order, and replace the provider's default API. Each table can set `base_url`, `path`, `sdk = { aisdk, opencodeai }` and `compatibility.reasoning_field`; anything left out comes from the provider (`base_url` from `api` or the SDK's default URL, `sdk.aisdk` from `npm`, `sdk.opencodeai` from the provider's `opencodeai`, but only when the table takes the provider's `npm`: a table naming another `aisdk` must name its own `opencodeai` or gets none). v1 only reads the first table, as its `provider` and `interleaved` fields.

```toml
[api.chat-completions]
compatibility = { reasoning_field = "reasoning_content" }
```

- `opencodeai` (provider.toml's top-level field, or `sdk.opencodeai`) is an `@opencode/ai` entry point: `@opencode/ai/providers/<path>` (e.g. `@opencode/ai/providers/openai/chat`), or `@opencode/ai/protocols/<name>` for APIs with no provider entry point (`openai-images`, `openai-speech`, `openai-transcription`). v1 never publishes it.
- `"none"` in `sdk.aisdk`, `sdk.opencodeai` or the provider's `opencodeai` says no package supports that API: nothing is filled in (e.g. `sdk = { aisdk = "none" }` on a decision model's `[api.systemone]`).
- `path` is the request path appended to `base_url`, set only when a host departs from its protocol's usual path. `systemone` normally posts to `{base_url}/systemone`; Inception serves the same body at `/v1/decisions`, so its `[api.systemone]` sets `base_url = "https://api.inceptionlabs.ai/v1"` and `path = "/decisions"`. v1 never publishes it.
- `compatibility.image_input` (v2 only, `systemone` tables only) says where a System One host wants images: `"assets"` (the default: TypeSafe's `assets` map plus the `TypeSafe-Danger-Zone-Images: true` header), `"images"` (a top-level `images` list) or `"state"` (`image_url` items in a `state` list). Set it on image models whose host isn't the default. `compatibility.reasoning_field` is only allowed on `chat-completions` tables.
- `compatibility.max_tokens_field` (v2 only, `chat-completions` tables only) names the output-token cap field. Leave it out for hosts that take OpenAI's current `max_completion_tokens`; set `"max_tokens"` where the host only takes the older field (documented, or rejects/ignores `max_completion_tokens`).
- Name the protocol by its wire format, not the model type, nor the host's path. `decisions` is only OpenAI's Decisions format; every host that takes System One's `{model, state, questions}` body is `systemone`, whatever its path. `realtime` is OpenAI's Realtime API; Google's Live API is `bidi-generate-content` and Lyria RealTime is `bidi-generate-music` (after their `BidiGenerateContent` / `BidiGenerateMusic` WebSocket methods).
- `legacy_shape = "responses" | "completions"` is v1-only: it keeps a v1 `provider.shape` that repeats the SDK's default. Sync writes and keeps it; don't add it by hand.
- `legacy_interleaved = true` is v1-only: it keeps v1's bare `interleaved: true` (replaying reasoning is the default in v2). Sync writes and keeps it; don't add it by hand.

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

## Restricted models

Don't add provider entries for models that most of the host's users can't call: gated research previews and allowlist-only models (for example Claude Mythos on Anthropic's API). Clients show every provider model in their model lists, so people pick it and get an access error. Add them once the host makes them generally available.

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
- Plain drawing markup only: no scripts, event handlers, `foreignObject`, animation or links to other files (`bun validate` checks this against the allowlist in `packages/core/src/logo.ts`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <!-- paths -->
</svg>
```

### Sync modules (recommended, not a blocker)

If the provider has a rich catalog API that can populate model data or authoritatively remove models it no longer serves, add a sync module (see `sync.md`). Thin endpoints stay hand-authored. Sync patches files in place: it updates the fields it owns and keeps everything else (cache, overrides, multipliers, cache TTLs). If a patch can't reproduce the synced fields, sync leaves the file and reports a notice.

## Lab pages (`labs/<lab-id>/`)

A lab's `logo.svg` (same rules as provider logos) and optional `lab.toml` feed the website's lab pages only; neither is in the v1 or v2 API. `lab.toml` is v2 and holds just the lab's description:

```toml
schema = 2
description = "One or two sentences on what the lab builds."
```

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
- [ ] `bun validate` passes
- [ ] v1 is not broken: no new v1 modalities, fields or enum values; every `bun run v1:check` change is a sourced fix, listed in the PR and maintainer-approved

### Strongly recommended

- [ ] PR body cites pricing/docs/API for data changes
- [ ] Sync module if the provider catalog is rich enough (`sync.md`)
- [ ] Leading TOML comment for sources on hand-authored files
