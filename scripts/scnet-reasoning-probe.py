#!/usr/bin/env python3
"""Probe SCNet's OpenAI-compatible reasoning controls.

The script intentionally records only response metadata and never writes the
API key or request headers.  Set SCNET_API_KEY in the environment before use.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_MODELS = [
    "Kimi-K3",
    "Kimi-K2.5",
    "GLM-5",
    "MiMo-V2.5-Pro",
    "MiniMax-M3",
    "DeepSeek-V4-Flash",
    "Qwen3-30B-A3B",
]

CASES: list[tuple[str, dict[str, Any]]] = [
    ("none", {}),
    ("enable_thinking=false", {"enable_thinking": False}),
    ("enable_thinking=true", {"enable_thinking": True}),
    ("reasoning_effort=low", {"reasoning_effort": "low"}),
    ("reasoning_effort=high", {"reasoning_effort": "high"}),
    ("reasoning_effort=max", {"reasoning_effort": "max"}),
    ("reasoning_effort=invalid", {"reasoning_effort": "invalid"}),
]


def compact_error(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        code = value.get("code")
        message = value.get("message") or value.get("detail") or value
        return f"{code}: {message}" if code is not None else str(message)
    return str(value)


def summarize_response(status: int, body: bytes) -> dict[str, Any]:
    result: dict[str, Any] = {"http_status": status}
    try:
        payload = json.loads(body.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        result["parse_error"] = True
        result["body_prefix"] = body.decode("utf-8", errors="replace")[:300]
        return result

    if isinstance(payload, dict) and payload.get("error") is not None:
        result["error"] = compact_error(payload["error"])
        return result

    result["accepted"] = status == 200
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if isinstance(usage, dict):
        result["usage"] = {
            key: usage[key]
            for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            if key in usage
        }

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        result["response_shape"] = "no_choices"
        return result

    message = choices[0].get("message", {})
    if not isinstance(message, dict):
        result["response_shape"] = "invalid_message"
        return result
    content = message.get("content")
    result["content_length"] = len(content) if isinstance(content, str) else None
    reasoning_keys = [
        key
        for key in ("reasoning_content", "reasoning", "thinking", "reasoning_details")
        if message.get(key) not in (None, "", [], {})
    ]
    result["reasoning_fields"] = reasoning_keys
    result["finish_reason"] = choices[0].get("finish_reason")
    return result


def request(
    endpoint: str, api_key: str, model: str, parameters: dict[str, Any]
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 16,
        **parameters,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return summarize_response(response.status, response.read())
    except urllib.error.HTTPError as exc:
        return summarize_response(exc.code, exc.read())
    except urllib.error.URLError as exc:
        return {"http_status": None, "transport_error": str(exc.reason)}
    except TimeoutError:
        return {"http_status": None, "transport_error": "timeout"}


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# SCNet reasoning probe",
        "",
        f"- Timestamp (UTC): `{report['timestamp']}`",
        f"- Endpoint: `{report['endpoint']}`",
        "- Authentication: `SCNET_API_KEY` (value omitted)",
        "",
        "| Model | Case | HTTP | Accepted | Error | Reasoning fields |",
        "| --- | --- | ---: | :---: | --- | --- |",
    ]
    for model in report["models"]:
        for case in model["cases"]:
            status = case.get("http_status", "")
            error = case.get("error") or case.get("transport_error") or ""
            fields = ", ".join(case.get("reasoning_fields", []))
            accepted = case.get("accepted", "")
            lines.append(
                f"| `{model['model']}` | `{case['case']}` | `{status}` | "
                f"`{accepted}` | {error} | {fields} |"
            )
    lines += [
        "",
        "HTTP 200 is not treated as proof that a parameter is supported. "
        "Compare accepted/rejected values and returned reasoning fields.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument(
        "--case", action="append", choices=[name for name, _ in CASES],
        help="Run only selected case names; repeat for multiple cases.",
    )
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--md-out", type=Path)
    args = parser.parse_args()

    api_key = os.environ.get("SCNET_API_KEY")
    if not api_key:
        print("SCNET_API_KEY is not set", file=sys.stderr)
        return 2
    base = os.environ.get("SCNET_API_BASE_URL", "https://api.scnet.cn/api/llm/v1")
    endpoint = base.rstrip("/") + "/chat/completions"
    models = args.models or DEFAULT_MODELS
    selected_cases = [
        case for case in CASES if not args.case or case[0] in args.case
    ]

    report: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "endpoint": endpoint,
        "models": [],
    }
    for model in models:
        entry = {"model": model, "cases": []}
        for case_name, parameters in selected_cases:
            result = request(endpoint, api_key, model, parameters)
            result["case"] = case_name
            entry["cases"].append(result)
        report["models"].append(entry)

    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(encoded, encoding="utf-8")
    if args.md_out:
        args.md_out.parent.mkdir(parents=True, exist_ok=True)
        args.md_out.write_text(markdown(report), encoding="utf-8")
    if not args.json_out and not args.md_out:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
