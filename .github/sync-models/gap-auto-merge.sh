#!/usr/bin/env bash
# gap-auto-merge.sh: enables auto-merge on each open gap pull request (automation/gap-*, opened by the automation app)
# that the reviewer marked `reviewer: ready` and that only adds catalog files (gap-risk.sh), and turns it off on any
# that no longer qualifies. GitHub still merges only after the required checks pass. Uses gh and jq only.
set -euo pipefail

: "${GH_REPO:?}" "${SLUG:?}"
source "$(dirname "$0")/gap-risk.sh"
ready_label="reviewer: ready"

prs=$(gh pr list --repo "$GH_REPO" --base dev --state open --limit 500 \
  --json number,headRefName,isCrossRepository,isDraft,author,labels,autoMergeRequest |
  jq -r --arg login "app/$SLUG" --arg ready "$ready_label" '
    .[] | select((.headRefName | startswith("automation/gap-")) and (.isCrossRepository | not) and .author.login == $login)
    | [.number, ((.isDraft | not) and ([.labels[].name] | index($ready) != null)), (.autoMergeRequest != null)] | @tsv')

while IFS=$'\t' read -r pr ready auto; do
  [ -n "$pr" ] || continue
  reasons=$(gh api "repos/$GH_REPO/pulls/$pr/files" --paginate --jq '.[] | "\(.status)\t\(.filename)"' | gap_risk)
  if [ "$ready" = true ] && [ -z "$reasons" ]; then
    if [ "$auto" != true ]; then
      gh pr merge "$pr" --repo "$GH_REPO" --auto --squash
      echo "#$pr: auto-merge enabled" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    fi
  elif [ "$auto" = true ]; then
    gh pr merge "$pr" --repo "$GH_REPO" --disable-auto
    echo "#$pr: auto-merge turned off (${reasons:-not marked ready})" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  else
    echo "#$pr: waiting (${reasons:-not marked ready})"
  fi
done <<< "$prs"
