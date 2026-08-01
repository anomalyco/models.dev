# Agent Guidelines for models.dev

Catalog-only. This file is how to add and maintain **models** and **providers**. Nothing else.

## Validate

```bash
bun validate
```

Run this after every catalog change. It must pass before a PR is mergeable.

## Two concepts: lab models vs providers

| | Lab model metadata | Provider model |
| --- | --- | --- |
| **What** | Provider-agnostic facts about a model the lab built | How a specific API host serves that model |
| **Where** | `models/<lab-id>/<model-id>.toml` | `providers/<provider-id>/models/.../<id>.toml` |
| **Examples** | `models/anthropic/claude-opus-4-6.toml`, `models/openai/gpt-5.4.toml` | `providers/openrouter/models/anthropic/claude-opus-4-6.toml` |
| **Contains** | name, description, capabilities, modalities, limits, weights, … | `cost`, `reasoning_options`, `status`, request shape, and **only real overrides** |

- **Labs** create models (Anthropic, OpenAI, Google, DeepSeek, Alibaba, …).
- **Providers** host or relay them (the lab’s own API, OpenRouter, Bedrock, a random OpenAI-compatible gateway, …).

Filename (minus `.toml`) is the model `id`. **Never** put an `id` field in the TOML. Schema is strict — unknown keys fail validation.

## When to use `base_model` (blocker)

**If the provider did not create the model, the provider entry must use `base_model`.**

1. Identify the underlying lab model.
2. If `models/<lab>/<model>.toml` is missing, **add it** under the lab that made the model, then point `base_model` at it.
3. Provider file stays override-only (see below).

```toml
base_model = "anthropic/claude-opus-4-6"

[cost]
input = 5.00
output = 25.00
```

### Exceptions (full inline definition allowed)

Use a full standalone provider model TOML only when:

- The provider **is** the lab (first-party host of its own model), **or**
- The model is **unique to that host** — private beta alias, custom/fine-tune, or something with no sensible shared lab identity elsewhere.

If you can name the lab model, it belongs in `models/` and the host uses `base_model`. Do not skip creating `models/` just because the file did not exist yet.

### Override-only provider files

After `base_model = "…"`, write **only** provider-specific fields or values that **differ** from the base. Never restate identical data.

**Do not copy from base when unchanged:** `name`, `description`, `family`, `release_date`, `knowledge`, `open_weights`, `attachment`, `reasoning`, `tool_call`, `temperature`, `structured_output`, matching `[modalities]` / `[limit]`, etc.

**Usually provider-authored:** `cost`, `reasoning_options`, `interleaved`, `status`, `provider`, `experimental`, plus real deltas (smaller context, PDF-only input, different display `name`).

Optional:

```toml
base_model_omit = ["limit.input"]  # drop inherited keys after merge
```

### Merge behavior

- Plain objects (`[limit]`, `[modalities]`, …) → deep-merge
- Arrays and primitives → child replaces parent
- Omitted fields → inherited from `models/`
- `base_model` / `base_model_omit` are parse-time only — they do not appear in generated JSON
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
env = ["EXAMPLE_API_KEY"]
api = "https://api.example.com/v1" # required for openai-compatible
doc = "https://example.com/docs"
```

### Logo (blocker for new providers)

- Path: `providers/<provider-id>/logo.svg`
- Use `currentColor` for fills/strokes — no hardcoded colors, no fixed width/height
- Prefer square `viewBox` (e.g. `0 0 24 24`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <!-- paths -->
</svg>
```

### Sync modules (recommended, not a blocker)

If the provider has a rich catalog API that can populate model data or authoritatively remove models it no longer serves, add a sync module (see `sync.md`). Thin endpoints stay hand-authored.

## Model fields

### Required on lab metadata (`models/`)

| Field | Notes |
| --- | --- |
| `name`, `description` | Schema-required |
| `release_date`, `last_updated` | **Required on new lab entries** (hosts inherit these) |
| `attachment`, `reasoning`, `tool_call`, `open_weights` | **Required on new lab entries** |
| `limit`, `modalities` | **Required on new lab entries** — providers must resolve `limit.context` + `limit.output` |

When you create `models/<lab>/<model>.toml` so a third-party host can `base_model` it, author a **complete** lab file (all rows above). Do not ship name/description-only lab stubs and expect an “override-only” host of just `cost` + `reasoning_options` to validate — missing inherited required fields fail `bun validate`.

### Required on resolved provider models

After `base_model` merge (or full inline), the provider model must have:

| Field | Notes |
| --- | --- |
| `name`, `description` | From base or local |
| `attachment`, `reasoning`, `tool_call`, `open_weights` | Booleans |
| `release_date`, `last_updated` | Dates |
| `modalities`, `limit` | `limit.context` + `limit.output` required on providers |
| `cost` | Provider-side (unless intentionally request-only / no public price) |
| `reasoning_options` | **Required when `reasoning = true`** |

With `base_model`, do not restate fields already correct on the lab entry. Still author `cost` and (if reasoning) `reasoning_options` on the provider file.

### Strongly recommended on lab metadata

| Field | Notes |
| --- | --- |
| `family` | Model family slug — set when known |
| `knowledge` | Knowledge cutoff (`YYYY-MM` or `YYYY-MM-DD`) |
| `temperature` | Whether temperature is respected |
| `structured_output` | Whether structured/JSON output is supported |
| `license`, `links`, `weights`, `benchmarks` | Enrichment |

### Provider-only (never put these under `models/`)

| Field | Notes |
| --- | --- |
| `cost`, `reasoning_options` | Host pricing and API controls |
| `interleaved` | Reasoning side channel on **this** API (`reasoning_content` / `reasoning_details`, or `true`) |
| `status` | Lifecycle on **this** host: `alpha` / `beta` / `deprecated` |
| `provider`, `experimental` | Request-shape overrides / experimental modes |

### Cost (always USD)

- **All `cost` values are USD per million tokens.** Never publish EUR, CNY, CHF, etc. as if they were USD.
- Convert other currencies and note rate/date in a **top-of-file** comment.
- Optional keys on cost: `reasoning`, `cache_read`, `cache_write`, `input_audio`, `output_audio`.
- **Context-based pricing → `[[cost.tiers]]`**, not `context_over_200k`.

```toml
[cost]
input = 2.50
output = 15.00

[[cost.tiers]]
tier = { type = "context", size = 200_000 }
input = 5.00
output = 22.50
```

- `cost.context_over_200k` is **legacy output-only**. Do **not** author it in TOML (schema rejects it on write). The generator may emit it for old consumers when a single 200k-style tier exists; **always author tiers**.
- Tier `size` is the context threshold where that band starts. No duplicate sizes.

### Comments in TOML

Sync re-serializes many provider files and **drops every comment except a leading header block**. Put sources/rationale **above the first key**. Short comments next to a reasoning option for exact API syntax are fine when the file is not sync-owned.

## Reasoning options

Any provider model with `reasoning = true` **must** set `reasoning_options` for **this host’s** API. Details: `.opencode/skills/audit-reasoning-options/SKILL.md`.

### 1. Classify the host (not the npm package)

| Host kind | Who | How to pick options |
| --- | --- | --- |
| **First-party lab** | Provider **is** the lab (OpenAI, Anthropic, DeepSeek, Alibaba, Google, …) | Match that lab’s real API and existing `providers/<lab>/` entries for the same generation. |
| **Multi-model relay / gateway** | Hosts many labs’ models (OpenRouter, Bedrock-as-relay, random OpenAI-compat aggregators, …) | Copy the **underlying model’s** controls from the lab entry + established same-surface peers. |

**`npm = "@ai-sdk/openai-compatible"` does not mean “gateway.”** DeepSeek and Alibaba are first-party labs that use that package with **lab-specific** fields (`thinking.type`, `enable_thinking`, `thinking_budget`, …). Classify by **who runs the API**, not by the AI SDK package name.

### 2. Baseline effort = native / peer set (not a fixed enum)

Do **not** invent a universal `low`/`medium`/`high` for every reasoner.

1. Open `providers/<lab>/models/…` for the underlying model (and 1–2 solid peers on the same kind of host).
2. Author **that** effort list (and toggle/budget if those entries have them and this host exposes the same kind of control).
3. Common cases:
   - GPT-style on relays → often `low` / `medium` / `high` (add `none` / `xhigh` only if native/peers have them)
   - DeepSeek V4 → `toggle` + `high` / `max` (not L/M/H; lab maps low/medium→high)
   - Always-on / no control → `[]`
4. On relays: **do not** use `[]` just because you could not re-test this host. Empty means **no caller control**, not uncertainty.
5. Never invent `budget_tokens` unless this host (or the lab API it clearly proxies) has a real **reasoning** budget field. Not `max_tokens`.

### 3. Toggle

Same model ID, on and off, via a known request field. Separate `-thinking` / instruct IDs are not a toggle.

| Host control | Author |
| --- | --- |
| Effort includes `none` **and** other graded levels | **Only** `effort` with `none` in `values` — **no** `toggle` |
| Separate on/off control **and** graded effort (no `none` in effort) | `toggle` **+** `effort` with the **actual** levels |
| Binary on/off only | `toggle` alone |

Every `toggle` needs a **leading top-of-file comment** with the exact wire path (sync strips mid-file comments).

```toml
# Toggle: thinking.type = enabled|disabled
# Effort: reasoning_effort = high|max
name = "DeepSeek V4 Pro"
reasoning_options = [
  { type = "toggle" },
  { type = "effort", values = ["high", "max"] },
]
```

```toml
# Toggle: enable_thinking true|false
# Budget: thinking_budget (integer reasoning tokens)
name = "Qwen3.5 Plus"
reasoning_options = [
  { type = "toggle" },
  { type = "budget_tokens" },
]
```

```toml
# Off is effort=none; graded levels — no toggle
base_model = "openai/gpt-5.4"
reasoning_options = [{ type = "effort", values = ["none", "low", "medium", "high", "xhigh"] }]
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

- [ ] New provider has compliant `logo.svg`
- [ ] Non-lab hosts use `base_model`; missing lab metadata was **added** under `models/` when needed (complete lab file, not a stub)
- [ ] Provider `base_model` files are override-only (no duplicated identical fields; no provider-only keys under `models/`)
- [ ] `reasoning = true` ⇒ `reasoning_options` set per policy above
- [ ] Costs are USD/MTok
- [ ] `bun validate` passes

### Strongly recommended

- [ ] PR body cites pricing/docs/API for data changes
- [ ] Sync module if the provider catalog is rich enough (`sync.md`)
- [ ] Leading TOML comment for sources on hand-authored files
