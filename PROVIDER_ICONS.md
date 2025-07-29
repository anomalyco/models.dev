# Provider Icons

Provider icons enhance the visual representation of AI providers in Models.dev. Icons are automatically displayed alongside provider names when specified in the provider configuration.

## Available Icons

Current provider icons in `packages/web/public/icons/providers/`:

- **Anthropic**: `anthropic.svg`
- **Amazon Bedrock**: `bedrock-color.svg`
- **Azure**: `azureai-color.svg`
- **DeepSeek**: `deepseek-color.svg`
- **Fireworks AI**: `fireworks-color.svg`
- **GitHub**: `github.svg`
- **GitHub Copilot**: `githubcopilot.svg`
- **Google**: `gemini-color.svg`
- **Google Vertex**: `vertexai-color.svg`
- **Groq**: `groq.svg`
- **Hugging Face**: `huggingface-color.svg`
- **Inference**: `inference.svg`
- **Meta**: `meta-color.svg`
- **Mistral**: `mistral-color.svg`
- **Morph**: `Morph.svg`
- **OpenAI**: `openai.svg`
- **OpenRouter**: `openrouter.svg`
- **Requesty**: `Requesty.ico`
- **Upstage**: `upstage-color.svg`
- **V0**: `v0.svg`
- **Venice**: `Venice.svg`
- **Vercel**: `vercel.svg`
- **xAI**: `grok.svg`

## Adding Icons

### For Existing Providers

1. Add icon file to `packages/web/public/icons/providers/`
2. Update `provider.toml`:

```toml
name = "Provider Name"
icon = "provider-icon.svg"
```

### For New Providers

1. Create provider directory: `providers/newprovider/`
2. Add `provider.toml`:

```toml
name = "New Provider"
icon = "newprovider-icon.svg"
```

3. Add icon file to `packages/web/public/icons/providers/`

## Download Icons from LobeHub

Find provider icons at [https://lobehub.com/icons](https://lobehub.com/icons)

### Steps:
1. Visit [https://lobehub.com/icons](https://lobehub.com/icons)
2. Search for provider icons
3. Download SVG format
4. Rename to match convention (e.g., `provider-name-color.svg`)
5. Add to `packages/web/public/icons/providers/`
6. Update `provider.toml` with `icon` field

## Guidelines

- **Format**: SVG.
- **Size**: 48x48 pixels recommended
- **Naming**: Use lowercase with hyphens (e.g., `provider-name-color.svg`)
- **Quality**: Ensure good contrast and visibility

