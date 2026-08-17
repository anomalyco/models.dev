# Cloudflare AI Gateway Provider

Cloudflare AI Gateway is a unified proxy that relays models from many labs (Anthropic,
OpenAI, Workers AI, and more) through a single OpenAI-compatible endpoint. This provider's
model files are generated from Cloudflare's canonical catalog and a small human-curated
overrides file.

## How it works

One command regenerates every model TOML:

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx bun run cloudflare-ai-gateway:generate
```

It reads two authoritative Cloudflare sources and one local overrides file:

- **Proxied catalog** — `GET /accounts/{id}/ai/catalog/models`. The source of truth for
  proxied models: one canonical (dotted) `model_id` per model, plus pricing. This is why
  ids look like `anthropic/claude-haiku-4.5`, not `claude-haiku-4-5`.
- **Hosted models** — `GET /accounts/{id}/ai/models/search`. The native `@cf/*` Workers AI
  models, with pricing under `properties[].price`.
- **`overrides.toml`** — the only hand-authored file. Each entry maps a catalog id to a
  `base_model` and carries anything the catalog can't express.

The generator emits override-only `base_model` stubs (see the repo `AGENTS.md`): the lab
metadata lives under `models/<lab>/`, and each provider file only records real deltas.

### `--check`

```bash
bun run cloudflare-ai-gateway:generate --check
```

Exits non-zero if the committed TOMLs are out of date with the catalog + overrides. Useful
in CI.

### Offline / fixtures

Set `CF_AIG_FIXTURE_DIR` to a directory of cached `catalog*.json` / `hosted*.json` API
responses to run without network access (used in tests).

## overrides.toml

```toml
# ids we intentionally don't publish yet (must cover every catalog Text-Generation model
# that has no [models] entry, or the generator hard-fails)
skip = ["google/gemini-3.1-pro", "xai/grok-4.6", ...]

[models."anthropic/claude-haiku-4.5"]
base_model = "anthropic/claude-haiku-4-5"   # required; must resolve under models/
cost_source = "catalog"                      # pull pricing from ai/catalog/models each run
structured_output = true
reasoning_options = [{ type = "budget_tokens", min = 1024 }]

[models."workers-ai/@cf/qwen/qwq-32b"]
base_model = "alibaba/qwq-32b"
cost_source = "manual"                        # keep the cost below (hosted/hand-tuned)
name = "Qwq 32B"
structured_output = false
reasoning_options = []
cost = { input = 0.66, output = 1 }
limit = { context = 24000, output = 24000 }
```

### `cost_source`

- `catalog` — pricing is pulled from `ai/catalog/models` on every run. Use for proxied
  models whose full price the catalog supplies (most Anthropic/OpenAI text models).
- `manual` — the `cost` in the override is kept verbatim. Use for Workers AI (`@cf/*`)
  models (priced via the hosted feed), tiered pricing, and any lab/deprecated rate the
  proxied catalog doesn't express.

### Adding a model

1. Confirm it appears in `ai/catalog/models` (proxied) or `ai/models/search` (hosted).
2. If missing, add the lab metadata under `models/<lab>/<model>.toml`.
3. Add a `[models."<id>"]` entry and remove the id from `skip`.
4. Run the generator; `bun validate` must pass.

## Fields the generator preserves

`base_model`, `name`, `description`, `release_date`, `last_updated`, `status`,
`structured_output`, `temperature`, `tool_call`, `attachment`, `reasoning_options`,
`interleaved`, `limit`, `modalities`, `provider`, and (for `cost_source = "manual"`)
`cost`.

Everything else — `family`, capability booleans, knowledge cutoff, and matching
limits/modalities — is inherited from the `base_model` and should not be restated here.

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

- Leading source-citation comments on hand-authored files are not yet preserved through
  regeneration. Modeling these as a structured `notes` field in `overrides.toml` is a
  planned follow-up.
