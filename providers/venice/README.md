Venice Models

Generate and update model TOMLs from Venice AI's API.

Prerequisites
- Install Bun: https://bun.sh
- (Optional) Venice API key with alpha access to retrieve alpha models

Commands
- Sync files: `bun run venice:sync`
- Dry run (preview changes): `bun run venice:sync --dry-run`
- With API key: `VENICE_API_KEY=YOUR_KEY bun run venice:sync`

API Key
The script can include alpha models when provided with a Venice API key with alpha access.
Provide the key through the `VENICE_API_KEY` environment variable.

Details
- Source endpoint: `https://api.venice.ai/api/v1/models?type=text`
- Output path: `providers/venice/models/<model-id>.toml`
- Merge behavior: Updates API-sourced fields, preserves manual fields
- Dates: `release_date`/`last_updated` use `YYYY-MM-DD`; `knowledge` uses `YYYY-MM`
- Output limit: Sourced from `maxCompletionTokens` in the API response (falls back to `context / 4` if absent)

Preserved Fields (manual input)
- `family`: Inferred from model ID if not already set
- `knowledge`: Knowledge cutoff date (never auto-set)
- `interleaved`: Reasoning interleaving config
- `status`: Model status (alpha, beta, deprecated)
- PDF in `modalities.input`: Not auto-added, preserved if exists

Notes
- The sync updates existing files and skips E2EE models, which require unsupported client-side encryption
- Provider files missing from the API are deleted
- Run with `--dry-run` to preview changes before applying
