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

## Contributing

The data is stored in the repo as TOML files; organized by provider and model. This is used to generate this page and power the API.

We need your help keeping the data up to date.

### Adding a New Model

To add a new model, start by checking if the provider already exists in the `providers/` directory. If not, then:

#### 1. Create a Provider

If the AI provider doesn't already exist in the `providers/` directory:

1. Create a new folder in `providers/` with the provider's ID. For example, `providers/newprovider/`.
2. Add a `provider.toml` file with the provider information:

   ```toml
   name = "Provider Name"
   ```

#### 2. Add a Model Definition

Create a new TOML file in the provider's `models/` directory where the filename is the model ID:

```toml
name = "Model Display Name"
attachment = true           # or false - supports file attachments
reasoning = false           # or true - supports reasoning / chain-of-thought
tool_call = true            # or false - supports tool calling
temperature = true          # or false - supports temperature control
knowledge = "2024-04"       # Knowledge-cutoff date
release_date = "2025-02-19" # First public release date
last_updated = "2025-02-19" # Most recent update date

[cost]
input = 3.00                # Cost per million input tokens (USD)
output = 15.00              # Cost per million output tokens (USD)
cache_read = 0.30           # Cost per million cached read tokens (USD)
cache_write = 3.75          # Cost per million cached write tokens (USD)

[limit]
context = 200_000           # Maximum context window (tokens)
output = 8_192              # Maximum output tokens

[modalities]
input = ["text", "image"]   # Supported input modalities
output = ["text"]           # Supported output modalities
```

#### 3. Submit a Pull Request

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

### Schema Reference

Models must conform to the following schema, as defined in `app/schemas.ts`.

**Provider Schema:**

- `name`: String - Display name of the provider

**Model Schema:**

- `name`: String — Display name of the model
- `attachment`: Boolean — Supports file attachments
- `reasoning`: Boolean — Supports reasoning / chain-of-thought
- `tool_call`: Boolean - Supports tool calling
- `temperature`: Boolean — Supports temperature control
- `knowledge` _(optional)_: String — Knowledge-cutoff date in `YYYY-MM` or `YYYY-MM-DD` format
- `release_date`: String — First public release date in `YYYY-MM` or `YYYY-MM-DD`
- `last_updated`: String — Most recent update date in `YYYY-MM` or `YYYY-MM-DD`
- `cost.input` _(optional)_: Number — Cost per million input tokens (USD)
- `cost.output` _(optional)_: Number — Cost per million output tokens (USD)
- `cost.cache_read` _(optional)_: Number — Cost per million cached read tokens (USD)
- `cost.cache_write` _(optional)_: Number — Cost per million cached write tokens (USD)
- `limit.context`: Number — Maximum context window (tokens)
- `limit.output`: Number — Maximum output tokens
- `modalities.input`: Array of strings — Supported input modalities (e.g., ["text", "image", "audio", "video", "pdf"])
- `modalities.output`: Array of strings — Supported output modalities (e.g., ["text"])

### Provider Icons

Provider icons enhance the visual representation of AI providers in the UI. Icons are automatically displayed alongside provider names when specified in the provider configuration.

For detailed information about available icons, how to add new ones, and technical implementation, see [Provider Icons Documentation](PROVIDER_ICONS.md).

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

### Questions?

Open an issue if you need help or have questions about contributing.

---

Models.dev is created by the maintainers of [SST](https://sst.dev).

**Join our community** [Discord](https://sst.dev/discord) | [YouTube](https://www.youtube.com/c/sst-dev) | [X.com](https://x.com/SST_dev)
