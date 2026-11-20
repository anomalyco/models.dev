# Models omitted from this JZSTOKEN catalog draft

Fetched from https://jzstoken.com/model-pricing on 2026-11-20. The catalog page linked 78 models. Detail pages are the source for prices and specs. These models are not in `providers/jzstoken/models/` because a required field is unpublished and there is no lab `base_model` that can be inherited without guessing, or because per-image/per-second billing cannot be represented without inventing a default tier.

The schema has no notes field. Promotions are not stored as `$0`. `jzs-max-3.0` standard list prices are below; the free-until-2026-11-30-UTC promotion and the dedicated-key requirement are not written into a model file.

| ID | Billing | Published price (USD) | Page | Why it was left out |
| --- | --- | --- | --- | --- |
| `jzs-max-3.0` | token | in 0.0777, out 0.3886, cache read 0.0078, cache write 0.0777 per 1M | https://jzstoken.com/model-pricing/jzs-max-3.0 | JZS Token's own model. The page publishes standard list prices, a 1M context, image input, a free-until-2026-11-30-UTC promotion, and a dedicated-key requirement, but it explicitly does not publish maximum output tokens or per-model tool, reasoning, temperature, top_p, or top_k support. A provider file without base_model must include limit.output, and there is no lab model to inherit from. The schema has no notes field for the promotion. Not listed at $0. |
| `kimi-k2.8` | token | in 0.4664, out 2.33, cache read 0.0466, cache write 0.4664 per 1M | https://jzstoken.com/model-pricing/kimi-k2.8 | No lab file models/moonshotai/kimi-k2.8.toml. The only nearby lab model is kimi-k2.8-preview, a different id. The page does not publish maximum output tokens, context, or image input. Same skip as #12067. |
| `kimi-k2.7` | token | in 0.4664, out 2.33, cache read 0.0466, cache write 0.4664 per 1M | https://jzstoken.com/model-pricing/kimi-k2.7 | No lab file for this id. models/moonshotai has kimi-k2.7-code and kimi-k2.7-code-highspeed, which are different models. The page does not publish maximum output tokens. |
| `claude-opus-4-7-max` | token | in 1.17, out 5.83, cache read 0.1166, cache write 1.46 per 1M | https://jzstoken.com/model-pricing/claude-opus-4-7-max | No lab file. Not mapped to anthropic/claude-opus-4-7: the official id is distinct and the page does not publish context, image input, or maximum output tokens. |
| `MiniMax-M3-highspeed` | token | in 0.1555, out 0.7773, cache read 0.0155, cache write 0.0777 per 1M | https://jzstoken.com/model-pricing/MiniMax-M3-highspeed | No lab file models/minimax/MiniMax-M3-highspeed.toml. Not mapped to MiniMax-M3. The page does not publish maximum output tokens. |
| `MiniMax-M3.1` | token | in 0.1555, out 0.7773, cache read 0.0155, cache write 0.1555 per 1M | https://jzstoken.com/model-pricing/MiniMax-M3.1 | No lab file. Nearby files are MiniMax-M3.1-Flash and MiniMax-M3.1-Flash-Preview, which are different ids. The page does not publish maximum output tokens. |
| `naive-n0.5-flash` | token | in 0.0777, out 0.3886, cache read 0.0078, cache write 0.0972 per 1M | https://jzstoken.com/model-pricing/naive-n0.5-flash | Provider is Other. No lab file, and the page does not publish context, image input, output limit, or capabilities. |
| `gpt-image-2-4k` | image | 0.1943 per image | https://jzstoken.com/model-pricing/gpt-image-2-4k | No lab file openai/gpt-image-2-4k. Per-image price is published, but required model metadata is not, and it is not the same id as gpt-image-2. |
| `gpt-image-2.5` | image | 0.0058 per image | https://jzstoken.com/model-pricing/gpt-image-2.5 | No lab file openai/gpt-image-2.5. Flare and sunburst variants exist as separate lab models and are catalogued under their own ids. |
| `gpt-image-2.6` | image | 0.0058 per image | https://jzstoken.com/model-pricing/gpt-image-2.6 | No lab file openai/gpt-image-2.6. Flare and sunburst variants exist as separate lab models and are catalogued under their own ids. |
| `nano-banana-pro` | image | 0.0175 per image | https://jzstoken.com/model-pricing/nano-banana-pro | JZSTOKEN does not name the upstream model id. models.dev has several Gemini image models whose display names include Nano Banana, plus host SKUs nano-banana-pro-cl, nano-banana-pro-vip, and nano-banana-pro-4k-vip at different per-image prices. Not mapped by nickname. |
| `nano-banana-2` | image | 0.0117 per image | https://jzstoken.com/model-pricing/nano-banana-2 | No lab file whose id is nano-banana-2. Sibling SKUs (nano-banana-2-cl, nano-banana-2-2k-cl, nano-banana-2-4k-cl, nano-banana-2.1) have different prices. Upstream id is not on the page. |
| `nano-banana-2.1` | image | 0.0117 per image | https://jzstoken.com/model-pricing/nano-banana-2.1 | The lab model google/gemini-nano-banana-2.1 is named Nano Banana 2.1, but the page never states that upstream id, and other nano-banana-2* SKUs are priced separately. Left unmapped rather than inferred. |
| `nano-banana-2-cl` | image | 0.0583 per image | https://jzstoken.com/model-pricing/nano-banana-2-cl | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `nano-banana-pro-cl` | image | 0.0972 per image | https://jzstoken.com/model-pricing/nano-banana-pro-cl | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `nano-banana-2-2k-cl` | image | 0.0874 per image | https://jzstoken.com/model-pricing/nano-banana-2-2k-cl | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `nano-banana-2-4k-cl` | image | 0.1263 per image | https://jzstoken.com/model-pricing/nano-banana-2-4k-cl | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `nano-banana-pro-vip` | image | 0.0972 per image | https://jzstoken.com/model-pricing/nano-banana-pro-vip | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `nano-banana-pro-4k-vip` | image | 0.1749 per image | https://jzstoken.com/model-pricing/nano-banana-pro-4k-vip | Host SKU. No matching lab id, and the page does not identify the upstream model. |
| `minimax-h3` | second | 480p 0.0097/sec; 768p 0.0136/sec; 1080p 0.0291/sec | https://jzstoken.com/model-pricing/minimax-h3 | Detail page bills per second of video at 480p $0.0097, 768p $0.0136, 1080p $0.0291. The lab model minimax/MiniMax-H3 is the video model, but the page does not say which resolution is the default when resolution is omitted. Cost overrides need that base price, so the tier is not guessed. |
| `agnes-video-2.5` | second | 2k 0.0447/sec; 720p 0.0194/sec; 1080p 0.0330/sec | https://jzstoken.com/model-pricing/agnes-video-2.5 | No lab file. Billed per second of video at 2k $0.0447, 720p $0.0194, 1080p $0.0330, with no published default resolution. Provider is Other. Required video metadata (release date, modalities, output limit) is not on the page. |
| `wan-3.0` | second | 480p 0.0321/sec; 720p 0.0641/sec; 1080p 0.1283/sec | https://jzstoken.com/model-pricing/wan-3.0 | Provider is Other, not Alibaba. Not mapped to alibaba/wan3.0-video. Billed per second at 480p $0.0321, 720p $0.0641, 1080p $0.1283, with no published default resolution. |

## Stale ids removed

These ids are in the current models.dev catalog and their detail pages render "Model not found" (fetched 2026-11-20). They are deleted, not omitted from a live catalog.

| ID | Page |
| --- | --- |
| `deepseek-v4-flash` | https://jzstoken.com/model-pricing/deepseek-v4-flash |
| `deepseek-v4-pro` | https://jzstoken.com/model-pricing/deepseek-v4-pro |
| `deepseek-v4.1-flash` | https://jzstoken.com/model-pricing/deepseek-v4.1-flash |

## Detail-page note

The attached inventory called `minimax-h3` an image model. The detail page bills it per second of video (480p / 768p / 1080p) and says the context window is not applicable because it is a video model. This list follows the detail page.
