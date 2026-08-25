# SCNet reasoning probe

- Timestamp (UTC): `2026-08-25T15:57:52Z` – `2026-08-25T16:00:20Z`
- Endpoint: `https://api.scnet.cn/api/llm/v1/chat/completions`
- Authentication: `SCNET_API_KEY` (value omitted)
- Requests: `25` (short prompt, `max_tokens=16`)
- First DeepSeek-V4-Flash `reasoning_effort=high` attempt returned `429 Model Request Error`; one retry returned `200` with `reasoning_content`.

| Model | Case | HTTP | Accepted | Error | Reasoning fields |
| --- | --- | ---: | :---: | --- | --- |
| `Kimi-K3` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `Kimi-K3` | `none` | `200` | `True` |  | reasoning_content |
| `Kimi-K3` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `Kimi-K2.5` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `Kimi-K2.5` | `none` | `200` | `True` |  |  |
| `Kimi-K2.5` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `GLM-5` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `GLM-5` | `none` | `200` | `True` |  | reasoning_content |
| `GLM-5` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `MiMo-V2.5-Pro` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `MiMo-V2.5-Pro` | `none` | `200` | `True` |  | reasoning_content |
| `MiMo-V2.5-Pro` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `MiniMax-M3` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `MiniMax-M3` | `none` | `200` | `True` |  | reasoning_content |
| `MiniMax-M3` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `DeepSeek-V4-Flash` | `enable_thinking=false` | `200` | `True` |  |  |
| `DeepSeek-V4-Flash` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `DeepSeek-V4-Flash` | `none` | `200` | `True` |  | reasoning_content |
| `DeepSeek-V4-Flash` | `reasoning_effort=high` | `429` | `` | 429: Model Request Error |  |
| `DeepSeek-V4-Flash` | `reasoning_effort=high` | `200` | `True` |  | reasoning_content |
| `DeepSeek-V4-Flash` | `reasoning_effort=invalid` | `200` | `True` |  | reasoning_content |
| `DeepSeek-V4-Flash` | `reasoning_effort=max` | `200` | `True` |  | reasoning_content |
| `Qwen3-30B-A3B` | `enable_thinking=false` | `200` | `True` |  | reasoning_content |
| `Qwen3-30B-A3B` | `enable_thinking=true` | `200` | `True` |  | reasoning_content |
| `Qwen3-30B-A3B` | `none` | `200` | `True` |  | reasoning_content |

Interpretation:

- `DeepSeek-V4-Flash`: `enable_thinking=false` had no reasoning field; `true`, `reasoning_effort=high`, and `max` returned `reasoning_content`. The invalid value was accepted with the same observable shape as `max`, so it is not advertised as a legal value.
- `Kimi-K3`, `Kimi-K2.5`, `GLM-5`, `MiMo-V2.5-Pro`, and `MiniMax-M3`: tested controls were accepted, but this small probe did not establish a stable caller-visible toggle or effort control; their TOML keeps `reasoning_options = []`.
- `Qwen3-30B-A3B`: both toggle requests were accepted and returned `reasoning_content`; the provider keeps the documented toggle.
- `interleaved.field = "reasoning_content"` is only restored for the seven models whose responses in this probe actually exposed that field. It is not inferred for untested sibling models.

HTTP 200 is not treated as proof that an unknown parameter is supported.
