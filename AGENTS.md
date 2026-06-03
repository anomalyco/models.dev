# Agent Guidelines for models.dev

## Commands
- **Validate**: `bun validate` - Validates all provider/model configurations
- **Build web**: `cd packages/web && bun run build` - Builds the web interface
- **Dev server**: `cd packages/web && bun run dev` - Runs development server
- **No test framework** - No dedicated test commands found

## Code Style
- **Runtime**: Bun with TypeScript ESM modules
- **Imports**: Use `.js` extensions for local imports (e.g., `./schema.js`)
- **Types**: Strict Zod schemas for validation, inferred types with `z.infer<typeof Schema>`
- **Naming**: camelCase for variables/functions, PascalCase for types/schemas
- **Error handling**: Use Zod's `safeParse()` with structured error objects including `cause`
- **Async**: Use `async/await`, `for await` loops for file operations
- **File operations**: Use Bun's native APIs (`Bun.Glob`, `Bun.file`, `Bun.write`)

## Architecture
- **Monorepo**: Workspace packages in `packages/` (core, web, function)
- **Config**: TOML files for providers/models in `providers/` directory
- **Validation**: Core package validates all configurations via `generate()` function
- **Web**: Static site generation with Hono server and vanilla TypeScript
- **Deploy**: Cloudflare Workers for function, static assets for web

## Conventions
- Use `export interface` for API types, `export const Schema = z.object()` for validation
- Prefix unused variables with underscore or use `_` for ignored parameters
- Handle undefined values explicitly in comparisons and sorting
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safe property access

## Model Configuration

- Model `id` is **auto-injected** from filename (minus `.toml`) — never put `id` in TOML files
- Provider models may reuse provider-agnostic facts from `models/` via `base_model`; otherwise the full provider model definition must be present in the file
- Schema uses `.strict()` — extra fields cause validation errors

### Model metadata and `base_model`
- Provider-agnostic model facts live under `models/<provider>/<model>.toml`
- Provider TOMLs can inherit those facts with:
  ```toml
  base_model = "<provider-id>/<model-id>"
  base_model_omit = ["limit.input"] # optional, dot-path strings
  ```
  Example: `base_model = "anthropic/claude-opus-4-6"`
- Resolved at parse time in `generate()`; the final provider JSON output contains **no** `base_model` or `base_model_omit` fields
- Merge semantics:
  - Plain objects from metadata and provider TOML (`[limit]`, `[modalities]`, …) are **deep-merged**
  - Arrays (e.g. `modalities.input`) and primitives are **replaced** wholesale by the child
  - Any provider field omitted is inherited verbatim from model metadata
  - `cost`, `provider`, `experimental`, `reasoning_options`, `interleaved`, and `status` are provider-specific and must be declared in provider TOMLs when needed
- `base_model_omit` runs **after** the merge and deletes each dot-path from the result. Missing paths are ignored. Ancestor tables that become empty as a result are also pruned.
- The base model metadata file must exist; `base_model` pointing at a missing `models/` entry is an error

### Bedrock Naming Patterns
- Dated models: `-v1:0` suffix (`anthropic.claude-3-5-sonnet-20241022-v1:0.toml`)
- Latest/undated models: bare `-v1` (`anthropic.claude-opus-4-6-v1.toml`)
- Region prefixes: `us.`, `eu.`, `global.` (default has no prefix)

### Vertex AI Naming Patterns
- Dated models: `@YYYYMMDD` (`claude-opus-4-5@20251101.toml`)
- Latest/undated models: `@default` (`claude-opus-4-6@default.toml`)

### Cost Schema
- `cost.context_over_200k` is a nested `Cost` object for >200K token pricing
- Cache pricing ratios: standard models use 10%/125% (read/write), regional variants may use 30%/375%

### Required vs Optional Fields
| Field | Required? | Notes |
|-------|-----------|-------|
| `name`, `release_date`, `last_updated` | Yes | Human-readable metadata |
| `attachment`, `reasoning`, `tool_call`, `open_weights` | Yes | Boolean capabilities |
| `cost`, `limit`, `modalities` | Yes | Objects with their own required fields |
| `family`, `knowledge`, `temperature`, `structured_output` | No | Optional metadata |
| `status` | No | Use for `"alpha"`, `"beta"`, `"deprecated"` lifecycle |
