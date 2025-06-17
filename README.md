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
attachment = true  # or false - supports file attachments
reasoning = false  # or true - supports reasoning/chain-of-thought
temperature = true # or false - supports temperature parameter

[cost]
input = 3.00          # Cost per million input tokens (USD)
output = 15.00        # Cost per million output tokens (USD)
inputCached = 0.30    # Cost per million cached input tokens (USD)
outputCached = 0.30   # Cost per million cached output tokens (USD)

[limit]
context = 200_000     # Maximum context window (tokens)
output = 8_192        # Maximum output tokens
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

- `name`: String - Display name of the model
- `attachment`: Boolean - Whether the model supports file attachments
- `reasoning`: Boolean - Whether the model supports reasoning capabilities
- `temperature`: Boolean - Whether the model supports temperature control
- `cost.input`: Number - Cost per million input tokens (USD)
- `cost.output`: Number - Cost per million output tokens (USD)
- `cost.inputCached`: Number - Cost per million cached input tokens (USD)
- `cost.outputCached`: Number - Cost per million cached output tokens (USD)
- `limit.context`: Number - Maximum context window in tokens
- `limit.output`: Number - Maximum output tokens

### Examples

See existing providers in the `providers/` directory for reference:

- `providers/anthropic/` - Anthropic Claude models
- `providers/openai/` - OpenAI GPT models
- `providers/google/` - Google Gemini models

### Questions?

Open an issue if you need help or have questions about contributing.

---

Models.dev is created by the maintainers of [SST](https://sst.dev).

**Join our community** [Discord](https://sst.dev/discord) | [YouTube](https://www.youtube.com/c/sst-dev) | [X.com](https://x.com/SST_dev)
