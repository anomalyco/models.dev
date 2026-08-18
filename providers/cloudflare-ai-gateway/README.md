# Cloudflare AI Gateway Provider

Cloudflare AI Gateway is a unified proxy that relays models from many labs (Anthropic,
OpenAI, Workers AI, and more) through a single OpenAI-compatible endpoint. This provider's
model files are **derived** from Cloudflare's own live sources, with human curation reduced
to the few things those sources can't express.

## How it works

One command regenerates every model TOML:

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx bun run cloudflare-ai-gateway:generate
```

It reads three live Cloudflare sources plus one local curation file:

- **Proxied catalog** — `GET /accounts/{id}/ai/catalog/models`. The source of truth for
  proxied models: one canonical (dotted) `model_id` per model, description, context/output
  limits, and pricing (flat or context-tiered). This is why ids look like
  `anthropic/claude-haiku-4.5`, not `claude-haiku-4-5`.
- **Per-model catalog schema** — `GET /accounts/{id}/ai/catalog/models/{id}/schema`. Used to
  derive proxied `reasoning_options` for providers whose schema is OpenAI-compatible (xAI,
  Alibaba, OpenAI). Native-format providers (Google, Anthropic, DeepSeek, Moonshot) don't
  expose the knob here — those fall back to curation (see below).
- **Hosted `@cf` set** — `GET /accounts/{id}/ai/models/search` enumerates which native
  Workers AI Text-Generation models exist. The per-model detail comes from the
  cloudflare-docs `workers-ai-models/<model>.json` files, which carry `function_calling`,
  `vision`, `price`, `context_window`, and a `schema.input` from which hosted
  `reasoning_options` are derived.

Everything the generator can read from those sources is derived: `cost` (flat, tiered, and
cache-read), `limit`, `tool_call`, `attachment`, and `reasoning_options`. `name` and
`description` are intentionally **not** written — they inherit from `base_model` (models.dev's
canonical copy), since the catalog only carries Cloudflare's own casing and marketing copy.

The generator emits override-only `base_model` stubs (see the repo `AGENTS.md`): the lab
metadata lives under `models/<lab>/`, and each provider file only records real deltas.

### `--check`

```bash
bun run cloudflare-ai-gateway:generate --check
```

Exits non-zero if the committed TOMLs are out of date with the live sources + curation.
Used in CI.

### Offline / fixtures

Set `CF_AIG_FIXTURE_DIR` to a directory of cached responses to run without network access
(used in tests). It expects:

- `catalog_*.json` — paginated `ai/catalog/models` responses
- `hosted_*.json` — `ai/models/search` responses
- `docs/<model>.json` — one cloudflare-docs file per hosted `@cf` model
- `schema/<provider>_<model>.json` — one per-model catalog schema response

## curation.toml

The only hand-authored file. It holds what the live sources cannot express or where a live
quality judgement overrides what a schema merely advertises:

```toml
# Catalog Text-Generation ids we intentionally don't publish (e.g. no lab file to map to).
skip = ["google/gemini-3.1-pro", "minimax/m3", ...]

# Hosted @cf models: base_model is required (the docs feed has no dotted lab id).
[models."workers-ai/@cf/openai/gpt-oss-20b"]
base_model = "openai/gpt-oss-20b"

# structured_output is a live-tested judgement, not a schema claim. Cloudflare advertises
# response_format broadly, but some hosted deployments don't honour it.
[models."workers-ai/@cf/qwen/qwq-32b"]
base_model = "alibaba/qwq-32b"
structured_output = false
reasoning_options = []            # always-on reasoner with no user-facing knob

# Proxied reasoning models whose reasoning shape the catalog schema doesn't expose.
[models."google/gemini-2.5-pro"]
reasoning_options = [{ type = "budget_tokens", min = 128, max = 32_768 }]
```

### What belongs in curation vs. what's derived

| Field | Source |
| --- | --- |
| `cost`, `limit`, `tool_call`, `attachment` | derived (catalog / docs) |
| `name`, `description` | inherited from `base_model` (never written) |
| hosted `base_model` | curated (docs feed has no dotted id) |
| proxied `base_model` | auto-resolved from `model_id`; curated only when it differs |
| `reasoning_options` | derived from the per-model / docs `schema.input`; curated for native-format providers and always-on reasoners |
| `structured_output` | curated — a live-tested judgement (schema acceptance ≠ conformance) |

`reasoning_options` is only written when the `base_model` declares `reasoning = true`; the
schema forbids it otherwise. When a reasoning model has no derivable and no curated shape,
the generator hard-fails rather than ship an invalid file.

### Adding a model

1. Confirm it appears in `ai/catalog/models` (proxied) or `ai/models/search` (hosted).
2. If missing, add the lab metadata under `models/<lab>/<model>.toml`.
3. For proxied models with a matching lab file, nothing more is needed — the generator
   auto-resolves the `base_model`. For hosted `@cf` models, add a `[models."<id>"]` entry
   with `base_model`. Add a `skip` entry instead if there's no lab file to map to.
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

- Proxied `reasoning_options` for native-format providers (Google, Anthropic, DeepSeek,
  Moonshot) can't be derived from Cloudflare's schema and must be curated. New reasoning
  models from these providers hard-fail until their knob is added to `curation.toml`.
- `structured_output` requires a live conformance test when adding a hosted model; the docs
  schema advertises `response_format` even for models that don't honour it.
</content>
</invoke>
