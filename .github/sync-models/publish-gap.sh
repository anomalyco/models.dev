#!/usr/bin/env bash
# publish-gap.sh <dir>: run from a checkout of dev. <dir> is one Fill Catalog Gap artifact (provider, model, kind,
# changes.patch, report.md). Puts the patch on automation/gap-<provider>-<hash of the model ID> as one commit on dev
# and opens or updates the pull request. Never enables auto-merge: gap-auto-merge.sh does that once the reviewer marks
# the pull request ready. Uses git and gh only; never runs repository code.
set -euo pipefail

: "${GH_REPO:?}" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
dir=${1%/}
git=(git -c core.hooksPath=/dev/null -c "user.name=$BOT_NAME" -c "user.email=$BOT_EMAIL")
source "$(dirname "$0")/gap-risk.sh"

provider=$(<"$dir/provider")
model=$(<"$dir/model")
kind=$(<"$dir/kind")
[[ $provider =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo "::error::invalid provider: $provider" >&2; exit 1; }
[[ $model =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$ && ! $model =~ (^|/)\.\.?(/|$) ]] || { echo "::error::invalid model ID for $provider" >&2; exit 1; }
[[ $kind =~ ^(new|update)$ ]] || { echo "::error::invalid gap kind: $kind" >&2; exit 1; }

hash=$(printf '%s' "$model" | sha256sum | cut -c1-10)
branch="automation/gap-$provider-$hash"
labels=(automation model-gap "provider:$provider")

"${git[@]}" fetch -q --no-tags --depth=1 origin "+refs/heads/dev:refs/remotes/origin/dev"
"${git[@]}" checkout -q -f -B "$branch" origin/dev
"${git[@]}" clean -q -fdx
"${git[@]}" apply --index --binary "$dir/changes.patch" || { echo "::error::$provider/$model patch no longer applies to dev" >&2; exit 1; }

# Catalog data only: regular TOML files under models/ or providers/, never a provider.toml, nothing deleted, a handful
# of files at most. The provider's sync-ignore.toml is how the agent leaves a model out.
changed=$(git diff --cached --raw --no-renames --no-abbrev)
[ -n "$changed" ] || { echo "::error::$provider/$model patch is empty" >&2; exit 1; }
files=()
ignore_only=true
while IFS=$'\t' read -r meta path; do
  read -r old_mode new_mode _ <<< "${meta#:}"
  [[ $old_mode =~ ^(000000|100644)$ && $new_mode == 100644 ]] || { echo "::error::$provider/$model may only add or edit regular files: $path" >&2; exit 1; }
  [[ $path =~ ^(models|providers)/.+\.toml$ ]] || { echo "::error::$provider/$model may change only catalog TOML: $path" >&2; exit 1; }
  [[ ! $path =~ ^providers/[^/]+/provider\.toml$ ]] || { echo "::error::$provider/$model may not change provider settings: $path" >&2; exit 1; }
  if [[ $path =~ ^providers/[^/]+/sync-ignore\.toml$ ]]; then
    [ "$path" = "providers/$provider/sync-ignore.toml" ] || { echo "::error::$provider/$model may only change its own provider's ignore list" >&2; exit 1; }
  else
    ignore_only=false
  fi
  if [ "$old_mode" = 000000 ]; then files+=("added"$'\t'"$path"); else files+=("modified"$'\t'"$path"); fi
done <<< "$changed"
[ "${#files[@]}" -le 5 ] || { echo "::error::$provider/$model changes ${#files[@]} files (limit 5)" >&2; exit 1; }

if [ "$ignore_only" = true ]; then
  title="chore($provider): leave $model out of the sync"
elif [ "$kind" = new ]; then
  title="feat($provider): add $model"
else
  title="fix($provider): update $model"
fi
reasons=$(printf '%s\n' "${files[@]}" | gap_risk)

body="$RUNNER_TEMP/gap-body.md"
{
  head -c 60000 "$dir/report.md"
  echo
  echo "---"
  echo
  if [ -z "$reasons" ]; then
    echo "Low risk: this merges on its own once the reviewer marks it \`reviewer: ready\` and the checks pass."
  else
    echo "Needs a maintainer to merge:"
    sed 's/^/- /' <<< "$reasons"
  fi
  echo
  echo "Filled by $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} > "$body"

"${git[@]}" commit -q --no-verify -m "$title"

find_pr() {
  gh pr list --repo "$GH_REPO" --base dev --head "$branch" --state open --json number,isCrossRepository \
    --jq 'map(select(.isCrossRepository | not)) | .[0].number // empty'
}
pr=$(find_pr)
# A new patch needs a new review before anything merges.
if [ -n "$pr" ]; then
  gh pr merge "$pr" --repo "$GH_REPO" --disable-auto >/dev/null 2>&1 || true
fi

"${git[@]}" push -q --no-verify --force origin "HEAD:refs/heads/$branch"

for label in "${labels[@]}"; do
  gh label create "$label" --repo "$GH_REPO" --color "0E8A16" --description "Automated model catalog work" >/dev/null 2>&1 || true
done
label_list=$(IFS=,; echo "${labels[*]}")

if [ -n "$pr" ]; then
  gh pr edit "$pr" --repo "$GH_REPO" --title "$title" --body-file "$body" --add-label "$label_list"
else
  gh pr create --repo "$GH_REPO" --base dev --head "$branch" --title "$title" --body-file "$body" --label "$label_list"
  pr=$(find_pr)
fi

echo "$provider/$model: #$pr (${reasons:+needs review}${reasons:-low risk})" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
