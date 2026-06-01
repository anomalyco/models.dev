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
- Models may reuse another model's definition via `extends` (see below); otherwise the full definition must be present in the file
- Schema uses `.strict()` — extra fields cause validation errors

### `[extends]` (inheritance between models)
- Syntax — a table at the top of the TOML:
  ```toml
  [extends]
  from = "<provider-id>/<model-id>"   # required
  omit = ["experimental.modes.fast"]  # optional, dot-path strings
  ```
  Example: `from = "anthropic/claude-opus-4-6"`
- Resolved at parse time in `generate()`; the final JSON output contains **no** `extends` field — it exists only to cut duplication in the TOMLs
- Merge semantics:
  - Plain objects (`[cost]`, `[limit]`, `[modalities]`, `[provider]`, `[experimental]`, …) are **deep-merged**
  - Arrays (e.g. `modalities.input`) and primitives are **replaced** wholesale by the child
  - Any field the child omits is inherited verbatim from the base
- `omit` runs **after** the merge and deletes each dot-path from the result (used when the child needs to *remove* something the base defines, e.g. a provider-specific experimental mode). Every listed path must exist in the merged model, else an error is thrown. Ancestor tables that become empty as a result are also pruned, so `omit = ["experimental.modes.fast"]` yields no `experimental` key in the final JSON when `fast` was the only mode.
- Chains are allowed (A extends B extends C); cycles throw
- The base model must exist; `[extends.from]` pointing at a missing provider/model is an error
- The `extends` table is stripped before schema validation, so the merged result must still satisfy the strict `Model` schema

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
| `retirement_date` | No | Date the model is/will be retired (no longer served), `YYYY-MM` or `YYYY-MM-DD` |
| `status` | No | Use for `"alpha"`, `"beta"`, `"deprecated"` lifecycle |