# Cloudflare AI Gateway

Cloudflare AI Gateway proxies multiple upstream model providers behind a single endpoint. This provider surfaces the subset of that catalog that's kept in-repo.

## Catalog layout

```
providers/cloudflare-ai-gateway/models/
├── anthropic/     # hand-maintained
├── openai/        # hand-maintained
└── workers-ai/    # mirrored from providers/cloudflare-workers-ai
```

### `workers-ai/`

`workers-ai/@cf` is a symlink to `../../../cloudflare-workers-ai/models/@cf`. AIG's Workers AI catalog is the Cloudflare Workers AI catalog by construction -- there's no separate sync, no separate PR, no chance of drift. When the hourly `cloudflare-workers-ai` sync opens a PR that changes TOMLs under `providers/cloudflare-workers-ai/models/@cf/`, merging it updates AIG's `workers-ai/` catalog on the next deploy via `followSymlinks: true` in the build glob.

The scope of `workers-ai/` therefore tracks the WAI sync exactly: whatever `bun models:sync cloudflare-workers-ai` produces, AIG surfaces. Broadening WAI's source (e.g. to cover embeddings, ASR, TTS) automatically broadens AIG.

### `openai/` and `anthropic/`

These subtrees are hand-authored TOMLs for the OpenAI- and Anthropic-compatible routes AIG exposes. They're intentionally curated rather than synced, and are not touched by any model sync provider.

## Provider configuration

`provider.toml` uses the `ai-gateway-provider` npm package, which posts to AIG's
universal endpoint (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}`).

Required env vars: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`.

## References

- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [OpenAI compatibility](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
- [Anthropic compatibility](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
- [Workers AI catalog](https://developers.cloudflare.com/workers-ai/models/)
