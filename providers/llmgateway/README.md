# LLM Gateway Provider

This provider enables access to 150+ AI models through [LLM Gateway](https://llmgateway.io), an OpenAI-compatible API gateway that provides unified access to 40+ LLM providers.

## Directory Structure

- **models/**: TOML configuration files for all supported models
- **provider.toml**: Provider configuration
- **logo.svg**: Provider logo

## Regenerating Models

Model configurations are generated from the [LLM Gateway repository](https://github.com/theopenco/llmgateway):

```bash
npx tsx scripts/export-models-dev.ts
```

## How It Works

LLM Gateway acts as a unified proxy for multiple AI providers. You can access any supported model through a single API endpoint using your LLM Gateway API key.

## Prerequisites

```bash
export LLMGATEWAY_API_KEY="your-api-key"
```

## Supported Providers

- OpenAI (GPT-3.5, GPT-4, GPT-4o, GPT-5, o1, o3, o4-mini)
- Anthropic (Claude 3, 3.5, 3.7, 4, 4.5)
- Google (Gemini 1.5, 2.0, 2.5, 3, Gemma)
- Meta (Llama 3.1, 3.3, 4)
- xAI (Grok 2, 3, 4)
- DeepSeek (V3, R1)
- Alibaba (Qwen Max, Plus, Flash, VL, Coder)
- Mistral (Large, Pixtral, Mixtral)
- ZAI (GLM 4.5, 4.6, 4.7)
- ByteDance (Seed, Seedream)
- Moonshot (Kimi K2)
- Perplexity (Sonar)
- And many more...

## Usage with AI SDK

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const llmgateway = createOpenAICompatible({
  baseURL: "https://api.llmgateway.io/v1",
  apiKey: process.env.LLMGATEWAY_API_KEY,
});

const result = await generateText({
  model: llmgateway("claude-sonnet-4-5"),
  prompt: "Hello!",
});
```

## Links

- [Documentation](https://llmgateway.io/docs)
- [Pricing](https://llmgateway.io/pricing)
- [GitHub](https://github.com/theopenco/llmgateway)
