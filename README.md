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

### Adding Model Metadata

Model-only facts live in `models/`, using the same path-style IDs as provider models. For example, `models/openai/gpt-5.toml` defines metadata for the underlying GPT-5 model, while `providers/openai/models/gpt-5.toml` defines OpenAI-specific serving details such as pricing.

Use model metadata for provider-agnostic facts:

- `name`, `family`, `release_date`, `last_updated`, `knowledge`
- `attachment`, `reasoning`, `tool_call`, `structured_output`, `temperature`
- `[limit]` defaults like context, input, and output token limits
- `[modalities]` defaults
- `open_weights`, `license`, `links`, `weights`, and `benchmarks`

Example:

```toml
name = "GPT-5"
family = "gpt"
release_date = "2025-08-07"
last_updated = "2025-08-07"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true
open_weights = false

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]

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

Provider TOMLs can inherit these facts with `base_model` and then keep only provider-specific fields or overrides:

```toml
base_model = "openai/gpt-5"

[cost]
input = 1.25
output = 10.00
cache_read = 0.125

[limit]
context = 200_000 # optional provider override
output = 32_000
```

Provider fields win over model metadata during generation. Use this when the underlying model is the same but a provider serves it with different context limits, modalities, features, or pricing.

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

#### 2. Add a Logo (optional)

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

Create a new TOML file in the provider's `models/` directory where the filename is the model ID.

If the model ID contains `/`, use subfolders. For example, for the model ID `openai/gpt-5`, create a folder `openai/` and place a file named `gpt-5.toml` inside it.

```toml
name = "Model Display Name"
attachment = true           # or false - supports file attachments
reasoning = false           # or true - supports reasoning / chain-of-thought
tool_call = true            # or false - supports tool calling
structured_output = true    # or false - supports a dedicated structured output feature
temperature = true          # or false - supports temperature control
knowledge = "2024-04"       # Knowledge-cutoff date
release_date = "2025-02-19" # First public release date
last_updated = "2025-02-19" # Most recent update date
open_weights = true         # or false  - model’s trained weights are publicly available

[cost]
input = 3.00                # Cost per million input tokens (USD)
output = 15.00              # Cost per million output tokens (USD)
reasoning = 15.00           # Cost per million reasoning tokens (USD)
cache_read = 0.30           # Cost per million cached read tokens (USD)
cache_write = 3.75          # Cost per million cached write tokens (USD)
input_audio = 1.00          # Cost per million audio input tokens (USD)
output_audio = 10.00        # Cost per million audio output tokens (USD)

[limit]
context = 400_000           # Maximum context window (tokens)
input = 272_000             # Maximum input tokens
output = 8_192              # Maximum output tokens

[modalities]
input = ["text", "image"]   # Supported input modalities
output = ["text"]           # Supported output modalities

[interleaved]
field = "reasoning_content" # Name of the interleaved field "reasoning_content" or "reasoning_details"
```

#### 3a. Reuse Model Metadata with `base_model`

For wrapper providers that mirror an existing model, prefer referencing the model-only metadata instead of duplicating provider-agnostic fields.

Use `base_model` when the provider serves the same underlying model and only provider-specific fields differ.

```toml
base_model = "anthropic/claude-opus-4-6"

[cost]
input = 5.00
output = 25.00
```

Rules:

- `base_model` must point to a TOML file in `models/` using `<provider>/<model-id>`.
- You can override any top-level model field locally.
- If you override a nested table like `[cost]`, `[limit]`, or `[modalities]`, include the full values needed for that table.
- `base_model_omit` is optional and removes inherited model metadata fields after local overrides are merged. Use dot-path strings, for example `base_model_omit = ["limit.input"]`.
- `id` still comes from the filename; do not add it to the TOML.

Use `base_model` when the wrapper model is materially the same as the source model and only differs by provider-specific pricing, limits, modalities, provider request shape, or lifecycle flags.

Sync and generator scripts should preserve existing `base_model` / `base_model_omit` fields when updating provider TOMLs. Do not use legacy `[extends]` tables.

#### 4. Submit a Pull Request

1. Fork this repo
2. Create a new branch with your changes
3. Add your provider and/or model files
4. Open a PR with a clear description

### Validation

There's a GitHub Action that will automatically validate your submission against our schema to ensure:

- All required fields are present
- Data types are correct
- Values are within acceptable ranges
- TOML syntax is valid

When moving existing provider fields into model metadata, compare generated output before and after the change:

```bash
bun run compare:migrations
```

This prints a diff for each changed model TOML so you can confirm the generated JSON only changed where you intended.

### Schema Reference

Models must conform to the following schema, as defined in `packages/core/src/schema.ts`.

**Provider Schema:**

- `name`: String - Display name of the provider
- `npm`: String - AI SDK Package name
- `env`: String[] - Environment variable keys used for auth
- `doc`: String - Link to the provider's documentation
- `api` _(optional)_: String - OpenAI-compatible API endpoint. Required only when using `@ai-sdk/openai-compatible` as the npm package

**Model Schema:**

- `name`: String — Display name of the model
- `attachment`: Boolean — Supports file attachments
- `reasoning`: Boolean — Supports reasoning / chain-of-thought
- `tool_call`: Boolean - Supports tool calling
- `structured_output` _(optional)_: Boolean — Supports structured output feature
- `temperature` _(optional)_: Boolean — Supports temperature control
- `knowledge` _(optional)_: String — Knowledge-cutoff date in `YYYY-MM` or `YYYY-MM-DD` format
- `release_date`: String — First public release date in `YYYY-MM` or `YYYY-MM-DD`
- `last_updated`: String — Most recent update date in `YYYY-MM` or `YYYY-MM-DD`
- `open_weights`: Boolean - Indicate the model's trained weights are publicly available
- `interleaved` _(optional)_: Boolean or Object — Supports interleaved reasoning. Use `true` for general support or an object with `field` to specify the format
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
