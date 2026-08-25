# SCNet reasoning probe

- Timestamp (UTC): `2026-08-25T15:44:13.239185+00:00`
- Endpoint: `https://api.scnet.cn/api/llm/v1/chat/completions`
- Authentication: `SCNET_API_KEY` (value omitted)
- Result: every request returned HTTP `402` (`Insufficient Balance`), so this run cannot establish whether any reasoning parameter is accepted or observable.

| Model | Case | HTTP | Accepted | Error | Reasoning fields |
| --- | --- | ---: | :---: | --- | --- |
| `Kimi-K3` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K3` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `Kimi-K2.5` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `GLM-5` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `MiMo-V2.5-Pro` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `MiniMax-M3` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `DeepSeek-V4-Flash` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `none` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `enable_thinking=false` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `enable_thinking=true` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `reasoning_effort=low` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `reasoning_effort=high` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `reasoning_effort=max` | `402` | `` | 402: Insufficient Balance |  |
| `Qwen3-30B-A3B` | `reasoning_effort=invalid` | `402` | `` | 402: Insufficient Balance |  |

HTTP 200 is not treated as proof that a parameter is supported. Compare accepted/rejected values and returned reasoning fields.
