Vercel AI Gateway Models

Generate model TOMLs from Vercel AI Gateway API.

Prerequisites
- Install Bun: https://bun.sh

Commands
- Generate files: `bun run vercel:generate`
- Dry run: `bun run vercel:generate --dry-run`
- New only: `bun run vercel:generate --new-only`
- Validate: `bun validate`

Details
- Source endpoint: `https://ai-gateway.vercel.sh/v1/models`
- Output path: `providers/vercel/models/<model-id>.toml` (nested folders for IDs with `/`)

Notes
- The generator merges with existing files rather than replacing them
- Orphaned files (not in API) are warned about but not deleted
- Use `--dry-run` to preview changes before writing
- Use `--new-only` to skip updating existing model files
