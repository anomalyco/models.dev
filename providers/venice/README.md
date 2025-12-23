Venice Models

Generate and update model TOMLs from Venice AI's API.

Prerequisites
- Install Bun: https://bun.sh
- (Optional) Venice API key with alpha access to retrieve alpha models

Commands
- Generate/update files: `bun run venice:generate`
- Dry run (preview changes): `bun run venice:generate --dry-run`
- With API key: `bun run venice:generate --api-key=YOUR_KEY`

API Key
The script can include alpha models when provided with a Venice API key with alpha access.
Key can be provided via:
1. CLI argument: `--api-key=YOUR_KEY` or `--api-key YOUR_KEY`
2. Environment variable: `VENICE_API_KEY`
3. Interactive prompt (press Enter to skip for public models only)

Details
- Source endpoint: `https://api.venice.ai/api/v1/models?type=text`
- Output path: `providers/venice/models/<model-id>.toml`
- Merge behavior: Updates API-sourced fields, preserves manual fields
- Dates: `release_date`/`last_updated` use `YYYY-MM-DD`; `knowledge` uses `YYYY-MM`
- Output limit: Calculated as `context / 4`

Preserved Fields (manual input)
- `family`: Inferred from model ID if not already set
- `knowledge`: Knowledge cutoff date (never auto-set)
- `interleaved`: Reasoning interleaving config
- `status`: Model status (alpha, beta, deprecated)
- PDF in `modalities.input`: Not auto-added, preserved if exists

Notes
- The generator merges with existing files rather than replacing them
- Orphaned files (not in API) are warned about but not deleted
- Run with `--dry-run` to preview changes before applying
