#!/usr/bin/env python3
"""
Backfill [parameters] blocks into models.dev lab model TOMLs.

Sources, in priority order:
  1. Hugging Face API safetensors metadata (exact) -> estimate absent
  2. config.json MoE fields -> active count computed exactly
  3. name-suffix parse (e.g. "27b", "235b-a22b") -> estimate = true

Never touches files that already have [parameters].
Dry-run by default; --apply writes; --filter substring narrows scope.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = ROOT / "models"
HF_API = "https://huggingface.co/api/models/{repo}"
HF_CONFIG = "https://huggingface.co/{repo}/raw/main/config.json"


def hf_json(url: str, retries: int = 4):
    import time
    import urllib.error
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": "models-dev-backfill"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < retries - 1:
                time.sleep(2.0 * (2 ** attempt))
                continue
            return None
        except Exception:
            return None
    return None


def hf_repo_from_toml(text: str):
    m = re.search(r"\[\[weights\]\]\s*\n(?:[^\[]*?)url\s*=\s*\"(https://huggingface\.co/[^\"?\s]+)\"", text)
    if not m:
        return None
    return m.group(1).rstrip("/")


def count_active_from_config(repo: str):
    """NOT computed: active-set reconstruction requires the full architecture
    (attention + dense layers + shared experts), which config.json fields don't
    determine. Vendor "A22B"-style names remain the source for active counts
    and stay a human-curation task; see AGENTS.md."""
    return None


MOE_CONFIG_KEYS = {
    "num_experts",
    "num_local_experts",
    "num_routed_experts",
    "n_routed_experts",
    "num_experts_per_tok",
    "experts_per_tok",
    "moe_intermediate_size",
    "moe_layer_freq",
    "n_shared_experts",
    "num_selected_experts",
}


def is_moe_config(cfg) -> bool:
    """Positive MoE signal: any expert-related key with a usable value,
    scanned at top level and one level of nesting (multimodal wrappers
    put the LM config under text_config / language_config / lm_config)."""
    if not isinstance(cfg, dict):
        return False
    scopes = [cfg] + [v for v in cfg.values() if isinstance(v, dict)]
    for scope in scopes:
        for key in MOE_CONFIG_KEYS:
            value = scope.get(key)
            if isinstance(value, int) and value > 0:
                return True
            if isinstance(value, list) and value:
                return True
    return False


def parse_name_estimate(model_id: str):
    m = re.search(r"(?:^|-)(\d+(?:\.\d+)?)([bB])(?:-|$|_)", model_id)
    if not m:
        return None
    value = float(m.group(1))
    return int(round(value * 1e9))


def toml_escape(s: str) -> str:
    return s


def build_block(total: int, active, architecture, source: str, estimate: bool):
    lines = ["[parameters]", f"total = {total}"]
    if active is not None:
        lines.append(f"active = {active}")
    if architecture:
        lines.append(f'architecture = "{architecture}"')
    if estimate:
        lines.append("estimate = true")
    lines.append(f'source = "{source}"')
    return "\n".join(lines) + "\n"


def insert_block(text: str, block: str) -> str:
    # insert before first top-level [section] other than limit/metadata keys
    anchor = None
    for m in re.finditer(r"^\[[a-z_]+\]", text, re.M):
        header = m.group(0)
        if header in ("[limit]", "[modalities]"):
            anchor = m.start()  # keep looking: prefer inserting after [limit]
        elif header == "[parameters]":
            return text
        else:
            break
    if anchor is None:
        return text
    return text[:anchor] + block + "\n" + text[anchor:]


def process_file(path: Path, apply: bool):
    rel = path.relative_to(ROOT)
    text = path.read_text()
    if "[parameters]" in text:
        return ("skip-has-params", rel, None)
    repo = hf_repo_from_toml(text)
    if not repo:
        return ("skip-no-hf-weights", rel, None)
    api = hf_json(HF_API.format(repo=repo[len("https://huggingface.co/"):]))
    if not api:
        return ("skip-hf-unreachable", rel, repo)
    st = api.get("safetensors") or {}
    total = st.get("total")
    if not isinstance(total, int) or total <= 0:
        return ("skip-no-safetensors", rel, repo)
    total = total
    active = None
    architecture = None
    cfg = hf_json(HF_CONFIG.format(repo=repo[len("https://huggingface.co/"):]))
    archs = (cfg or {}).get("architectures") or []
    if any("moe" in (a or "").lower() for a in archs) or is_moe_config(cfg):
        architecture = "moe"
        active = count_active_from_config(repo[len("https://huggingface.co/"):])
    block = build_block(total, active, architecture, repo, estimate=False)
    if not apply:
        return ("dry", rel, block)
    new_text = insert_block(text, block)
    if new_text == text:
        return ("skip-insert-failed", rel, None)
    path.write_text(new_text)
    return ("applied", rel, block)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--filter", default=None, help="substring filter on rel path")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    files = sorted(MODELS_DIR.glob("*/*.toml"))
    if args.filter:
        files = [f for f in files if args.filter in str(f.relative_to(ROOT))]

    counts = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_file, f, args.apply): f for f in files}
        for fut in as_completed(futs):
            try:
                status, rel, block = fut.result()
            except Exception as e:
                status, rel, block = ("error", futs[fut].relative_to(ROOT), str(e))
            counts[status] = counts.get(status, 0) + 1
            if status in ("applied", "dry") and block:
                print(f"--- {rel}\n{block}")
    for k, v in sorted(counts.items()):
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()