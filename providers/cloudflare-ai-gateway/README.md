# Cloudflare AI Gateway Provider

Cloudflare AI Gateway relays third-party labs (Anthropic, OpenAI, Google, xAI, Alibaba,
DeepSeek, Moonshot, …) through a single endpoint. This provider's model files are **derived**
from Cloudflare's own live catalog, with human curation reduced to the few things the catalog
can't express.

**Scope: proxied third-party models only.** Cloudflare's own Workers AI (`@cf/...`) models are
a different pathway — hosted on Cloudflare, CF-token auth, per-model agreements — and live in
their own provider, [`cloudflare-workers-ai`](../cloudflare-workers-ai/). They are deliberately
not mirrored here.

## How it works

One command regenerates every model TOML:

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx bun run cloudflare-ai-gateway:generate
```

It reads two live Cloudflare sources plus one local curation file:

- **Proxied catalog** — `GET /accounts/{id}/ai/catalog/models`. The source of truth: one
  canonical (dotted) `model_id` per model, description, context/output limits, and pricing.
  This is why ids look like `anthropic/claude-haiku-4.5`, not `claude-haiku-4-5`.
- **Per-model catalog schema** — `GET /accounts/{id}/ai/catalog/models/{id}/schema`. Used to
  derive `reasoning_options` for providers whose schema is OpenAI-compatible (xAI, Alibaba,
  OpenAI). Native-format providers (Google, Anthropic, DeepSeek, Moonshot) don't expose the
  knob here — those fall back to curation (see below).

Everything the generator can read is derived: `cost`, `limit.context`, and `reasoning_options`.
`name` and `description` are intentionally **not** written — they inherit from `base_model`
(models.dev's canonical copy), since the catalog only carries Cloudflare's own casing and
marketing copy. Anthropic/OpenAI also get a `[provider] npm` pointing at their native SDK so
consumers route to the Messages/Responses endpoint rather than the generic compat transform.

The generator emits override-only `base_model` stubs (see the repo `AGENTS.md`): the lab
metadata lives under `models/<lab>/`, and each provider file only records real deltas.

### `--check`

```bash
bun run cloudflare-ai-gateway:generate --check
```

Exits non-zero if the committed TOMLs are out of date with the live catalog + curation.
Used in CI.

### Offline / fixtures

Set `CF_AIG_FIXTURE_DIR` to a directory of cached responses to run without network access
(used in tests). It expects:

- `catalog_*.json` — paginated `ai/catalog/models` responses
- `schema/<provider>_<model>.json` — one per-model catalog schema response

## curation.toml

The only hand-authored file. It holds what the catalog cannot express, or where a live
quality judgement overrides what a schema merely advertises:

```toml
# Catalog Text-Generation ids we intentionally don't publish: no lab file to map to, or
# not reachable via unified billing (BYOK-only).
skip = ["google/gemini-3.1-pro", "thinkingmachines/inkling", ...]

# reasoning_options for native-format providers whose shape the catalog schema doesn't expose.
[models."alibaba/qwen3.7-plus"]
note = ["Toggle: enable_thinking true|false.", "Budget: thinking_budget (integer)."]
reasoning_options = [{ type = "toggle" }, { type = "budget_tokens" }]

# structured_output is a live-tested judgement, not a schema claim.
[models."anthropic/claude-sonnet-4.5"]
structured_output = true
limit = { context = 1000000 }
reasoning_options = [{ type = "budget_tokens", min = 1024 }]
```

### What belongs in curation vs. what's derived

| Field | Source |
| --- | --- |
| `cost`, `limit.context` | derived (catalog) |
| `name`, `description`, `tool_call`, `attachment` | inherited from `base_model` (never written) |
| `base_model` | auto-resolved from `model_id`; curated only when the file name differs |
| `reasoning_options` | derived from the per-model `schema.input`; curated for native-format providers and always-on reasoners |
| `structured_output` | curated — a live-tested judgement (schema acceptance ≠ conformance) |
| `[provider] npm` | derived — `@ai-sdk/anthropic` / `@ai-sdk/openai` for the native-passthrough families |

`reasoning_options` is only written when the `base_model` declares `reasoning = true`; the
schema forbids it otherwise. When a reasoning model has no derivable and no curated shape,
the generator hard-fails rather than ship an invalid file.

### Adding a model

1. Confirm it appears in `ai/catalog/models`.
2. If its canonical lab metadata is missing, add it under `models/<lab>/<model>.toml`.
3. For a model with a matching lab file, nothing more is needed — the generator auto-resolves
   `base_model`. Add a `skip` entry instead if there's no lab file to map to, or if the model
   isn't reachable via unified billing.
4. If it's a reasoning model whose knob the schema doesn't expose, add `reasoning_options`.
5. Run the generator; `bun validate` must pass.

## Provider configuration

`provider.toml` defines how models.dev connects to the gateway:

```toml
name = "Cloudflare AI Gateway"
env = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]
npm = "ai-gateway-provider"
doc = "https://developers.cloudflare.com/ai-gateway/"
```

It is hand-authored and not touched by the generator.

## Known limitations

- `reasoning_options` for native-format providers (Google, Anthropic, DeepSeek, Moonshot)
  can't be derived from Cloudflare's schema and must be curated. New reasoning models from
  these providers hard-fail until their knob is added to `curation.toml`.
- `structured_output` requires a live conformance test when adding a model; the schema
  advertises `response_format` even for models that don't honour it.
