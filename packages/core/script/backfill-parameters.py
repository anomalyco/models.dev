#!/usr/bin/env python3
"""
Backfill [parameters] blocks into models.dev lab model TOMLs.

Modes:
  default           Seed exact totals from Hugging Face safetensors API
                    (estimate absent, source = HF repo). MoE detected via
                    expert-config keys; architecture omitted if undetermined.
  --active-from-names  Curate `active` for MoE models from the lab's own
                    official repo name (e.g. "Qwen3-235B-A22B" -> 22B active).
                    Vendor AxB naming is lab-published, so estimate stays
                    absent. Files with active or estimate=true are skipped.
                    Totals stay untouched (already exact from safetensors).

Active is NEVER reconstructed arithmetically from config.json: per-token
activation depends on the full architecture (attention, dense layers,
shared experts). See AGENTS.md.

Never touches files that already have [parameters] (default mode) or an
existing active/estimate block (--active-from-names).
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


def resolve_repo(repo: str):
    """Follow HF API redirects (org renames, e.g. deepreinforce-ai -> ornith-ai)
    so `source` always points at the canonical repo."""
    req = urllib.request.Request(
        HF_API.format(repo=repo), headers={"User-Agent": "models-dev-backfill"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            final = r.geturl()
            return final.split("/api/models/", 1)[-1].rstrip("/")
    except Exception:
        return repo


def true_safetensors_total(api):
    """Parameter total = sum over the per-dtype breakdown when it disagrees
    with the API's `safetensors.total` field (that field is broken on some
    repos — e.g. reports a few metadata scalars while BF16 tensors hold the
    real ~35B). Returns (total, dtype_sum, api_total) or (None, …).

    Quantized storage formats are counted as ONE parameter per element only
    for 8-bit formats (FP8 element == parameter). Sub-byte-packed formats
    (4-bit/2-bit: packed into U8/I8 shards) are NOT resolvable from this
    metadata — such repos are skipped entirely rather than undercounted."""
    st = (api or {}).get("safetensors") or {}
    params = st.get("parameters") or {}
    dtypes = {k: v for k, v in params.items() if isinstance(v, int)}
    if not dtypes:
        return None
    unpacked = {k: v for k, v in dtypes.items() if k in ("BF16", "F16", "F32", "I64")}
    fp8 = {k: v for k, v in dtypes.items() if k.startswith("F8")}
    subbyte = {k: v for k, v in dtypes.items() if k in ("U8", "I8", "I4", "F4", "U4", "I2")}
    if subbyte and not fp8:
        # 4-bit/2-bit packed shards: storage elements != parameters.
        return None
    if subbyte and fp8:
        # Mixed FP8 + packed (e.g. FP4 DFlash): not resolvable without the
        # full tensor index; refuse rather than undercount.
        return None
    dtype_sum = sum(unpacked.values()) + sum(fp8.values())
    api_total = st.get("total")
    # Trust the per-dtype sum; it is what safetensors headers actually encode.
    total = dtype_sum if (api_total is None or dtype_sum > api_total) else api_total
    return total, dtype_sum, api_total


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


# Official repo-name pattern for vendor-stated active params:
# "Qwen3-235B-A22B", "Qwen3-30B-A3B", "Nemotron-3-Ultra-550B-A55B",
# "Hunyuan-A13B", "gemma-4-26B-A4B-it". Case-insensitive on the A/B
# suffix; the number keeps its case only as part of the token.
ACTIVE_NAME_RE = re.compile(r"(?:^|[-_])[aA](\d+(?:\.\d+)?)[bB](?=$|[-_.])")

# Fallback: lab-published phrasing in the reviewed description text —
# "37B active parameters" / "(2.4T total, 41B active)".
ACTIVE_DESC_RES = [
    re.compile(r"(\d+(?:\.\d+)?)[bB]\s+active\s+parameters?", re.I),
    re.compile(r"[,]\s*(\d+(?:\.\d+)?)[bB]\s+active\b", re.I),
]


def curate_active(path: Path, apply: bool):
    rel = path.relative_to(ROOT)
    text = path.read_text()
    m = re.search(r"^\[parameters\]\n(.*?)(?=^\[|\Z)", text, re.S | re.M)
    if not m:
        return ("skip-no-params", rel, None)
    block = m.group(0)
    if re.search(r"^active\s*=", block, re.M):
        return ("skip-has-active", rel, None)
    if "estimate = true" in block:
        return ("skip-estimate", rel, None)
    if 'architecture = "moe"' not in block:
        return ("skip-not-moe", rel, None)
    src = re.search(r'^source\s*=\s*"([^"]+)"', block, re.M)
    if not src:
        return ("skip-no-source", rel, None)
    name = src.group(1).rstrip("/").rsplit("/", 1)[-1]
    active = None
    am = ACTIVE_NAME_RE.search(name)
    if am:
        active = int(round(float(am.group(1)) * 1e9))
    else:
        desc = re.search(r'^description\s*=\s*"([^"]+)"', text, re.M)
        if desc:
            for pat in ACTIVE_DESC_RES:
                dm = pat.search(desc.group(1))
                if dm:
                    active = int(round(float(dm.group(1)) * 1e9))
                    break
    if active is None:
        return ("no-name-active", rel, None)
    tot = re.search(r"^total\s*=\s*(\d+)", block, re.M)
    if not tot:
        return ("skip-no-total", rel, None)
    if active > int(tot.group(1)):
        return ("skip-active-exceeds-total", rel, None)
    new_block = re.sub(
        r"^(total\s*=\s*\d+)$",
        "\\1\nactive = " + str(active),
        block,
        count=1,
        flags=re.M,
    )
    if not apply:
        return ("dry", rel, new_block)
    path.write_text(text[: m.start()] + new_block + text[m.end():])
    return ("applied", rel, new_block)


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
    resolved = resolve_repo(repo[len("https://huggingface.co/"):])
    result = true_safetensors_total(api)
    if result is None:
        return ("skip-no-safetensors", rel, repo)
    total, dtype_sum, api_total = result
    total = int(total)
    active = None
    architecture = None
    cfg = hf_json(HF_CONFIG.format(repo=repo[len("https://huggingface.co/"):]))
    archs = (cfg or {}).get("architectures") or []
    if any("moe" in (a or "").lower() for a in archs) or is_moe_config(cfg):
        architecture = "moe"
        active = count_active_from_config(repo[len("https://huggingface.co/"):])
    block = build_block(total, active, architecture, "https://huggingface.co/" + resolved, estimate=False)
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
    ap.add_argument("--active-from-names", action="store_true",
                    help="curate active counts from official repo AxB names")
    ap.add_argument("--filter", default=None, help="substring filter on rel path")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    files = sorted(MODELS_DIR.glob("*/*.toml"))
    if args.filter:
        files = [f for f in files if args.filter in str(f.relative_to(ROOT))]

    counts = {}
    if args.active_from_names:
        for f in files:
            try:
                status, rel, block = curate_active(f, args.apply)
            except Exception as e:
                status, rel, block = ("error", f.relative_to(ROOT), str(e))
            counts[status] = counts.get(status, 0) + 1
            if status in ("applied", "dry") and block:
                print(f"--- {rel}\n{block}")
    else:
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