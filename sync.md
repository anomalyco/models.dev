TODO: delete

# Model Sync Scripts

Model syncs are centralized in `packages/core/src/sync/index.ts`. The runner owns file IO, TOML formatting, validation, reporting, dry runs, and deletion behavior. `packages/core/script/sync-models.ts` is only the CLI wrapper for `bun models:sync`. Individual provider sync modules only fetch source data, parse it, and translate each source model into the catalog schema.

The grouped sync targets are available for local convenience, but CI syncs each provider separately so every provider gets its own reusable automation PR.

## Commands

- `bun models:sync aggregators` syncs every provider in the `aggregators` group.
- `bun models:sync openrouter` syncs only OpenRouter.
- `bun models:sync cloudflare-workers-ai` syncs only Cloudflare Workers AI.
- `bun models:sync cloudflare` syncs the Cloudflare sync group.
- `bun models:sync direct` syncs every provider in the `direct` group.
- `bun models:sync google` syncs only Google.
- `bun models:sync xai` syncs only xAI.
- `bun models:sync aggregators --dry-run` prints changes without writing model files.
- `bun models:sync aggregators --new-only` creates new model files but skips updates and removals.
- `bun validate` validates the generated catalog after a sync.

Sync runs also write `.sync/model-sync-report.md` for the automation workflow PR body. Do not commit that report from local runs.

## Runner Responsibilities

`packages/core/src/sync/index.ts` handles the shared behavior:

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

Provider modules live in `packages/core/src/sync/providers/`. A provider exports an object satisfying `SyncProvider<SourceModel>`:

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

1. Create `packages/core/src/sync/providers/<provider>.ts`.
2. Define strict-enough Zod schemas for the provider response.
3. Export a `SyncProvider` implementation with `fetchModels`, `parseModels`, and `translateModel`.
4. Add the provider to `providers` in `packages/core/src/sync/index.ts`.
5. Add the provider ID to an existing group or create a new group in `groups`.
6. Add any required API secrets to `.github/workflows/sync-models.yml` if the provider needs new credentials.
7. Run `bun models:sync <provider> --dry-run` to inspect the first diff.
8. Run `bun models:sync <provider>` to write files.
9. Run `bun models:sync <provider> --dry-run` again and expect a clean result.
10. Run `bun validate`.

Prefer small, provider-specific PRs when adding a provider. If the provider has ambiguous source data, keep it out of shared groups until the source-of-truth behavior is clear.

## Automation

`.github/workflows/sync-models.yml` runs on an hourly schedule and manually through `workflow_dispatch`.

The workflow:

- Checks out `dev`.
- Installs dependencies with Bun.
- Discovers sync providers with `bun models:sync --list-providers`.
- Runs one provider per matrix job with `bun models:sync ${{ matrix.provider }}`.
- Runs `bun validate`.
- Creates or updates a provider-specific sync PR only when `providers` changed.
- Uses `.sync/model-sync-report.md` as the PR body.

Each provider job checks out `dev` and writes to a fixed provider branch like `automation/sync-models-openrouter`. If that provider's sync PR is already open, later scheduled runs force-update the same branch and edit the existing PR instead of creating another one. Provider jobs do not share unmerged changes with each other; OpenRouter only extends from canonical provider TOMLs already present on `dev`.

CI automatically picks up providers registered in `providers` in `packages/core/src/sync/index.ts`. Adding a new sync provider there is enough to get an hourly provider-specific sync job, branch, labels, title, and PR naming convention. The workflow only needs manual updates when a new provider requires new secrets or other environment variables.

Actions are pinned by commit SHA. Keep new workflow actions pinned the same way.

## OpenRouter Notes

OpenRouter is implemented in `packages/core/src/sync/providers/openrouter.ts`.

- Source endpoint: `https://openrouter.ai/api/v1/models`.
- Optional auth: `OPENROUTER_API_KEY`.
- Model IDs map directly to TOML paths under `providers/openrouter/models`.
- API prices are per-token strings and are converted to per-1M-token numbers.
- `structured_output` comes from `supported_parameters.includes("structured_outputs")` only.
- Existing `status`, `interleaved`, `knowledge`, `limit.input`, and `cost.tiers` may be preserved when OpenRouter is not authoritative enough for those fields.

## Cloudflare Workers AI Notes

Cloudflare Workers AI is implemented in `packages/core/src/sync/providers/cloudflare-workers-ai.ts`.

- Source endpoint: `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID/ai/models/search?format=openrouter`.
- Required auth: `CLOUDFLARE_WORKERS_AI_SYNC_ACCOUNT_ID` and `CLOUDFLARE_WORKERS_AI_SYNC_API_TOKEN`.
- Use a dedicated token scoped to Workers AI read access so sync automation does not share deploy credentials.
- The endpoint is parsed as Cloudflare's OpenRouter-like Workers AI metadata.
- Model IDs map directly to TOML paths under `providers/cloudflare-workers-ai/models`.
- This sync target does not manage `providers/cloudflare-ai-gateway`, because the AI Gateway `/compat/models` endpoint does not support `format=openrouter` and does not provide enough model metadata for authoritative catalog sync.

## Google Notes

Google is implemented in `packages/core/src/sync/providers/google.ts`.

- Source endpoint: `https://generativelanguage.googleapis.com/v1beta/models`.
- Required auth: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
- Model IDs are derived from the `models/{model}` resource names.
- The API is authoritative for display names, token limits, temperature metadata, and the `thinking` flag when present.
- Local Google models missing from the API response are removed.
- New Google API models are reported in `.sync/model-sync-report.md` but not created automatically because the API does not provide authoritative modalities, pricing, knowledge cutoff, release date, tool calling, or structured output metadata.

## xAI Notes

xAI is implemented in `packages/core/src/sync/providers/xai.ts`.

- Source endpoints: `https://api.x.ai/v1/language-models`, `https://api.x.ai/v1/image-generation-models`, and `https://api.x.ai/v1/video-generation-models`.
- Required auth: `XAI_API_KEY`.
- The richer typed endpoints provide model IDs, creation timestamps, modalities, pricing for language models, and prompt/input limits where available.
- Existing xAI models are updated from API-authoritative fields while local metadata is preserved for fields the API does not expose, especially output token limits and some feature/capability flags.
- New xAI API models are reported in `.sync/model-sync-report.md` but not created automatically because the API does not provide enough authoritative metadata for complete catalog entries.

## OVHcloud Notes

OVHcloud AI Endpoints is implemented in `packages/core/src/sync/providers/ovhcloud.ts`.

- Source endpoint: `https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter`.
- No auth required: the catalog is public.
- Model IDs are lowercased from the catalog `id` to match the existing TOML paths under `providers/ovhcloud/models`.
- API prices are per-token strings and are converted to per-1M-token numbers; free models (price `0`) get no `[cost]` section.
- `reasoning`, `tool_call`, and `structured_output` come from `supported_features`; `temperature` comes from `supported_sampling_parameters`.
- `attachment` is derived from non-text `input_modalities`, and `open_weights` from the presence of `hugging_face_id`.
- `release_date`/`last_updated` default to the catalog `created` timestamp but preserve any existing hand-authored dates; `knowledge`, `family`, `status`, `interleaved`, and `limit.input` are preserved when present.

## Vercel Status

Vercel is intentionally not wired into `bun models:sync` right now. Keep using the existing `vercel:generate` script until Vercel sync behavior is redesigned and reviewed separately.

Do not add Vercel model changes to OpenRouter sync PRs.
