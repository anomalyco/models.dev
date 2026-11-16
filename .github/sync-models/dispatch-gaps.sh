#!/usr/bin/env bash
# dispatch-gaps.sh <dir>: run from a checkout of dev. <dir> holds the sync artifacts (sync-<provider>/, each with
# provider and result.json). Starts the Fill Catalog Gap workflow for each new or update gap nobody is handling yet, at
# most GAP_LIMIT per run. Removal gaps are only listed in the sync pull request. Used by Sync Model Catalogs and
# Observe Agent Providers. Uses git, gh, jq and python3 only; never runs repository code. GitHub itself is the state:
#   - branch automation/gap-<provider>-<hash> exists: a gap pull request is open, or was closed without merging
#     (delete the branch to try again)
#   - an open pull request already adds (new) or changes (update) the model's file
#   - the model is in providers/<provider>/sync-ignore.toml
#   - a "gap <provider>/<model>" run started in the last GAP_RETRY_DAYS days, whatever its result
set -euo pipefail

: "${GH_REPO:?}"
root=$1
limit=${GAP_LIMIT:-5}
since=$(date -u -d "${GAP_RETRY_DAYS:-7} days ago" +%Y-%m-%d)
owner=${GH_REPO%/*}
name=${GH_REPO#*/}

branches=$(gh api "repos/$GH_REPO/git/matching-refs/heads/automation/gap-" --paginate --jq '.[].ref | ltrimstr("refs/heads/")')
open_files=$(gh api graphql --paginate -F owner="$owner" -F name="$name" -f query='
  query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { files(first: 100) { nodes { path changeType } } }
      }
    }
  }' --jq '.data.repository.pullRequests.nodes[].files.nodes[]? | "\(.changeType)\t\(.path)"')
recent=$(gh run list --repo "$GH_REPO" --workflow fill-gap.yml --created ">=$since" --limit 1000 --json displayTitle --jq '.[].displayTitle')

ignored() {
  python3 - "$1" "$2" <<'EOF'
import os, sys, tomllib
path = f"providers/{sys.argv[1]}/sync-ignore.toml"
models = tomllib.load(open(path, "rb")).get("models", {}) if os.path.exists(path) else {}
sys.exit(0 if sys.argv[2] in models else 1)
EOF
}

dispatched=0
for dir in "$root"/sync-*/; do
  [ -f "$dir/result.json" ] || continue
  provider=$(<"$dir/provider")
  [[ $provider =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "::warning::invalid provider in $dir"; continue; }
  while IFS=$'\t' read -r model kind missing reason known; do
    if [[ ! $model =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$ || $model =~ (^|/)\.\.?(/|$) ]]; then
      echo "::warning::$provider: skipped an invalid model ID"
      continue
    fi
    hash=$(printf '%s' "$model" | sha256sum | cut -c1-10)
    file="providers/$provider/models/$model.toml"
    if grep -Fxq "automation/gap-$provider-$hash" <<< "$branches"; then
      echo "$provider/$model: branch automation/gap-$provider-$hash exists"
    elif [ "$kind" = new ] && grep -Fxq "ADDED"$'\t'"$file" <<< "$open_files"; then
      echo "$provider/$model: an open pull request adds it"
    elif [ "$kind" = update ] && cut -f2 <<< "$open_files" | grep -Fxq "$file"; then
      echo "$provider/$model: an open pull request changes it"
    elif ignored "$provider" "$model"; then
      echo "$provider/$model: in sync-ignore.toml"
    elif grep -Fxq "gap $provider/$model" <<< "$recent"; then
      echo "$provider/$model: filled or tried since $since"
    elif [ "$dispatched" -ge "$limit" ]; then
      echo "$provider/$model: over this run's limit of $limit"
    else
      # The data is base64 so tabs and newlines survive the TSV; the workflow treats it as untrusted.
      gh workflow run fill-gap.yml --repo "$GH_REPO" --ref dev \
        -f provider="$provider" -f model="$model" -f kind="$kind" -f missing="$missing" \
        -f reason="$(base64 -d <<< "$reason" | head -c 1000)" -f known="$(base64 -d <<< "$known")"
      dispatched=$((dispatched + 1))
      echo "$provider/$model: started Fill Catalog Gap ($kind)" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    fi
  done < <(jq -r '.gaps[] | select(.kind == "new" or .kind == "update")
    | [.model, .kind, (.missing | join(",")), (.reason | @base64),
       ((.known // {}) | tojson | if length > 20000 then "{}" else . end | @base64)] | @tsv' "$dir/result.json")
done
echo "Started $dispatched gap runs (limit $limit)." | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
