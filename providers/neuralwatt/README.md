Neuralwatt Models

Energy-aware inference provider offering open-source LLMs with transparent GPU energy reporting.

Provider Details
- API endpoint: https://api.neuralwatt.com/v1
- OpenAI-compatible API
- Environment variable: NEURALWATT_API_KEY
- Documentation: https://portal.neuralwatt.com/docs

Available Models

Use [GET /v1/models](https://api.neuralwatt.com/v1/models) for current model
IDs, limits, prices, and capabilities. The [model files](models/) contain
the catalog entries. Check each variant's metadata for its controls and limits.

Public and authenticated responses both listed the same 23 models with
identical model metadata on 2026-11-12. Other accounts may have private grants.

Pricing

- Rates come from metadata.pricing on GET /v1/models, in USD per million tokens.
- Read cached_input_per_million directly; cache discounts vary by model.
- There is no separate cache-write charge.
- Flex prices from the endpoint already include the discount. Do not apply
  flex_discount_multiplier again.
- Flex requires stream = true. Non-streaming requests fall through to the
  standard tier and are billed at standard rates.

Reasoning Controls

- reasoning_effort accepts the levels in metadata.reasoning.supported_efforts.
  Where listed, none disables reasoning.
- accepted_efforts is wider than supported_efforts. The extra values are
  aliases the API folds into a supported level, not distinct levels.
- Check the model file's reasoning controls and source notes before using
  thinking_token_budget. Support depends on the served model.

Notes

- Neuralwatt reports real-time energy consumption (Joules/kWh) per request.
- A null max_output_tokens does not establish the host's output cap.
  Sync keeps the existing output limit or uses the lab limit as a fallback.
