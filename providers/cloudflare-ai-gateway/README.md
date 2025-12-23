# Cloudflare AI Gateway Provider

This provider enables model management for Cloudflare AI Gateway, which acts as a unified proxy for multiple AI providers (OpenAI, Anthropic, Workers AI, Replicate, etc.).

## Overview

Cloudflare AI Gateway provides a compatibility layer that allows you to access models from various providers through a single endpoint. This provider automatically fetches available models from the Cloudflare API and generates TOML configuration files for use in the models.dev system.

## Directory Structure

```
cloudflare-ai-gateway/
├── data/
│   ├── api_response.json    # Cached API response from Cloudflare
│   └── model_names.json     # Human-readable name mappings
├── models/                   # Generated TOML files
│   ├── anthropic/
│   ├── openai/
│   ├── replicate/
│   └── workers-ai/
├── scripts/
│   ├── 01_fetch_model_data.sh      # Fetches models from Cloudflare API
│   ├── 02_generate_model_names.sh  # Updates model name mappings
│   ├── 03_generate_model_toml.sh   # Generates TOML files
│   └── utils.sh                     # Shared utility functions
├── provider.toml            # Provider configuration
└── README.md                # This file
```

## How It Works

### 1. Model Fetching (01_fetch_model_data.sh)

This script fetches the list of available models from the Cloudflare AI Gateway API:

- **API Endpoint**: `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/compat/models`
- **Authentication**: Uses `CLOUDFLARE_API_TOKEN` for authorization
- **Output**: Saves the API response to `data/api_response.json`

The API returns model data including:
- Model ID (e.g., `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`)
- Cost per token (input and output)
- Creation timestamp
- Other metadata

### 2. Model Name Generation (02_generate_model_names.sh)

This script manages the `data/model_names.json` file, which maps model IDs to human-readable names:

- Reads from `data/api_response.json`
- Adds new model IDs to `model_names.json` (if not already present)
- Preserves existing name mappings
- Filters models based on configuration in `utils.sh`

**Model Filtering**:
- Includes ALL models from: `workers-ai`, `replicate`
- Includes ONLY well-known models from: `openai`, `anthropic`
- Skips namespaces: `replicate/replicate-internal`
- Skips specific models: `aura-1`, `whisper`

### 3. TOML Generation (03_generate_model_toml.sh)

This script generates TOML configuration files for each model:

**Two Generation Strategies**:

1. **Cross-referencing** (for OpenAI and Anthropic):
   - Copies TOML files from the source provider directories
   - Maps Cloudflare model names to canonical provider names
   - Example: `anthropic/claude-3.5-sonnet` → `../../anthropic/models/claude-3-5-sonnet-20241022.toml`

2. **Auto-generation** (for Workers AI and Replicate):
   - Generates TOML files with default values
   - Uses cost and metadata from the API response
   - Converts cost per token → cost per million tokens
   - Sets default capabilities (context length, modalities, etc.)

**Generated TOML Structure**:
```toml
name = "Model Name"
release_date = "2024-01-01"
last_updated = "2024-01-01"
attachment = false
reasoning = false
temperature = true
tool_call = false
open_weights = false

[cost]
input = 0.15      # USD per 1M input tokens
output = 0.60     # USD per 1M output tokens

[limit]
context = 128000   # Max context tokens
output = 16384     # Max output tokens

[modalities]
input = ["text"]
output = ["text"]
```

### 4. Utilities (utils.sh)

Shared configuration and helper functions:

**Configuration**:
- `INCLUDE_ALL_PROVIDERS`: Providers to include all models from
- `CROSS_REFERENCE_PROVIDERS`: Providers to copy from source directories
- `WELL_KNOWN_MODELS`: Regex patterns for specific models to include
- `SKIP_NAMESPACES`: Namespaces to exclude
- `SKIP_MODELS`: Specific models to exclude

**Helper Functions**:
- `should_include_model()`: Determines if a model should be included
- `get_mapped_name()`: Maps Cloudflare names to source provider names
- `find_source_file()`: Locates source TOML files for cross-referencing

## Usage

### Prerequisites

- Cloudflare account with AI Gateway configured
- Required environment variables:
  - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
  - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
  - `CLOUDFLARE_GATEWAY_ID`: Your AI Gateway name/ID

### Running the Scripts

Run scripts individually or in sequence:

```bash
# Step 1: Fetch model data from Cloudflare API
cd scripts
CLOUDFLARE_API_TOKEN=xxx \
CLOUDFLARE_ACCOUNT_ID=xxx \
CLOUDFLARE_GATEWAY_ID=xxx \
./01_fetch_model_data.sh

# Step 2: Update model name mappings
./02_generate_model_names.sh

# Step 3: Generate TOML files
./03_generate_model_toml.sh
```

### Configuration

Edit `scripts/utils.sh` to customize:

1. **Add a provider to include all models**:
```bash
INCLUDE_ALL_PROVIDERS="workers-ai replicate my-new-provider"
```

2. **Add a well-known model**:
```bash
WELL_KNOWN_MODELS=(
  # ... existing patterns ...
  "openai/gpt-5$"
)
```

3. **Skip a namespace**:
```bash
SKIP_NAMESPACES="replicate/replicate-internal my-provider/internal"
```

4. **Cross-reference a provider**:
```bash
CROSS_REFERENCE_PROVIDERS="openai anthropic google"
```

### Model Name Mappings

Edit `data/model_names.json` to provide human-readable names:

```json
{
  "workers-ai/llama-3-8b-instruct": "Llama 3 8B Instruct",
  "openai/gpt-4o": "GPT-4o",
  "anthropic/claude-3.5-sonnet": "Claude 3.5 Sonnet"
}
```

## Model ID Format

Cloudflare uses BOTH dots and hyphens in model IDs (the API returns both formats):
- **OpenAI**: `openai/gpt-5.1` OR `openai/gpt-5-1`, `openai/gpt-3.5-turbo` OR `openai/gpt-3-5-turbo`
- **Anthropic**: `anthropic/claude-3.5-sonnet` OR `anthropic/claude-3-5-sonnet`, `anthropic/claude-haiku-4-5`
- **Workers AI**: `workers-ai/@cf/meta/llama-3-8b-instruct`
- **Replicate**: `replicate/meta/meta-llama-3-70b-instruct`

**Important**: The API returns duplicate models with different naming conventions (dots vs hyphens). The WELL_KNOWN_MODELS patterns handle both formats using `[\.-]` regex to match either a dot or hyphen.

**File Path Conversion**:
- Dots are preserved in filenames: `openai/gpt-5.1.toml`
- Workers AI special handling: `workers-ai/@cf/meta/llama` → `workers-ai/llama.toml`

## Cross-Referencing Logic

For OpenAI and Anthropic models, the scripts map Cloudflare model IDs to canonical provider filenames:

**Anthropic Mappings**:
- `claude-3.5-sonnet` → `claude-3-5-sonnet-20241022.toml`
- `claude-3.5-haiku` → `claude-3-5-haiku-latest.toml`
- `claude-3-opus` → `claude-3-opus-20240229.toml`

**OpenAI Mappings**:
- `gpt-5.1` → `gpt-5.1.toml`
- `gpt-3.5-turbo` → `gpt-3.5-turbo.toml`

This ensures consistency with the canonical provider definitions while supporting Cloudflare's naming conventions.

## Cleanup

The TOML generation script automatically:
- Removes models that are no longer in the API response
- Cleans up empty directories
- Maintains a clean models directory

## Troubleshooting

**API errors**:
- Verify environment variables are set correctly
- Check API token has necessary permissions
- Ensure Gateway ID matches your Cloudflare configuration

**Missing models**:
- Check if the model is filtered by `utils.sh` configuration
- Review `WELL_KNOWN_MODELS` patterns
- Verify the model exists in `data/api_response.json`

**Cross-referencing failures**:
- Ensure source provider directories exist (e.g., `../openai/models/`)
- Check model name mappings in `get_mapped_name()`
- Verify source TOML files exist with correct names

## Provider Configuration

The `provider.toml` file defines how OpenCode connects to Cloudflare AI Gateway:

```toml
name = "Cloudflare AI Gateway"
env = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]
npm = "@ai-sdk/openai-compatible"
api = "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat/"
doc = "https://developers.cloudflare.com/ai-gateway/"
```

## Additional Resources

- [Cloudflare AI Gateway Documentation](https://developers.cloudflare.com/ai-gateway/)
- [OpenAI Compatibility API](https://developers.cloudflare.com/ai-gateway/providers/openai/)
- [Vercel AI SDK](https://sdk.vercel.ai/)
