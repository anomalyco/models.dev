#!/usr/bin/env python3
"""Compare local nano-gpt models with the remote API.

Usage: python3 scripts/check-nanogpt-sync.py [--case-sensitive]
"""

import json
import os
import sys
import urllib.request
from collections import defaultdict

API_URL = "https://nano-gpt.com/api/v1/models?detailed=true"
MODELS_DIR = "providers/nano-gpt/models"


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
                ids.add(rel[:-5])
    return ids


def main():
    case_sensitive = "--case-sensitive" in sys.argv
    models = fetch_models()
    api_ids = {m["id"] for m in models}
    local_ids = local_model_ids()

    if case_sensitive:
        to_add = sorted(api_ids - local_ids)
        to_delete = sorted(local_ids - api_ids)
        # Case-only mismatches: the same model exists on both sides with different case.
        # On Linux CI these would surface as add+delete; on macOS they collapse.
        api_lower = {k.lower(): k for k in api_ids}
        local_lower_map = defaultdict(list)
        for lid in local_ids:
            local_lower_map[lid.lower()].append(lid)
        case_mismatches = []
        for api_id in sorted(api_ids):
            api_key = api_id.lower()
            for local_id in local_lower_map.get(api_key, []):
                if api_id != local_id:
                    case_mismatches.append((api_id, local_id))
    else:
        api_lower = {k.lower(): k for k in api_ids}
        local_lower = defaultdict(list)
        for lid in local_ids:
            local_lower[lid.lower()].append(lid)

        to_add = []
        to_delete = []
        case_mismatches = []

        for api_key, api_orig in sorted(api_lower.items()):
            matches = local_lower.get(api_key, [])
            if not matches:
                to_add.append(api_orig)
            else:
                # Same model on both sides? Note any case-only differences.
                for local_id in matches:
                    if api_orig != local_id:
                        case_mismatches.append((api_orig, local_id))

        for local_key, local_originals in sorted(local_lower.items()):
            if local_key not in api_lower:
                to_delete.extend(sorted(local_originals))

    print(f"\nAPI models:   {len(api_ids)}")
    print(f"Local models: {len(local_ids)}")
    print(f"In sync:      {len(api_ids) - len(to_add)}")
    print(f"To add:       {len(to_add)}")
    print(f"To delete:    {len(to_delete)}")
    print(f"Case mismatches: {len(case_mismatches)}")

    if to_add:
        print(f"\n=== Models to be ADDED (present in API, missing locally) ===")
        for mid in to_add:
            print(mid)

    if to_delete:
        print(f"\n=== Models to be DELETED (present locally, missing in API) ===")
        for mid in to_delete:
            print(mid)

    if case_mismatches:
        print(f"\n=== Case MISMATCHES (same model, different case) ===")
        print("#    API id                               Local id")
        for api_id, local_id in case_mismatches:
            print(f"  API: {api_id}")
            print(f"  LOC: {local_id}")
            print()


if __name__ == "__main__":
    main()