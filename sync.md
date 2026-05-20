TODO: delete

# Model Sync Scripts

Model syncs are centralized in `packages/core/script/sync-models.ts`. The runner owns file IO, TOML formatting, validation, reporting, dry runs, and deletion behavior. Individual provider sync modules only fetch source data, parse it, and translate each source model into the catalog schema.

The grouped sync targets are `aggregators`, which runs OpenRouter, and `direct`, which runs direct provider APIs like Google.

## Commands

- `bun models:sync aggregators` syncs every provider in the `aggregators` group.
- `bun models:sync openrouter` syncs only OpenRouter.
- `bun models:sync direct` syncs every provider in the `direct` group.
- `bun models:sync google` syncs only Google.
- `bun models:sync aggregators --dry-run` prints changes without writing model files.
- `bun models:sync aggregators --new-only` creates new model files but skips updates and removals.
- `bun validate` validates the generated catalog after a sync.

Sync runs also write `.sync/model-sync-report.md` for the automation workflow PR body. Do not commit that report from local runs.

## Runner Responsibilities

`packages/core/script/sync-models.ts` handles the shared behavior:

- Reads existing TOML files from the provider `modelsDir`.
- Parses existing files with `Bun.TOML.parse` and `AuthoredModelShape.partial()`.
- Calls the provider module to fetch, parse, and translate source models.
- Validates translated models with `AuthoredModel` before writing.
- Formats TOML consistently for all synced providers.
- Compares semantic model data before writing to avoid formatting-only churn.
- Replaces symlinked files safely by removing the symlink before writing.
- Removes existing files that are no longer present in the desired synced set.
- Writes `.sync/model-sync-report.md` for GitHub Actions.

Because the runner removes files missing from the desired set, a provider module should only skip source models when deleting existing local files for those skipped IDs is intentional.

## Provider Modules

Provider modules live in `packages/core/script/sync/`. A provider exports an object satisfying `SyncProvider<SourceModel>`:

```ts
export const provider = {
  id: "provider-id",
  name: "Provider Name",
  modelsDir: "providers/provider-id/models",
  async fetchModels() {
    return fetch("https://example.com/models").then((response) => response.json());
  },
  parseModels(raw) {
    return ProviderResponse.parse(raw).data;
  },
  translateModel(model, context) {
    return {
      id: model.id,
      model: buildModel(model, context.existing(model.id)),
    };
  },
} satisfies SyncProvider<ProviderModel>;
```

Keep provider modules focused on provider-specific logic:

- Define Zod schemas for the provider API response.
- Fetch from the provider API, including auth headers when needed.
- Convert provider pricing units to per-1M-token catalog prices.
- Convert dates, modalities, limits, capabilities, and model IDs into catalog fields.
- Preserve existing hand-authored fields only when the provider API is not authoritative for that field.
- Return `undefined` from `translateModel` only when skipped source models should be treated as absent from the synced catalog.

Do not put TOML scanning, writing, deletion, reporting, or generic comparison logic in provider modules.

## Adding A Provider

1. Create `packages/core/script/sync/<provider>.ts`.
2. Define strict-enough Zod schemas for the provider response.
3. Export a `SyncProvider` implementation with `fetchModels`, `parseModels`, and `translateModel`.
4. Add the provider to `providers` in `packages/core/script/sync-models.ts`.
5. Add the provider ID to an existing group or create a new group in `groups`.
6. Update `.github/workflows/sync-models.yml` matrix labels and titles if the new group should run in automation.
7. Run `bun models:sync <provider> --dry-run` to inspect the first diff.
8. Run `bun models:sync <provider>` to write files.
9. Run `bun models:sync <provider> --dry-run` again and expect a clean result.
10. Run `bun validate`.

Prefer small, provider-specific PRs when adding a provider. If the provider has ambiguous source data, keep it out of shared groups until the source-of-truth behavior is clear.

## Automation

`.github/workflows/sync-models.yml` runs on a daily schedule and manually through `workflow_dispatch`.

The workflow:

- Checks out `dev`.
- Installs dependencies with Bun.
- Runs `bun models:sync ${{ matrix.group }}`.
- Runs `bun validate`.
- Creates or updates a sync PR only when `providers` changed.
- Uses `.sync/model-sync-report.md` as the PR body.

Actions are pinned by commit SHA. Keep new workflow actions pinned the same way.

## OpenRouter Notes

OpenRouter is implemented in `packages/core/script/sync/openrouter.ts`.

- Source endpoint: `https://openrouter.ai/api/v1/models`.
- Optional auth: `OPENROUTER_API_KEY`.
- Model IDs map directly to TOML paths under `providers/openrouter/models`.
- API prices are per-token strings and are converted to per-1M-token numbers.
- `structured_output` comes from `supported_parameters.includes("structured_outputs")` only.
- Existing `status`, `interleaved`, `knowledge`, `limit.input`, and `cost.tiers` may be preserved when OpenRouter is not authoritative enough for those fields.

## Google Notes

Google is implemented in `packages/core/script/sync/google.ts`.

- Source endpoint: `https://generativelanguage.googleapis.com/v1beta/models`.
- Required auth: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
- Model IDs are derived from the `models/{model}` resource names.
- The API is authoritative for display names, token limits, temperature metadata, and the `thinking` flag when present.
- Local Google models missing from the API response are removed.
- New Google API models are reported in `.sync/model-sync-report.md` but not created automatically because the API does not provide authoritative modalities, pricing, knowledge cutoff, release date, tool calling, or structured output metadata.

## Vercel Status

Vercel is intentionally not wired into `bun models:sync` right now. Keep using the existing `vercel:generate` script until Vercel sync behavior is redesigned and reviewed separately.

Do not add Vercel model changes to OpenRouter sync PRs.
