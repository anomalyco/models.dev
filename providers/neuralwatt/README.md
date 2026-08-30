Neuralwatt Models

Energy-aware inference provider offering open-source LLMs with transparent GPU energy reporting.

Provider Details
- API endpoint: https://api.neuralwatt.com/v1
- OpenAI-compatible API
- Environment variable: NEURALWATT_API_KEY
- Documentation: https://portal.neuralwatt.com/docs

Standard Models
- deepseek-v4-flash: DeepSeek V4 Flash, 1M context
- deepseek-v4-pro: DeepSeek V4 Pro, 1M context, private preview
- gemma-4-31b: Gemma 4 31B, image input, 262K context
- glm-5.2: GLM 5.2, 1M context
- glm-5.2-short: GLM 5.2 Short, 200K context, 32K output cap
- glm-5.3: GLM 5.3, 1M context, gated preview
- kimi-k2.7-code: Kimi K2.7 Code, image input, 262K context
- kimi-k3: Kimi K3, image input, 1M context
- qwen-3.8-27b: Qwen 3.8 27B, image input, 262K context, private preview
- qwen3.6-35b: Qwen3.6 35B, image input, 131K context

Fast Variants
Tuned for lower latency. What that means differs per model:
- glm-5.2-fast, glm-5.2-short-fast: reasoning stays available, but defaults off
- kimi-k2.7-code-fast: reasoning capped to a short budget and cannot be disabled
- kimi-k3-fast, qwen3.6-35b-fast: no reasoning

Flex Variants
Discounted, best-effort latency. Requests may be held under load.
- deepseek-v4-flash-flex, glm-5.2-flex, glm-5.2-short-flex,
  glm-5.2-short-fast-flex, kimi-k2.7-code-flex, kimi-k3-flex

Pricing
- Rates come from metadata.pricing on GET /v1/models. Preview models require an
  authenticated request to appear.
- Cached input is published per model as cached_input_per_million. It is 10% of
  the input price on most models, but 20% on deepseek-v4-flash and 55.6% on
  qwen-3.8-27b, so read the field rather than applying a ratio.
- There is no separate cache-write charge.
- Flex is billed at 0.65x the standard rate (35% off), cached input included.
- Flex requires stream = true. Non-streaming requests fall through to the
  standard tier and are billed at standard rates.

Reasoning Controls
- reasoning_effort accepts the levels in metadata.reasoning.supported_efforts.
  Most lists include none, which is the off switch. glm-5.3 is the exception:
  it reports reasoning.mandatory and offers only low, high and max.
- accepted_efforts is wider than supported_efforts. The extra values are
  aliases the API folds into a supported level, not distinct levels.
- thinking_token_budget is accepted on every model except deepseek-v4-flash and
  gemma-4-31b, which reject it with a 400 on the V2 model runner.
- kimi-k2.7-code and its variants expose no effort control, only a budget.

Notes
- Preview models are access-gated and stay out of the public catalog until
  access is granted. See https://portal.neuralwatt.com/docs/guides/preview-models
- Neuralwatt reports real-time energy consumption (Joules/kWh) per request.
- Models that report no max_output_tokens are capped only by their context
  window, and are cataloged with output equal to context.
