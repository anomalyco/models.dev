Vercel AI Gateway Models

Generate model TOMLs from Vercel AI Gateway API.

Prerequisites
- Install Bun: https://bun.sh

Commands
- Sync files: `bun models:sync vercel`
- Dry run: `bun models:sync vercel --dry-run`
- New only: `bun models:sync vercel --new-only`
- Validate: `bun validate`

Details
- Source endpoint: `https://ai-gateway.vercel.sh/v1/models`
- Output path: `providers/vercel/models/<model-id>.toml` (nested folders for IDs with `/`)

Notes
- The generator merges with existing files rather than replacing them
- Orphaned files (not in API) are warned about but not deleted
- Use `--dry-run` to preview changes before writing
- Use `--new-only` to skip updating existing model files
