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

## Contribution Review Checklist

Use this checklist when reviewing PRs that add providers or models. The first two
items are **hard blockers**; the last two are **strongly recommended** but not blockers.

### New providers (blocker)
- **Must ship a logo.** Every new provider needs a `providers/<id>/logo.svg` that follows
  the logo guidelines below. A PR that adds a provider without a compliant logo is not
  mergeable as-is.
- **Should add a sync module when the source is context-rich.** If the provider exposes an
  API/catalog that can populate full model data (or at least authoritatively delete models
  it no longer serves), add a sync module like OpenRouter's (see `sync.md`). Only add sync
  when the source is rich enough to be authoritative; a thin endpoint that cannot populate
  required fields should stay hand-authored. This is highly recommended, not a blocker.

### New models (blocker)
- **Must use `base_model` when a `models/` metadata entry exists** for the underlying model.
  Do not duplicate provider-agnostic facts inline when they can be inherited. Only write a
  full inline definition when no matching `models/<provider>/<model>.toml` exists.
- **Reasoning models must declare `reasoning_options`.** Any model with `reasoning = true`
  needs a `reasoning_options` array reflecting the provider's actual API surface (see the
  audit-reasoning-options skill). For niche providers that document a budget or toggle
  control, express the exact API request syntax the provider expects as a TOML comment next
  to the option, e.g.:
  ```toml
  [[reasoning_options]]
  type = "toggle" # API: {"chat_template_kwargs": {"enable_thinking": false}}

  [[reasoning_options]]
  type = "budget_tokens" # API: {"thinking": {"budget_tokens": <n>}}
  min = 1_024
  max = 32_000
  ```
  Use `reasoning_options = []` when the model reasons but exposes no verified control.

### Citations (recommended)
- **PRs that change data should cite their sources.** Link to the provider's pricing page,
  model docs, or API reference that justifies the change in the PR body. This is highly
  recommended, not a blocker, but PRs without any sourcing should be treated with more
  scrutiny and verified before merge.
- **In-file comments must live at the top of the file.** The daily model sync rewrites
  synced provider TOMLs by parsing and re-serializing them, which discards every comment
  except a leading header block. Put source citations and rationale as a comment block at
  the very top of the file (above the first key); comments placed between sections or
  above individual keys are silently deleted on the next sync run.

### Logo guidelines
- File lives at `providers/<provider-id>/logo.svg`, SVG format.
- No fixed size or hardcoded colors — use `currentColor` for fills/strokes so the logo
  adapts to light/dark themes.
- Prefer a square `viewBox` (e.g. `0 0 24 24`).
- Example:
  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <!-- Logo paths here -->
  </svg>
  ```

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
