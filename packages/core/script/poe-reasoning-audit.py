#!/usr/bin/env python3
"""Live audit: Poe Gemini controls vs this repo's TOML files.

Parts:
  A. Compare live https://api.poe.com/v1/models metadata (thinking_level enum,
     pricing, modalities, context/output limits) against the *resolved* contents of
     providers/poe/models/google/*.toml (base_model merged, same rules as the
     generator: tables deep-merge, arrays/primitives replace, base_model_omit drops).
  B. Wire probes against /v1/chat/completions proving, per bot:
     - extra_body thinking_level is rejected out-of-enum (400, twice in a row)
     - medium is accepted on 3.5-flash-lite / 3.6-flash (-> 200, reasoning_tokens>0)
     - minimal is rejected on 3.7-flash / 3.8-flash (-> 400)
     - medium is rejected on the 3.5-flash peer via thinking_level (-> 400)
     - extra_body reasoning_effort is not a supported bot field (-> 400)
     - top-level reasoning_effort reaches upstream validation (docs say "ignored")
     - thinking_level changes actual reasoning effort (minimal vs high token counts)
     - temperature is type- and range-validated to 0..2 (Poe docs: "Between 0 and 2")
     - Poe's per-bot request-field gate exists (unknown field -> 400) and temperature
       passes it, i.e. temperature is a supported request field, not an ignored one

Usage:  POE_API_KEY=... python3 packages/core/script/poe-reasoning-audit.py
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = "https://api.poe.com/v1"

NEW_BOTS = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-omni-1.1-flash",
]
PEER_BOTS = [
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro",
    "gemini-3.5-flash",
]
BOTS = NEW_BOTS + PEER_BOTS

# Half of the 4-decimal rounding used when writing USD/MTok into TOML files.
COST_TOLERANCE = Decimal("0.00005")

failures: list[str] = []
total = 0


def api_key() -> str:
    if key := os.environ.get("POE_API_KEY"):
        return key
    sys.exit("Set POE_API_KEY")


def check(ok: bool, label: str) -> bool:
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        failures.append(label)
    return ok


def load_toml(rel: str) -> dict:
    import tomllib
    with open(ROOT / rel, "rb") as f:
        return tomllib.load(f)


def deep_merge(base: dict, child: dict) -> dict:
    out = dict(base)
    for key, val in child.items():
        if isinstance(out.get(key), dict) and isinstance(val, dict):
            out[key] = deep_merge(out[key], val)
        else:
            out[key] = val
    return out


def omit_path(doc: dict, path: str) -> None:
    parts = path.split(".")
    node = doc
    for part in parts[:-1]:
        node = node.get(part)
        if not isinstance(node, dict):
            return
    node.pop(parts[-1], None)


def load_resolved(rel: str) -> dict:
    """Load a provider TOML with its base_model chain merged in (AGENTS merge rules)."""
    doc = load_toml(rel)
    base = doc.pop("base_model", None)
    omit = doc.pop("base_model_omit", None)
    if base:
        doc = deep_merge(load_resolved(f"models/{base}.toml"), doc)
    for path in omit or []:
        omit_path(doc, path)
    return doc


def bot_toml_path(bot: str) -> str:
    return f"providers/poe/models/google/{bot}.toml"


def thinking_level_enum(bot_meta: dict) -> list[str] | None:
    for p in bot_meta.get("parameters") or []:
        if p.get("name") == "thinking_level":
            return list((p.get("schema") or {}).get("enum") or [])
    return None


def effort_values(resolved: dict) -> list[str]:
    for opt in resolved.get("reasoning_options") or []:
        if opt.get("type") == "effort":
            return list(opt.get("values") or [])
    return []


def usd_per_mtok(price_str: str | None) -> Decimal | None:
    if price_str is None:
        return None
    return Decimal(price_str) * Decimal(1_000_000)


def part_a(models: dict[str, dict]) -> None:
    print("== Part A: live /v1/models vs resolved repo TOML ==")
    for bot in BOTS:
        meta = models.get(bot)
        if not check(meta is not None, f"{bot}: present in live /v1/models"):
            continue
        resolved = load_resolved(bot_toml_path(bot))

        live_enum = thinking_level_enum(meta)
        toml_vals = effort_values(resolved)
        if live_enum is None:
            check(toml_vals == [],
                  f"{bot}: no thinking_level live and no effort in TOML (got {toml_vals})")
        else:
            check(live_enum == toml_vals,
                  f"{bot}: effort enum live={live_enum} toml={toml_vals}")

        if resolved.get("reasoning"):
            check("reasoning_options" in resolved,
                  f"{bot}: reasoning=true => reasoning_options authored")
        else:
            check("reasoning_options" not in resolved,
                  f"{bot}: reasoning=false => no reasoning_options")

        pricing = meta.get("pricing") or {}
        cost = resolved.get("cost") or {}
        for live_key, toml_key in [("prompt", "input"), ("completion", "output"),
                                   ("input_cache_read", "cache_read")]:
            live_val = usd_per_mtok(pricing.get(live_key))
            toml_val = cost.get(toml_key)
            if live_val is None:
                check(toml_val is None, f"{bot}: cost.{toml_key} absent live and in TOML")
            else:
                ok = toml_val is not None and abs(
                    Decimal(str(toml_val)) - live_val) <= COST_TOLERANCE
                check(ok, f"{bot}: cost.{toml_key} live={live_val:.4f} toml={toml_val}"
                          f" (tol {COST_TOLERANCE})")

        arch = meta.get("architecture") or {}
        modality = resolved.get("modalities") or {}
        for side, live_vals, toml_vals2 in [
            ("input", arch.get("input_modalities"), modality.get("input")),
            ("output", arch.get("output_modalities"), modality.get("output")),
        ]:
            if live_vals is None:
                continue
            live_set = sorted(set(live_vals))
            toml_set = sorted(set(toml_vals2 or []))
            check(live_set == toml_set,
                  f"{bot}: modalities.{side} resolved={toml_set} live={live_set}")

        ctx = (meta.get("context_window") or {}).get("context_length")
        if ctx is None:
            ctx = meta.get("context_length")
        if ctx is not None:
            toml_ctx = (resolved.get("limit") or {}).get("context")
            check(toml_ctx == ctx,
                  f"{bot}: limit.context resolved={toml_ctx} live={ctx}")

        max_out = (meta.get("context_window") or {}).get("max_output_tokens")
        if max_out is not None:
            toml_out = (resolved.get("limit") or {}).get("output")
            check(toml_out == max_out,
                  f"{bot}: limit.output resolved={toml_out} live={max_out}")


def chat(key: str, model: str, extra: dict | None = None, top_level: dict | None = None,
         prompt: str = "Say hi.", max_tokens: int = 50) -> tuple[int, dict]:
    body: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }
    if extra is not None:
        body["extra_body"] = extra
    if top_level:
        body.update(top_level)
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def reasoning_tokens(resp: dict) -> int | None:
    details = (resp.get("usage") or {}).get("completion_tokens_details") or {}
    return details.get("reasoning_tokens")


def probe(key: str, label: str, model: str, expect_status: int, extra: dict | None = None,
          top_level: dict | None = None, err_contains: str | None = None,
          runs: int = 1, prompt: str = "Say hi.", max_tokens: int = 50) -> list[dict]:
    """Run a request `runs` times; every run must match status (and error substring)."""
    responses = []
    for _ in range(runs):
        status, resp = chat(key, model, extra=extra, top_level=top_level,
                            prompt=prompt, max_tokens=max_tokens)
        responses.append(resp)
        err = (resp.get("error") or {}).get("message") or ""
        detail = (f"err={err!r}" if status != 200
                  else f"reasoning_tokens={reasoning_tokens(resp)}")
        ok = status == expect_status and (err_contains is None or err_contains in err)
        check(ok, f"{label} [{detail}]")
    return responses


def part_b(key: str) -> None:
    print("== Part B: live wire probes (/v1/chat/completions) ==")
    probe(key, "tlevel=banana on 3.6 -> 400", "gemini-3.6-flash", 400,
          extra={"web_search": False, "thinking_level": "banana"}, runs=2)
    probe(key, "tlevel=medium on 3.6 -> 200 with reasoning", "gemini-3.6-flash", 200,
          extra={"web_search": False, "thinking_level": "medium"})
    probe(key, "tlevel=medium on 3.5-flash-lite -> 200", "gemini-3.5-flash-lite", 200,
          extra={"web_search": False, "thinking_level": "medium"})
    probe(key, "tlevel=minimal on 3.7 -> 400 (absent from enum)", "gemini-3.7-flash", 400,
          extra={"web_search": False, "thinking_level": "minimal"}, runs=2)
    probe(key, "tlevel=minimal on 3.8 -> 400 (absent from enum)", "gemini-3.8-flash", 400,
          extra={"web_search": False, "thinking_level": "minimal"}, runs=2)
    probe(key, "tlevel=medium on 3.5-flash peer -> 400 (absent from enum)", "gemini-3.5-flash", 400,
          extra={"web_search": False, "thinking_level": "medium"})
    probe(key, "extra_body reasoning_effort=high -> 400 unsupported field", "gemini-3.6-flash", 400,
          extra={"web_search": False, "reasoning_effort": "high"},
          err_contains="does not support these request fields")
    probe(key, "top-level reasoning_effort=banana on 3.6 -> 400 (reaches upstream)",
          "gemini-3.6-flash", 400, top_level={"reasoning_effort": "banana"}, runs=2)
    probe(key, "top-level reasoning_effort=minimal on 3.7 -> 400 (per-bot upstream)",
          "gemini-3.7-flash", 400, top_level={"reasoning_effort": "minimal"}, runs=2)
    probe(key, "top-level reasoning_effort=minimal on 3.6 -> 200", "gemini-3.6-flash", 200,
          top_level={"reasoning_effort": "minimal"})
    probe(key, "top-level reasoning_effort=medium on 3.5-flash -> 200 (wider than tlevel enum)",
          "gemini-3.5-flash", 200, top_level={"reasoning_effort": "medium"})

    print("  -- temperature: documented by Poe as 'Between 0 and 2 (inclusive)' --")
    probe(key, "temp=99 on 3.6 -> 400 (range 0..2 enforced)", "gemini-3.6-flash", 400,
          top_level={"temperature": 99}, err_contains="Expected a value <= 2.0", runs=2)
    probe(key, "temp=-1 on 3.6 -> 400 (range 0..2 enforced)", "gemini-3.6-flash", 400,
          top_level={"temperature": -1}, err_contains="Expected a value >= 0", runs=2)
    probe(key, "temp='banana' on 3.6 -> 400 (must be a number)", "gemini-3.6-flash", 400,
          top_level={"temperature": "banana"}, err_contains="Invalid 'temperature'", runs=2)
    probe(key, "temp=2.0 on 3.6 -> 200 (upper bound accepted)", "gemini-3.6-flash", 200,
          top_level={"temperature": 2.0})
    probe(key, "temp=99 on 3.5-flash -> 400 (same gate on a peer)", "gemini-3.5-flash", 400,
          top_level={"temperature": 99}, err_contains="Expected a value <= 2.0")
    probe(key, "unknown field foo_bar -> 400 per-bot field gate", "gemini-3.6-flash", 400,
          top_level={"foo_bar": "baz"},
          err_contains="does not support these request fields")

    print("  -- effect check: thinking_level changes reasoning effort on 3.6-flash --")
    math = "What is 17*23? Reason step by step."
    lows = [reasoning_tokens(r) for r in probe(
        key, "tlevel=minimal, math prompt", "gemini-3.6-flash", 200,
        extra={"web_search": False, "thinking_level": "minimal"},
        prompt=math, max_tokens=2000, runs=2)]
    highs = [reasoning_tokens(r) for r in probe(
        key, "tlevel=high, math prompt", "gemini-3.6-flash", 200,
        extra={"web_search": False, "thinking_level": "high"},
        prompt=math, max_tokens=2000, runs=2)]
    lo = [v for v in lows if v is not None]
    hi = [v for v in highs if v is not None]
    check(bool(lo) and bool(hi) and min(hi) > max(lo),
          f"reasoning_tokens scale with level: minimal={lo} high={hi}")


def main() -> None:
    key = api_key()
    req = urllib.request.Request(f"{BASE}/models",
                                 headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = json.loads(r.read())["data"]
    models = {m["id"]: m for m in raw}

    part_a(models)
    part_b(key)

    print(f"== {total - len(failures)}/{total} checks passed"
          f"{'' if not failures else f'; {len(failures)} FAILURE(S)'} ==")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
