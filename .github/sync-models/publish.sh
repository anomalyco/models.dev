#!/usr/bin/env bash
# publish.sh <dir>: run from a checkout of dev. <dir> is one provider's sync artifact. Puts its patch on
# automation/sync-models-<provider> as one commit on dev, opens or updates the pull request into dev and enables
# auto-merge when the sync is safe. Uses git, gh and jq only; never runs repository code.
set -euo pipefail

: "${GH_REPO:?}" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
dir=$1
git=(git -c core.hooksPath=/dev/null -c "user.name=$BOT_NAME" -c "user.email=$BOT_EMAIL")

provider=$(<"$dir/provider")
name=$(<"$dir/name")
safe=$(<"$dir/safe")
[[ $provider =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "::error::invalid provider: $provider" >&2; exit 1; }
[[ $name =~ ^[^[:cntrl:]]{1,100}$ ]] || { echo "::error::invalid name for $provider" >&2; exit 1; }
[[ $safe =~ ^(true|false)$ ]] || { echo "::error::invalid safe flag for $provider" >&2; exit 1; }

branch="automation/sync-models-$provider"
title="chore(sync): update $name model catalog"
labels=(automation model-sync "provider:$provider")

"${git[@]}" fetch -q --no-tags --depth=1 origin "+refs/heads/dev:refs/remotes/origin/dev"
# Providers publish one after another from the same checkout; drop anything a failed one left behind.
"${git[@]}" checkout -q -f -B "$branch" origin/dev
"${git[@]}" clean -q -fdx
"${git[@]}" apply --index --binary "$dir/changes.patch" || { echo "::error::$provider patch no longer applies to dev" >&2; exit 1; }

# A symlink (the Vercel sync writes some) must be a relative link to another TOML file inside providers/.
check_link() {
  local path=$1 sha=$2 target part
  local -a parts resolved=()
  target=$(git cat-file -p "$sha")
  [ "$(git cat-file -s "$sha")" = "$(LC_ALL=C; echo "${#target}")" ] || return 1
  [[ $target =~ ^[^/\\[:cntrl:]][^\\[:cntrl:]]*\.toml$ ]] || return 1
  IFS=/ read -ra parts <<< "${path%/*}/$target"
  for part in "${parts[@]}"; do
    case $part in
      '' | .) ;;
      ..) [ "${#resolved[@]}" -gt 1 ] || return 1; unset "resolved[${#resolved[@]}-1]" ;;
      *) resolved+=("$part") ;;
    esac
  done
  [ "${#resolved[@]}" -gt 1 ] && [ "${resolved[0]}" = providers ]
}

# Without rename detection, a rename shows up as a deletion of its source plus an addition, so both are checked.
changed=$(git diff --cached --raw --no-renames --no-abbrev)
[ -n "$changed" ] || { echo "::error::$provider patch is empty" >&2; exit 1; }
created=0
deleted=0
reasons=()
while IFS=$'\t' read -r meta path; do
  read -r old_mode new_mode _ new_sha _ <<< "${meta#:}"
  [[ $old_mode =~ ^(000000|100644|120000)$ && $new_mode =~ ^(000000|100644|120000)$ ]] || { echo "::error::$provider sync may change only regular files and symlinks: $path" >&2; exit 1; }
  [[ $path =~ ^(models|providers)/.+\.toml$ ]] || { echo "::error::$provider sync may change only catalog TOML: $path" >&2; exit 1; }
  [ "$new_mode" != 120000 ] || check_link "$path" "$new_sha" || { echo "::error::$provider sync symlink must point to a TOML file inside providers/: $path" >&2; exit 1; }
  [[ $path == "providers/$provider/models/"* ]] || reasons+=("changes $path outside providers/$provider/models/")
  [ "$old_mode" != 000000 ] || created=$((created + 1))
  [ "$new_mode" != 000000 ] || deleted=$((deleted + 1))
done <<< "$changed"

# The sync job runs repository code and dependencies, so its safe flag is only trusted alongside these checks, which
# mirror the limits in packages/core/src/sync/auto-merge.ts.
[ "$created" -le 10 ] || reasons+=("$created models created (limit 10)")
[ "$deleted" -le 10 ] || reasons+=("$deleted models deleted (limit 10)")
[ $((created + deleted)) -le 15 ] || reasons+=("$((created + deleted)) models created or deleted (limit 15)")
[ "$provider" != cloudflare-ai-gateway ] || [ "$deleted" -eq 0 ] || reasons+=("Cloudflare AI Gateway model deletions require manual review")
# Small providers stay under the absolute limits even when their source returns nothing, so also cap the share deleted.
before=$(git ls-tree -r --name-only origin/dev -- "providers/$provider/models/" | grep -c '\.toml$' || true)
[ $((before + created - deleted)) -gt 0 ] || reasons+=("leaves $provider with no models")
[ $((deleted * 2)) -le "$before" ] || reasons+=("$deleted of $before $provider models deleted (limit half)")
if [ "$safe" = true ] && [ ${#reasons[@]} -gt 0 ]; then
  for reason in "${reasons[@]}"; do echo "::warning::$provider sync not auto-merged: $reason"; done
  safe=false
fi

"${git[@]}" commit -q --no-verify -m "$title"

# Only a same-repository pull request is the bot's; a fork can use the same branch name.
find_pr() {
  gh pr list --repo "$GH_REPO" --base dev --head "$branch" --state open --json number,isCrossRepository \
    --jq 'map(select(.isCrossRepository | not)) | .[0].number // empty'
}
pr=$(find_pr)

if [ "$safe" != true ] && [ -n "$pr" ]; then
  gh pr merge "$pr" --repo "$GH_REPO" --disable-auto || true
  if [ "$(gh pr view "$pr" --repo "$GH_REPO" --json autoMergeRequest --jq '.autoMergeRequest == null')" != true ]; then
    echo "::error::failed to disable auto-merge for unsafe sync pull request #$pr" >&2
    exit 1
  fi
fi

"${git[@]}" push -q --no-verify --force origin "HEAD:refs/heads/$branch"

for label in "${labels[@]}"; do
  gh label create "$label" --repo "$GH_REPO" --color "0E8A16" --description "Automated model catalog sync" >/dev/null 2>&1 || true
done
label_list=$(IFS=,; echo "${labels[*]}")

if [ -n "$pr" ]; then
  gh pr edit "$pr" --repo "$GH_REPO" --title "$title" --body-file "$dir/report.md" --add-label "$label_list"
else
  gh pr create --repo "$GH_REPO" --base dev --head "$branch" --title "$title" --body-file "$dir/report.md" --label "$label_list"
  pr=$(find_pr)
fi

if [ "$safe" = true ]; then
  gh pr merge "$pr" --repo "$GH_REPO" --auto --squash
elif [ "$(gh pr view "$pr" --repo "$GH_REPO" --json autoMergeRequest --jq '.autoMergeRequest == null')" != true ]; then
  echo "::error::unsafe sync pull request #$pr still has auto-merge enabled" >&2
  exit 1
fi

echo "$provider: #$pr (safe=$safe)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
