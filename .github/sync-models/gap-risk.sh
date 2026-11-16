#!/usr/bin/env bash
# Sourced by publish-gap.sh and gap-auto-merge.sh. gap_risk reads "<status>\t<path>" lines (status: added, modified,
# removed, renamed, ...) for a gap pull request's files and prints one line per reason it can't merge on its own.
# Low risk means it only adds catalog data: new model files, nothing edited or deleted, no provider settings, at most
# GAP_MAX_FILES files.
GAP_MAX_FILES=3

gap_risk() {
  local status path count=0
  while IFS=$'\t' read -r status path; do
    [ -n "$path" ] || continue
    count=$((count + 1))
    if [[ ! $path =~ ^(models|providers)/.+\.toml$ ]]; then
      echo "changes $path outside the catalog"
    elif [[ $path =~ ^providers/[^/]+/provider\.toml$ ]]; then
      echo "changes provider settings in $path"
    elif [[ $path =~ ^providers/[^/]+/sync-ignore\.toml$ ]]; then
      echo "changes the sync ignore list in $path"
    elif [ "$status" != added ]; then
      echo "$status existing $path"
    fi
  done
  [ "$count" -gt 0 ] || echo "changes no files"
  [ "$count" -le "$GAP_MAX_FILES" ] || echo "changes $count files (auto-merge limit $GAP_MAX_FILES)"
}
