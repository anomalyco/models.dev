# PR draft

**Title:** feat(jzstoken): sync the official model lineup

**Base:** `anomalyco/models.dev` `dev` (this branch was cut from `dd792002b`, after the fork's `dev` was fast-forwarded to upstream). Review this draft before any pull request is opened. Open PR https://github.com/anomalyco/models.dev/pull/13722 is still open and is not on `dev`. This branch includes that rename and supersedes #13722. It does not push to `cursor/fix-jzstoken-deepseek-v41-flash-9a9e`.

## Summary

Refresh the JZSTOKEN catalog against the live pricing pages. https://jzstoken.com/model-pricing listed 78 models on 2026-11-20 (56 billed per token, 19 per image, 3 per second of video). Every detail page was fetched again and used as the source for prices and specs. The attached inventory was only a checklist.

- 37 model files added (30 text models published in v1, 7 image models `v2_only`)
- 19 already-listed text models updated where the detail page differed
- 3 stale DeepSeek ids removed
- 22 live models left out; see `MODELS_OMITTED.md`

Text prices below are USD per 1M tokens as input / output / cache read / cache write.

## Models added

Each file uses `base_model` and overrides only host prices, a published context when it is not the lab window, image input when the page states it, and the upstream lab's reasoning controls. JZSTOKEN's pages say tool calling and structured output are not certified per model, so new files do not set `structured_output`. Cache is `implicit` because every token page says cache read/write apply when the upstream provider reports cached tokens.

| ID | base_model | Price | API |
| --- | --- | --- | --- |
| `claude-opus-4-5-20251101` | `anthropic/claude-opus-4-5-20251101` | 1.55 / 7.77 / 0.0155 / 1.94 | v1 |
| `claude-opus-4-6` | `anthropic/claude-opus-4-6` | 1.17 / 5.83 / 0.1166 / 1.46 | v1 |
| `claude-opus-5-5` | `anthropic/claude-opus-5-5` | 1.17 / 5.83 / 0.1166 / 1.46 | v1 |
| `deepseek-v4.1-flash-1017` | `deepseek/deepseek-v4.1-flash-1017` | 0.0683 / 0.2730 / 0.0014 / 0.0683 | v1 |
| `doubao-seed-2.0-code` | `bytedance-seed/seed-2.0-code` | 0.2332 / 1.17 / 0.0233 / 0.2332 | v1 |
| `doubao-seed-2.0-lite` | `bytedance-seed/seed-2.0-lite` | 0.0777 / 0.3886 / 0.0078 / 0.0389 | v1 |
| `doubao-seed-2.0-pro` | `bytedance-seed/seed-2.0-pro` | 0.2332 / 1.17 / 0.0233 / 0.2332 | v1 |
| `doubao-seed-2.1-turbo` | `bytedance-seed/seed-2.1-turbo` | 0.2332 / 1.17 / 0.0233 / 0.2332 | v1 |
| `glm-5.2` | `zhipuai/glm-5.2` | 0.6218 / 3.11 / 0.0622 / 0.6218 | v1 |
| `glm-5.3-flash` | `zhipuai/glm-5.3-flash` | 0.1555 / 0.7773 / 0.0155 / 0.1555 | v1 |
| `gpt-5.6-luna` | `openai/gpt-5.6-luna` | 0.1555 / 0.7773 / 0.0155 / 0.1555 | v1 |
| `gpt-6-luna` | `openai/gpt-6-luna` | 0.1555 / 0.7773 / 0.0155 / 0.1555 | v1 |
| `gpt-6-sol` | `openai/gpt-6-sol` | 0.3109 / 1.87 / 0.0311 / 0.3886 | v1 |
| `gpt-6.2-astra` | `openai/gpt-6.2-astra` | 0.9327 / 4.66 / 0.0933 / 1.17 | v1 |
| `gpt-6.2-sol` | `openai/gpt-6.2-sol` | 0.3109 / 1.55 / 0.0311 / 0.3886 | v1 |
| `gpt-image-2` | `openai/gpt-image-2` | 0.0058 per image | v2 only |
| `gpt-image-2.5-flare` | `openai/gpt-image-2.5-flare` | 0.0194 per image | v2 only |
| `gpt-image-2.5-sunburst` | `openai/gpt-image-2.5-sunburst` | 0.0194 per image | v2 only |
| `gpt-image-2.6-flare` | `openai/gpt-image-2.6-flare` | 0.0194 per image | v2 only |
| `gpt-image-2.6-sunburst` | `openai/gpt-image-2.6-sunburst` | 0.0194 per image | v2 only |
| `grok-4.5` | `xai/grok-4.5` | 0.3886 / 1.94 / 0.4858 / 0.3886 | v1 |
| `grok-4.6` | `xai/grok-4.6` | 0.3886 / 1.94 / 0.4858 / 0.3886 | v1 |
| `LongCat-2.0` | `meituan/longcat-2.0` | 0.0777 / 0.3109 / 0.0078 / 0.0777 | v1 |
| `LongCat-2.5` | `meituan/longcat-2.5` | 0.0777 / 0.3109 / 0.0078 / 0.0777 | v1 |
| `mimo-v2.5-pro` | `xiaomi/mimo-v2.5-pro` | 0.3109 / 1.55 / 0.0311 / 0.3109 | v1 |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` | 0.0777 / 0.3886 / 0.0078 / 0.0777 | v1 |
| `mimo-v2.6-pro` | `xiaomi/mimo-v2.6-pro` | 0.3109 / 1.55 / 0.0311 / 0.3109 | v1 |
| `MiniMax-H3-Image` | `minimax/MiniMax-H3-Image` | 0.1555 per image | v2 only |
| `MiniMax-H3-Image-Highspeed` | `minimax/MiniMax-H3-Image-Highspeed` | 0.3109 per image | v2 only |
| `MiniMax-M2.7` | `minimax/MiniMax-M2.7` | 0.0389 / 0.1943 / 0.0039 / 0.0194 | v1 |
| `MiniMax-M2.7-highspeed` | `minimax/MiniMax-M2.7-highspeed` | 0.0777 / 0.3886 / 0.0078 / 0.0389 | v1 |
| `MiniMax-M3` | `minimax/MiniMax-M3` | 0.0777 / 0.3886 / 0.0078 / 0.0194 | v1 |
| `MiniMax-M3.1-flash` | `minimax/MiniMax-M3.1-Flash` | 0.0777 / 0.3886 / 0.0078 / 0.0777 | v1 |
| `qwen3.7-max` | `alibaba/qwen3.7-max` | 0.7773 / 2.33 / 0.0972 / 0.9716 | v1 |
| `qwen3.7-plus` | `alibaba/qwen3.7-plus` | 0.3109 / 1.55 / 0.0311 / 0.3109 | v1 |
| `qwen3.8-flash` | `alibaba/qwen3.8-flash` | 0.1555 / 0.7773 / 0.0155 / 0.1555 | v1 |
| `step-3.7-flash` | `stepfun/step-3.7-flash` | 0.0777 / 0.3886 / 0.0078 / 0.0389 | v1 |

Page for each row: `https://jzstoken.com/model-pricing/<id>`. Most billing rows were last updated 2026-11-20 00:17 UTC. `deepseek-v4.1-flash-1017` was last updated 2026-11-10 07:20 UTC.

`deepseek-v4.1-flash-1017` replaces `deepseek-v4.1-flash` (the change in #13722). Off-peak prices are the base. Peak is Monday-Friday 09:00-12:00 and 14:00-18:00 Asia/Shanghai (UTC+8, no DST), encoded as Monday-Friday 01:00-04:00 and 06:00-10:00 UTC with factor 2. The page says image input is not supported, so input is text only.

`claude-opus-5-5` and `claude-opus-5.5` are both live and have the same list price. They stay separate request ids. Both use `base_model = "anthropic/claude-opus-5-5"`, the only lab file.

`doubao-seed-*` uses the lab ids already used for those request ids elsewhere in this repo (`bytedance-seed/seed-2.0-lite`, `seed-2.0-code`, `seed-2.0-pro`, `seed-2.1-turbo`). `MiniMax-M3.1-flash` maps to `minimax/MiniMax-M3.1-Flash` (case only). `LongCat-2.0` maps to `meituan/longcat-2.0`.

Image models are `POST https://jzstoken.com/api/v1/images/generations`, `[api.images]` with `@opencode/ai/providers/openai-compatible/images`, and `[cost.image.output] unit = "image"`. They are `v2_only` because v1 prices are per text token, so a per-image price would be dropped and the v1 row would have no cost. `gpt-image-2` says image input is not supported, so its input is text only.

New OpenAI chat models repeat the 2026-10-30 host probe from #12067 (`type=custom` freeform text, lark, and regex returned HTTP 400 `request_feature_unsupported`). The probe was not run again. `base_model_omit = ["capabilities.tools.freeform"]` is set on those files.

Host context overrides, only where the page publishes a window that is not the lab window (a published "1M" is treated as the same window as 1,000,000 or 1,048,576):

| ID | Published context | What changed |
| --- | --- | --- |
| `gpt-5.6-luna` | 258K | context 258000; lab input 922000 capped to 258000 |
| `doubao-seed-2.0-code` | 200K | context 200000 (lab 262144) |
| `doubao-seed-2.0-pro` | 128K | context 128000 |
| `glm-5.2` | 1M, image input supported | input adds generic `image` because the page lists no MIME type |

## Models updated

All 19 models that #12067 left in the catalog differed from the 2026-11-20 detail page. Reasoning controls on these files were left as they were. Prices are input / output / cache read / cache write per 1M.

| ID | Previous | Official page | Also |
| --- | --- | --- | --- |
| `claude-haiku-4-5-20251001` | 0.0778 / 0.3892 / 0.0078 / 0.1168 | 0.1555 / 0.7773 / 0.0155 / 0.2332 | context 200000 -> 256000 |
| `claude-opus-4-7` | 1.17 / 5.84 / 0.1168 / 1.46 | 1.17 / 5.83 / 0.1166 / 1.46 |  |
| `claude-opus-4-8` | 1.17 / 5.84 / 0.1168 / 1.46 | 1.17 / 5.83 / 0.1166 / 1.46 |  |
| `claude-opus-5` | 1.17 / 5.84 / 0.1168 / 1.46 | 1.17 / 5.83 / 0.1166 / 1.46 |  |
| `claude-opus-5.5` | 1.17 / 5.84 / 0.1168 / 1.46 | 1.17 / 5.83 / 0.1166 / 1.46 |  |
| `claude-sonnet-5` | 0.7784 / 3.89 / 0.0778 / 0.9731 | 0.7773 / 3.89 / 0.0777 / 0.9716 |  |
| `claude-sonnet-5.5` | 0.7784 / 3.89 / 0.0778 / 0.9731 | 0.7773 / 3.89 / 0.0777 / 0.9716 |  |
| `glm-5.3` | 0.6228 / 3.11 / 0.0623 / 0.6228 | 0.6218 / 3.11 / 0.0622 / 0.6218 |  |
| `gpt-5.5` | 0.3892 / 2.34 / 0.0389 / 0.3892 | 0.3886 / 2.33 / 0.0389 / 0.3886 | context 1050000 -> 258000; input capped 922000 -> 258000 |
| `gpt-5.6-sol` | 0.6228 / 2.80 / 0.0623 / 0.7784 | 0.6218 / 2.80 / 0.0622 / 0.7773 | context 1050000 -> 258000; input capped 922000 -> 258000 |
| `gpt-5.6-terra` | 0.2335 / 1.40 / 0.0234 / 0.3503 | 0.2332 / 1.40 / 0.0233 / 0.3498 | context 1050000 -> 258000; input capped 922000 -> 258000 |
| `gpt-6-astra` | 1.17 / 7.01 / 0.1168 / 1.75 | 1.17 / 7.00 / 0.1166 / 1.75 |  |
| `gpt-6.1-sol` | 0.3114 / 1.87 / 0.0311 / 0.3892 | 0.3109 / 1.55 / 0.0311 / 0.3886 |  |
| `gpt-6.1-terra` | 0.1557 / 0.7784 / 0.0156 / 0.1557 | 0.1555 / 0.7773 / 0.0155 / 0.1555 |  |
| `grok-4.7` | 0.3892 / 1.95 / 0.0389 / 0.4865 | 0.3886 / 1.94 / 0.0389 / 0.4858 |  |
| `kimi-k2.6` | 0.1557 / 0.7784 / 0.0156 / 0.1557 | 0.1555 / 0.7773 / 0.0155 / 0.1555 |  |
| `kimi-k3` | 1.95 / 9.73 / 0.1946 / 1.95 | 1.94 / 9.72 / 0.1943 / 1.94 |  |
| `kimi-k3.1-pro` | 1.17 / 5.84 / 0.0778 / 1.17 | 1.17 / 5.83 / 0.0777 / 1.17 |  |
| `qwen3.8-max` | 1.56 / 4.67 / 0.1946 / 1.95 | 1.55 / 4.66 / 0.1943 / 1.94 |  |

Pages: `https://jzstoken.com/model-pricing/<id>`.

`claude-haiku-4-5-20251001` is the large price move (about 2x) and the page now says 256K context (lab context is 200000). `gpt-6.1-sol` output moved from 1.87 to 1.55.

## Models removed

| ID | Evidence |
| --- | --- |
| `deepseek-v4-flash` | https://jzstoken.com/model-pricing/deepseek-v4-flash renders "Model not found" |
| `deepseek-v4-pro` | https://jzstoken.com/model-pricing/deepseek-v4-pro renders "Model not found" |
| `deepseek-v4.1-flash` | https://jzstoken.com/model-pricing/deepseek-v4.1-flash renders "Model not found"; replaced by `deepseek-v4.1-flash-1017` |

## Models omitted

22 live models are listed in `MODELS_OMITTED.md` with the page URL, the published price, and the reason. Short version:

- `jzs-max-3.0` is JZS Token's own model. Standard list price is input 0.0777, output 0.3886, cache read 0.0078, cache write 0.0777 per 1M, context 1M, image input supported. It is free until 2026-11-30 UTC and needs a dedicated key. The page does not publish maximum output tokens or tools, reasoning, temperature, top_p, or top_k. There is no lab file to inherit from, and provider models without `base_model` require `limit.output`. The schema has no notes field, so the promotion is not stored and the price is not written as $0. Omitted.
- `kimi-k2.8` still has no `models/moonshotai/kimi-k2.8.toml` (only `kimi-k2.8-preview`) and the page still publishes no output limit. Same skip as #12067.
- `kimi-k2.7`, `claude-opus-4-7-max`, `MiniMax-M3-highspeed`, `MiniMax-M3.1`, and `naive-n0.5-flash` have no matching lab file. Nearby ids are different models.
- `gpt-image-2-4k`, `gpt-image-2.5`, and `gpt-image-2.6` have no lab file. Flare and sunburst variants that do have lab files are included under those ids.
- Every `nano-banana-*` SKU is omitted. The pages do not name an upstream model id, and several SKUs have different per-image prices. `google/gemini-nano-banana-2.1` is named Nano Banana 2.1, but that mapping is not on the JZSTOKEN page.
- `minimax-h3`, `agnes-video-2.5`, and `wan-3.0` are per-second video prices by resolution. The page does not name the resolution that applies when resolution is omitted, so there is no honest base price. `wan-3.0` is labeled Other, not Alibaba, so it is not mapped to `alibaba/wan3.0-video`. The inventory called `minimax-h3` an image model; the detail page is video.

## Evidence

- Catalog: https://jzstoken.com/model-pricing (78 model links, fetched 2026-11-20)
- One detail page per id: https://jzstoken.com/model-pricing/<id>
- Chat: `POST https://jzstoken.com/api/v1/chat/completions`
- Images: `POST https://jzstoken.com/api/v1/images/generations`
- Video (omitted): `POST https://jzstoken.com/api/v1/videos`
- Prices are the standard list prices on the detail page. Agent discounts are not used.
- `grok-4.5` and `grok-4.6` publish cache read 0.4858 and cache write 0.3886, with input 0.3886. Cache read is higher than input. Both are recorded as published, not swapped. `grok-4.7` is the usual shape (read 0.0389, write 0.4858).
- `claude-opus-4-5-20251101` publishes cache read 0.0155 against input 1.55. Recorded as published.

## Policy caveats

- No output limit, capability, or promotional price was invented. Where the page says maximum output tokens, rate limits, streaming, tool calling, and structured output are unpublished, those fields were not filled in. New files inherit lab limits and only override context or input when the page publishes a different window and the inherited input or output would not fit.
- Reasoning controls on new files are the upstream lab provider's controls (the wire comment cites that file). JZSTOKEN does not document a per-model reasoning parameter. Existing JZSTOKEN files keep the controls from #12067.
- `glm-5.2` uses generic `image` because the page says image input is supported and does not list a MIME type. `bun run v1:check` reports that file under generic modalities.
- This changes published v1 data: 30 text models added, 3 removed, and the price and limit edits above. It does not add modalities, fields, or enum values to the v1 schema. Image models stay out of v1 via `v2_only`. A maintainer needs to accept the v1 data change.

## Validation

`bun validate` passes.

`bun run v1:check` against `dd792002b` exits 1 because v1 data changed, which is the expected report for this catalog update. It lists 30 models added to v1, 3 removed, the price and limit edits above, and `providers/jzstoken/models/glm-5.2.toml` for a generic `image` modality. It does not report a new v1 field or enum value.
