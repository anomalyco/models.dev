Neuralwatt Models

Energy-aware inference provider offering open-source LLMs with transparent GPU energy reporting.

Provider Details
- API endpoint: https://api.neuralwatt.com/v1
- OpenAI-compatible API
- Environment variable: NEURALWATT_API_KEY
- Documentation: https://portal.neuralwatt.com/docs

Model Categories

Reasoning Models (with interleaved thinking):
- glm-5.2 — GLM 5.2, reasoning enabled
- glm-5.2-short — GLM 5.2 Short, reasoning enabled
- moonshotai/Kimi-K2.5 — Kimi K2.5, reasoning + image input
- moonshotai/Kimi-K2.6 — Kimi K2.6, reasoning + image input
- moonshotai/Kimi-K2.7-Code — Kimi K2.7 Code, reasoning + image input
- Qwen/Qwen3.5-397B-A17B-FP8 — Qwen3.5 397B, reasoning enabled
- Qwen/Qwen3.6-35B-A3B — Qwen3.6 35B A3B, reasoning enabled

Fast Variants (optimized for speed, non-reasoning):
- glm-5.2-fast — GLM 5.2 Fast
- glm-5.2-short-fast — GLM 5.2 Short Fast
- kimi-k2.5-fast — Kimi K2.5 Fast, image input
- kimi-k2.6-fast — Kimi K2.6 Fast, image input
- qwen3.5-397b-fast — Qwen3.5 397B Fast
- qwen3.6-35b-fast — Qwen3.6 35B Fast

Flex Variants (streaming required, discounted):
- glm-5.2-flex — GLM 5.2 Flex, reasoning enabled
- glm-5.2-short-flex — GLM 5.2 Short Flex, reasoning enabled
- glm-5.2-short-fast-flex — GLM 5.2 Short Fast Flex
- kimi-k2.6-flex — Kimi K2.6 Flex, reasoning + image input
- kimi-k2.7-code-flex — Kimi K2.7 Code Flex, reasoning + image input

Notes
- Standard model IDs, pricing, and limits are sourced directly from the Neuralwatt API; flex pricing applies the official 0.5 docs multiplier to the corresponding standard rates
- Cache reads are billed at 25% of the input token price; there is no separate cache-write charge
- Neuralwatt provides real-time energy consumption data (Joules/kWh) per request
- "Fast" variants are optimized for lower latency without reasoning
- Flex requires streaming; non-streaming requests fall back to the standard tier
- Official Neuralwatt docs currently describe Flex as a 50% token-pricing discount, including cached-input billing
- Vision models support image input via OpenAI-compatible API
