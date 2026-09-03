#!/usr/bin/env bash
#
# One-time label migration to the four-axis taxonomy in docs/PROCESS.md.
#
# The repository carried two overlapping type taxonomies — `bug`/`fix` and
# `enhancement`/`feat` — so both were used at random, and `cleanup`/`refactor`
# duplicated `chore`. This merges each pair into the surviving name and then
# deletes the retired label.
#
# Order matters: every item is relabelled BEFORE its old label is deleted, so
# no assignment is lost. Deleting first would silently drop the history.
#
# Dry run (default):   scripts/migrate_labels.sh
# Apply:               scripts/migrate_labels.sh --apply
set -euo pipefail

REPO="jeremyfuksa/bearpaw"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

run() {
  if [[ $APPLY -eq 1 ]]; then
    "$@"
  else
    echo "  would run: $*"
  fi
}

# old:new — every item carrying `old` gains `new` and loses `old`.
MERGES=(
  "fix:bug"
  "feat:enhancement"      # then `enhancement` is renamed to `feat` below
  "cleanup:chore"
  "refactor:chore"
  "documentation:docs"    # `docs` already exists, so this is a merge, not a rename
)

# Retired outright: nothing replaces them.
RETIRE=("rebuild" "release: 1.1-blocker" "release: post-1.1")

echo "== merging duplicate type labels"
for pair in "${MERGES[@]}"; do
  old="${pair%%:*}"; new="${pair##*:}"
  # `mapfile` is bash 4; macOS ships bash 3.2. Word-splitting a list of
  # integers is safe and portable.
  items=$(
    { gh issue list --repo "$REPO" --state all --limit 1000 --label "$old" --json number --jq '.[].number'
      gh pr    list --repo "$REPO" --state all --limit 1000 --label "$old" --json number --jq '.[].number'
    } | sort -un
  )
  count=$(printf '%s\n' "$items" | grep -c '[0-9]' || true)
  echo "-- $old -> $new ($count items)"
  for n in $items; do
    run gh issue edit "$n" --repo "$REPO" --add-label "$new" --remove-label "$old"
    [[ $APPLY -eq 1 ]] && sleep 1   # stay under GitHub's secondary rate limit
  done
  run gh label delete "$old" --repo "$REPO" --yes
done

# `feat` is now empty (its items were moved onto `enhancement`) and deleted
# above, so the name is free for the label that actually holds the assignments.
echo "== renaming survivors to the taxonomy names"
run gh label edit "enhancement" --repo "$REPO" --name "feat"
run gh label edit "i8n" --repo "$REPO" --name "i18n"   # a typo, and it is in use

echo "== retiring labels the milestone now answers for"
for l in "${RETIRE[@]}"; do
  run gh label delete "$l" --repo "$REPO" --yes
done

echo
if [[ $APPLY -eq 1 ]]; then
  echo "done. verify with: gh label list --repo $REPO"
else
  echo "dry run only. re-run with --apply to make these changes."
fi
