#!/usr/bin/env python3
"""Generate missing TOML model files for nano-gpt provider from the live API.

Usage: python3 scripts/generate-nanogpt-models.py [--dry-run] [--output DIR]
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://nano-gpt.com/api/v1/models?detailed=true"
MODELS_DIR = Path("providers/nano-gpt/models")


def fetch_models():
    print(f"Fetching {API_URL} ...", file=sys.stderr)
    with urllib.request.urlopen(API_URL) as resp:
        data = json.loads(resp.read().decode())
    return data.get("data", [])


def local_model_ids():
    ids = set()
    for root, _dirs, files in os.walk(MODELS_DIR):
        for f in files:
            if f.endswith(".toml"):
                rel = os.path.relpath(os.path.join(root, f), MODELS_DIR)
                ids.add(rel[:-5])  # strip .toml
    return ids


def ts_to_date(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def round_cost(v):
    """Round pricing to avoid floating-point artifacts like 0.27999999999999997."""
    return round(v, 6)


def build_modalities_input(api):
    mods = list(api.get("architecture", {}).get("input_modalities", ["text"]))
    caps = api.get("capabilities", {})
    if caps.get("pdf_upload") and "pdf" not in mods:
        mods.append("pdf")
    if caps.get("audio_input") and "audio" not in mods:
        mods.append("audio")
    return mods


def toml_str(v):
    """Format a value for TOML output."""
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # Trim trailing zeros after rounding; always at least one decimal
        s = f"{v:.6f}".rstrip("0")
        if s.endswith("."):
            s += "0"
        return s
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, list):
        items = ", ".join(toml_str(x) for x in v)
        return f"[{items}]"
    return str(v)


def generate_toml(api):
    caps = api.get("capabilities", {})
    pricing = api.get("pricing", {})
    sub = api.get("subscription", {})

    lines = []

    # Subscription note
    note = sub.get("note", "")
    multiplier = sub.get("inputTokenMultiplier", 1)
    if multiplier > 1 and f"(uses {multiplier}x" not in note:
        note = f"{note} (uses {multiplier}x input tokens)"
    lines.append(f"# {note}")

    lines.append(f"name = {toml_str(api['name'])}")

    created = api.get("created")
    if created is not None:
        date = ts_to_date(created)
        lines.append(f"release_date = {toml_str(date)}")
        lines.append(f"last_updated = {toml_str(date)}")

    attachment = caps.get("vision", False) or caps.get("pdf_upload", False)
    lines.append(f"attachment = {toml_str(attachment)}")
    lines.append(f"reasoning = {toml_str(caps.get('reasoning', False))}")
    lines.append(f"tool_call = {toml_str(caps.get('tool_calling', False))}")
    lines.append(f"structured_output = {toml_str(caps.get('structured_output', False))}")
    lines.append(f"open_weights = false")

    lines.append("")
    lines.append("[cost]")
    # Some models (e.g. multi-modal "varies_by_modality" pricing) have prompt/completion
    # explicitly set to null. Fall back to 0; the schema requires numeric values here.
    prompt = pricing.get("prompt") or 0
    completion = pricing.get("completion") or 0
    lines.append(f"input = {toml_str(round_cost(prompt))}")
    lines.append(f"output = {toml_str(round_cost(completion))}")
    cache = pricing.get("cacheReadInputPer1kTokens")
    if cache is not None:
        # API provides per-1K tokens; TOML expects per-1M tokens
        lines.append(f"cache_read = {toml_str(round_cost(cache * 1000))}")

    ctx = api.get("context_length")
    if ctx is None:
        ctx = 128_000
    max_out = api.get("max_output_tokens")
    if max_out is None:
        max_out = 16_384

    lines.append("")
    lines.append("[limit]")
    lines.append(f"context = {ctx}")
    lines.append(f"input = {ctx}")
    lines.append(f"output = {max_out}")

    lines.append("")
    lines.append("[modalities]")
    lines.append(f"input = {toml_str(build_modalities_input(api))}")
    lines.append(f"output = {toml_str(api.get('architecture', {}).get('output_modalities', ['text']))}")

    lines.append("")
    return "\n".join(lines)


def main():
    dry_run = "--dry-run" in sys.argv
    out_dir = None
    for i, arg in enumerate(sys.argv):
        if arg == "--output" and i + 1 < len(sys.argv):
            out_dir = Path(sys.argv[i + 1])
            break

    models = fetch_models()
    existing = local_model_ids()
    # Case-insensitive index for macOS/Windows compatibility where the filesystem
    # merges NousResearch/ and nousresearch/ into the same directory.
    existing_lower = {e.lower() for e in existing}

    added = 0
    skipped_existing = 0

    for api in sorted(models, key=lambda m: m["id"]):
        model_id = api["id"]
        if model_id in existing or model_id.lower() in existing_lower:
            skipped_existing += 1
            continue

        toml = generate_toml(api)
        rel_path = model_id + ".toml"
        target = out_dir / rel_path if out_dir else MODELS_DIR / rel_path

        if dry_run:
            print(f"\n# --- {rel_path} ---")
            print(toml)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(toml)
            print(f"  Wrote: {rel_path}")
        added += 1

    msg = f"\nDone. Created {added} files. Skipped {skipped_existing} already-existing."
    print(msg if not dry_run else msg.replace("Created", "Would create"), file=sys.stderr)


if __name__ == "__main__":
    main()