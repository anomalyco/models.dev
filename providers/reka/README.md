# Reka API catalog notes

Checked on 2026-09-22. These entries describe Reka's direct OpenAI-compatible `https://api.reka.ai/v1/chat/completions` endpoint, authenticated with a Reka key. Third-party checkpoints hosted by Reka can expose different controls from the original lab. Qwen 3.6/3.7 and MiniMax use upstream adapters; their controls also depend on that adapter.

## Sources and limits

- [Setup](https://docs.reka.ai/quickstart): endpoint and authentication.
- [Public catalog](https://inference.api.reka.ai/v1/site/models?capability=chat):
  IDs, direct prices, advertised context/output limits and modalities. In `data[]`, match `model_id`, then read `pricing.token_bands`; divide `input_cents_per_mtok` and `output_cents_per_mtok` by 100 for USD/MTok.
- [Integration feed](https://api.reka.ai/v1/integrations/openrouter/models):
  checkpoint identities. Its channel-specific discounts are not direct API prices.

The catalog advertises Qwen 27B at context 262144/output 131072, DeepSeek V4 at 262144/131072, and Qwen 3.7 Max at context 262144 with no output override. These are provider-specific values, not the lab entries' limits. The public catalog lists `supports_reasoning: false` for Qwen 27B as a channel forwarding policy, while its editorial text says “Toggleable thinking”; this entry follows the probed served behavior.

Some active handlers impose lower hard output ceilings than the public catalog: DeepSeek V4 43200, GLM 5.3 69000 and GLM 5.3 Flash 15000. These are not defaults: the affected handlers clamp larger requests. The entries use the ceiling supported across active backends. This is based on operator inspection of live backend configuration and serving code; no maximum-length generation test was run. The public catalog lists larger values; these entries use the smaller enforced ceiling. These operational ceilings were checked on 2026-09-22 and may change.

## Reasoning controls

| Route | Wire fields | Evidence |
| --- | --- | --- |
| DeepSeek V4 Flash | `chat_template_kwargs.thinking` plus `reasoning_effort=low/high/max` | On/off produced or suppressed reasoning; all efforts accepted across active backend types; graded quality was not benchmarked. |
| GLM 5.3 | `reasoning_effort=low/high/max` | Serving template maps these levels and has no off branch. |
| GLM 5.3 Flash | `reasoning_effort=none/low/high/max` | Reka's patched template supports `none`; paired public API probes below. |
| Qwen 3.8 27B | `reasoning_effort=none/low/medium/xhigh`; `thinking_token_budget` | Paired probes, including both controls together, below. |
| Qwen 3.6/3.7 | `enable_thinking`; `thinking_budget` | Alibaba adapter forwards these fields. Qwen 3.6 Max needs `enable_thinking=false` for forced tool choice. |
| MiniMax M3 | No caller reasoning control through this OpenAI route | Request adapter constructs a Messages payload without reasoning-control fields; see transformation record below. |
| Reka Flash 3 | No caller reasoning control | [Native checkpoint template](https://huggingface.co/RekaAI/reka-flash-3.1/blob/main/tokenizer_config.json) has no effort/toggle/budget branches; serving uses this template. Generic vLLM validation accepts low/medium/high but they have no effect on this non-Harmony model; `none` returns HTTP 400. |

DeepSeek V4 and Qwen 27B default to thinking off when no reasoning signal is supplied. GLM Flash defaults to thinking on. MiniMax uses the upstream default; its state is not caller-controllable through this route. For Qwen 27B, `chat_template_kwargs.enable_thinking` also works as a binary switch. Its models.dev entry represents the off state through effort `none` without a duplicate toggle. No budget bounds are authored because none were verified. The native Alibaba field `thinking_budget` is not claimed for this self-hosted route.

The `reka-flash-3` API alias currently serves the [Reka Flash 3.1 checkpoint](https://huggingface.co/RekaAI/reka-flash-3.1). Its dates refer to the [July 10, 2025 announcement](https://reka.ai/labs/research/reinforcement-learning-for-reka-flash-3-1). Responses expose `reasoning_content`; a knowledge cutoff is not asserted.

## Reproduce the public API probes

Set `REKA_API_KEY` in your environment. These are small billable requests. Run the following Python 3 snippet, changing `model`, `prompt` and `options` to one of the cases below. It reads the key only from the environment and prints only response statistics and the final answer, never credentials or raw reasoning.

```python
import json, os, urllib.request
model = "qwen3.8-27b"
prompt = "What is 17 times 23? Reply with the number."
options = {"reasoning_effort": "low", "thinking_token_budget": 256}
body = {"model": model, "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1024, "stream": False, **options}
req = urllib.request.Request(
    "https://api.reka.ai/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Authorization": "Bearer " + os.environ["REKA_API_KEY"],
             "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=60) as response:
    result = json.load(response)
choice = result["choices"][0]
message = choice["message"]
print(json.dumps({"finish_reason": choice.get("finish_reason"),
                  "content": message.get("content"),
                  "reasoning_chars": len(message.get("reasoning_content") or message.get("reasoning") or ""),
                  "usage": result.get("usage")}, indent=2))
```

Observed results (counts are observations, not deterministic assertions):

| Model/options | Prompt tokens | Reported reasoning tokens | Reasoning chars | Final answer |
| --- | ---: | ---: | ---: | --- |
| Qwen 27B, effort `none` | 27 | 0 | 0 | 391 |
| Qwen 27B, effort `low` | 55 | 51 | 85 | 391 |
| Qwen 27B, effort `medium` | 25 | 36 | 44 | 391 |
| Qwen 27B, effort `xhigh` | 67 | 42 | 122 | 391 |
| Qwen 27B, effort `low`, budget 1 | 55 | 0 | 0 | 391 |
| Qwen 27B, effort `low`, budget 256 | 55 | 51 | 85 | 391 |

DeepSeek V4 `reasoning_effort=low/high/max` probes each returned HTTP 200, final content `391`, and reasoning character counts 40/54/108 on the backend with the smaller output ceiling. The same arithmetic prompt was used.

All returned HTTP 200 and `finish_reason=stop`. Graded effort changes the serving template; these tiny prompts are not a benchmark of effort quality.

For GLM Flash use the prompt: `A shop has 17 boxes of 23 pencils, gives away 48 pencils, then splits the remainder equally among 7 classrooms. How many pencils per classroom? Answer with the number.` Set `temperature=0` in options.

| Options | Prompt tokens | Completion tokens | Reasoning chars | Final content |
| --- | ---: | ---: | ---: | --- |
| effort `none` | 44 | 33 | 0 | Arithmetic ending in 49 |
| effort `low` | 50 | 18 | 21 | 49 |

Both returned HTTP 200 and `stop`. The off mode avoids the reasoning channel; it does not prohibit explanatory text in the final answer.

## MiniMax adapter boundary

The reasoning fields do not reach MiniMax's native Messages API. A local execution of the production adapter function with this synthetic input:

```json
{"model":"minimax-m3","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":128,"thinking":{"type":"enabled","budget_tokens":1024},"reasoning":{"enabled":true,"effort":"high"},"reasoning_effort":"high","thinking_budget":1024,"enable_thinking":true}
```

produced exactly:

```json
{"model":"minimax-m3","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":128}
```

The absence of controls is based on the adapter's allowlist. The implementation is private; this transformation record is contributor-provided implementation evidence. Upstream defaults are used; the adapter also omits returned thinking blocks. This does not claim MiniMax's native API lacks a thinking toggle.
