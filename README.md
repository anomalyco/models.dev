<p align="center">
  <a href="https://models.dev">
    <picture>
      <source srcset="./logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="./logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="./logo-light.svg" alt="Models.dev logo">
    </picture>
  </a>
</p>

---

[Models.dev](https://models.dev) is a comprehensive open-source database of AI model specifications, pricing, and capabilities.

There's no single database with information about all the available AI models. We started Models.dev as a community-contributed project to address this. We also use it internally in [opencode](https://opencode.ai).

## API

You can access this data through an API.

```bash
curl https://models.dev/api.json
```

Specialized model types are omitted by default. Filter by one or more
comma-separated model types, or use `all` for the complete catalog:

```bash
curl "https://models.dev/api.json?type=decision"
curl "https://models.dev/api.json?type=all"
```

The currently supported model type is `decision`. The `type` parameter is also
available on `models.json`, `catalog.json`, and `model-schema.json`.

Use the **Model ID** field to do a lookup on any model; it's the identifier used by [AI SDK](https://ai-sdk.dev/).

Provider-agnostic model metadata is available separately:

```bash
curl https://models.dev/models.json
```

Use this for facts about the model itself, independent of where it is served. If you need both provider endpoints and model-only metadata in one response:

```bash
curl https://models.dev/catalog.json
```

### Logos

Provider logos are available as SVG files:

```bash
curl https://models.dev/logos/{provider}.svg
```

Replace `{provider}` with the **Provider ID** (e.g., `anthropic`, `openai`, `google`). If we don't have a provider's logo, a default logo is served instead.

## Contributing

The data is stored in the repo as TOML files; organized by provider and model. The logo is stored as an SVG. This is used to generate this page and power the API.

We need your help keeping the data up to date.

### File Format

Every model file uses the v2 format and starts with `schema = 2`; `bun validate` rejects files without it. The full file schema is in `packages/core/src/schema-v2.ts`, and `AGENTS.md` has the complete contributor rules. The filename (minus `.toml`) is the model ID; never add an `id` field.

### Adding Model Metadata

Model-only facts live in `models/<lab>/<model>.toml`. For example, `models/openai/gpt-5.toml` describes the underlying GPT-5 model, while `providers/openai/models/gpt-5.toml` describes how OpenAI serves it (reasoning controls, cache, pricing).

Lab files hold only what is true on every host:

```toml
schema = 2
name = "GPT-5"
description = "Original GPT-5 workhorse for reasoning, coding, writing, and tool workflows"
family = "gpt"
open_weights = false
knowledge = "2024-09-30"
release_date = "2025-08-07"

[modalities]
input = ["text", "image/jpeg", "image/png", "image/gif", "image/webp"]
output = ["text"]

[capabilities]
tools = { supported = true }
reasoning = { supported = true }
temperature = false
top_p = false
top_k = false

[limit]
context = 400_000
input = 272_000
output = 128_000

[[benchmarks]]
name = "Benchmark Name"
score = 72.5
metric = "accuracy"
source = "https://example.com/results"

[[weights]]
label = "Model weights"
url = "https://huggingface.co/example/model"
format = "safetensors"
```

Use MIME types for modalities where the lab documents them. `last_updated` is only needed when it differs from `release_date`. Reasoning controls, `structured_output`, cache, and service tiers are per host and go in provider files.

### Adding a New Provider Model

To add a new model, start by checking if the provider already exists in the `providers/` directory. If not, then:

#### 1. Create a Provider

If the provider isn't already in `providers/`:

1. Create a new folder in `providers/` with the provider's ID. For example, `providers/newprovider/`.
2. Add a `provider.toml` with the provider details:

   ```toml
   name = "Provider Name"
   npm = "@ai-sdk/provider" # AI SDK Package name
   env = ["PROVIDER_API_KEY"] # Environment Variable keys used for auth
   doc = "https://example.com/docs/models" # Link to provider's documentation
   ```

   If the provider doesn’t publish an npm package but exposes an OpenAI-compatible endpoint, set the npm field accordingly and include the base URL:

   ```toml
   npm = "@ai-sdk/openai-compatible" # Use OpenAI-compatible SDK
   api = "https://api.example.com/v1" # Required with openai-compatible
   ```

#### 2. Add a Logo (required for new providers)

To add a logo for the provider:

1. Add a `logo.svg` file to the provider's directory (e.g., `providers/newprovider/logo.svg`)
2. Use SVG format with no fixed size or colors - use `currentColor` for fills/strokes

Example SVG structure:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <!-- Logo paths here -->
</svg>
```

#### 3. Add a Model Definition

Create a new TOML file in the provider's `models/` directory where the filename is the model ID. If the model ID contains `/`, use subfolders: for `openai/gpt-5`, create `openai/gpt-5.toml`.

If the provider didn't create the model, point `base_model` at the lab file (add the lab file first if it's missing) and write only what differs on this host:

```toml
schema = 2
base_model = "openai/gpt-5"

[capabilities]
reasoning = { supported = true, effort = ["minimal", "low", "medium", "high"] }
structured_output = true
cache = { implicit = { min_tokens = 1_024 } }

[cost.text.input]
price = 1.25              # USD per million input tokens
cache = { read = 0.125 }  # USD per million cached input tokens

[[cost.text.input.overrides]]
when = { context = { gt = 272_000 } } # long-context pricing
price = 2.5

[cost.text.output]
price = 10                # USD per million output tokens

[limit]
context = 200_000         # optional: only when this host serves a smaller window
```

Rules:

- `base_model` must point to a file in `models/` using `<lab>/<model-id>`.
- **Override-only:** do not restate the base's `name`, `description`, dates, `modalities`, `limit`, etc. unless this host actually differs.
- Plain tables (`[limit]`, `[modalities]`, `[capabilities]`, inline tables) deep-merge; arrays and primitives replace.
- `base_model_omit` removes inherited fields after merging, e.g. `base_model_omit = ["limit.input"]`.
- Lifecycle goes in `status` (`alpha`, `beta`, `deprecated`). A model served through a different SDK, base URL, or reasoning field gets an `[api.<protocol>]` table, e.g. `[api.chat-completions] compatibility = { reasoning_field = "reasoning_content" }`.
- A full definition without `base_model` is only for first-party labs and host-unique models. It has every lab field plus the provider fields.

**Reasoning controls (short):** classify first-party lab vs multi-model relay (not by npm). Copy the underlying model’s controls from the lab's provider entry and same-surface peers: often `effort = ["low", "medium", "high"]` on GPT-style relays, but DeepSeek V4 is `toggle = true` with `effort = ["low", "high", "max"]`, etc. Don't drop controls from uncertainty on relays. Full policy: `AGENTS.md`.

#### 4. Submit a Pull Request

1. Fork this repo
2. Create a new branch with your changes
3. Add your provider and/or model files
4. Open a PR with a clear description

### Validation

Run these before opening a PR (a GitHub Action runs them too):

```bash
bun validate      # schema, required fields, TOML syntax; rejects non-v2 model files
bun run v1:check  # lists any change to the published v1 API output
```

### API Reference

These are the fields of each model in the generated `api.json` (the v1 API). They are API response fields, not file fields: they are derived from the v2 files above (for example `attachment` comes from non-text input modalities, `reasoning_options` from `capabilities.reasoning`, and `cost.input` from `cost.text.input.price`).

Generated provider models that use `base_model` expose its canonical lab/model ID as `canonical_model_id` in `api.json` and `catalog.json`. Consumers can use this field to attribute a provider-specific model ID to its originating lab without guessing from the model name.

**Provider:**

- `name`: String - Display name of the provider
- `npm`: String - AI SDK Package name
- `env`: String[] - Environment variable keys used for auth
- `doc`: String - Link to the provider's documentation
- `api` _(optional)_: String - OpenAI-compatible API endpoint

**Model:**

- `name`: String — Display name of the model
- `type` _(optional)_: String — Specialized model behavior; currently supports `decision`
- `attachment`: Boolean — Supports file attachments
- `reasoning`: Boolean — Supports reasoning / chain-of-thought
- `tool_call`: Boolean - Supports tool calling
- `structured_output` _(optional)_: Boolean — Supports structured output feature
- `temperature` _(optional)_: Boolean — Supports temperature control
- `knowledge` _(optional)_: String — Knowledge-cutoff date in `YYYY-MM` or `YYYY-MM-DD` format
- `release_date`: String — First public release date in `YYYY-MM` or `YYYY-MM-DD`
- `last_updated`: String — Most recent update date in `YYYY-MM` or `YYYY-MM-DD`
- `open_weights`: Boolean - Indicate the model's trained weights are publicly available
- `interleaved` _(optional)_: Boolean or Object — Supports interleaved reasoning: `true`, or an object whose `field` names the format
- `interleaved.field`: String — Name of the interleaved field (`"reasoning_content"` or `"reasoning_details"`)
- `cost.input`: Number — Cost per million input tokens (USD)
- `cost.output`: Number — Cost per million output tokens (USD)
- `cost.reasoning` _(optional)_: Number — Cost per million reasoning tokens (USD)
- `cost.cache_read` _(optional)_: Number — Cost per million cached read tokens (USD)
- `cost.cache_write` _(optional)_: Number — Cost per million cached write tokens (USD)
- `cost.input_audio` _(optional)_: Number — Cost per million audio input tokens, if billed separately (USD)
- `cost.output_audio` _(optional)_: Number — Cost per million audio output tokens, if billed separately (USD)
- `limit.context`: Number — Maximum context window (tokens)
- `limit.input`: Number — Maximum input tokens
- `limit.output`: Number — Maximum output tokens
- `modalities.input`: Array of strings — Supported input modalities (e.g., ["text", "image", "audio", "video", "pdf"])
- `modalities.output`: Array of strings — Supported output modalities (e.g., ["text"])
- `status` _(optional)_: String — Supported status:
  - `alpha` - Indicate the model is in alpha testing
  - `beta` - Indicate the model is in beta testing
  - `deprecated` - Indicate the model is no longer served by the provider's public API

### Examples

See existing providers in the `providers/` directory for reference:

- `providers/anthropic/` - Anthropic Claude models
- `providers/openai/` - OpenAI GPT models
- `providers/google/` - Google Gemini models

### Working on frontend

Make sure you have [Bun](https://bun.sh/) installed.

```bash
$ bun install
$ cd packages/web
$ bun run dev
```

And it'll open the frontend at http://localhost:3000

### Manual testing with opencode

You can manually check provider changes with opencode by:

```bash
$ bun install
$ cd packages/web
$ bun run build
$ OPENCODE_MODELS_PATH="dist/_api.json" opencode
```

### Questions?

Open an issue if you need help or have questions about contributing.

---

Models.dev is created by the maintainers of [SST](https://sst.dev).

**Join our community** [Discord](https://sst.dev/discord) | [YouTube](https://www.youtube.com/c/sst-dev) | [X.com](https://x.com/SST_dev)
