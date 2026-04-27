Neuralwatt Models

Energy-aware inference provider offering open-source LLMs with transparent GPU energy reporting.

Provider Details
- API endpoint: https://api.neuralwatt.com/v1
- OpenAI-compatible API
- Environment variable: NEURALWATT_API_KEY
- Documentation: https://portal.neuralwatt.com/docs

Model Categories

Reasoning Models (with interleaved thinking):
- zai-org/GLM-5.1-FP8 — GLM 5.1 FP8, reasoning enabled
- moonshotai/Kimi-K2.5 — Kimi K2.5, reasoning + image input
- moonshotai/Kimi-K2.6 — Kimi K2.6, reasoning + image input
- MiniMaxAI/MiniMax-M2.5 — MiniMax M2.5, reasoning enabled
- Qwen/Qwen3.5-397B-A17B-FP8 — Qwen3.5 397B, reasoning enabled
- openai/gpt-oss-20b — GPT OSS 20B, reasoning enabled

Fast Variants (optimized for speed, non-reasoning):
- zai-org/glm-5-fast — GLM 5 Fast
- zai-org/glm-5.1-fast — GLM 5.1 Fast
- moonshotai/kimi-k2.5-fast — Kimi K2.5 Fast
- moonshotai/kimi-k2.6-fast — Kimi K2.6 Fast
- Qwen/qwen3.5-397b-fast — Qwen3.5 397B Fast
- Qwen/qwen3.6-35b-fast — Qwen3.6 35B Fast

Other:
- mistralai/Devstral-Small-2-24B-Instruct-2512 — Devstral Small 2, code-focused
- Qwen/Qwen3.6-35B-A3B — Qwen3.6 35B A3B

Notes
- Pricing is per Neuralwatt's published rates; may differ from upstream providers
- Neuralwatt provides real-time energy consumption data (Joules/kWh) per request
- "Fast" variants are optimized for lower latency but do not produce thinking/reasoning tokens
- Vision models (Kimi K2.5, Kimi K2.6) support image input via OpenAI-compatible API
