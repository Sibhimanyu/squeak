#!/usr/bin/env bash
#
# Removes agent worktrees and branches that are fully merged into the current branch, and prunes stale worktree
# records. Run after merging agent branches:   scripts/clean-merged.sh
# Leaves anything unmerged or with uncommitted changes alone and says so.
set -uo pipefail
repo="$(git rev-parse --show-toplevel)"
into="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
removed=0 kept=0
while read -r wt branch; do
  [ -z "$branch" ] && continue
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "kept $branch: uncommitted changes in $wt"; kept=$((kept + 1)); continue
  fi
  # A branch with no commits of its own is a fresh worktree (an agent just started there): never a merged one.
  if [ "$(git -C "$repo" rev-list --count "$(git -C "$repo" merge-base "$branch" "$into")..$branch" 2>/dev/null)" = "0" ] \
     && [ -z "$(git -C "$repo" log --merges --oneline -1 "$into" --grep="$branch" 2>/dev/null)" ]; then
    echo "kept $branch: no commits yet (in use?)"; kept=$((kept + 1)); continue
  fi
  if git -C "$repo" merge-base --is-ancestor "$branch" "$into" 2>/dev/null; then
    git -C "$repo" worktree remove -f -f "$wt" && removed=$((removed + 1))
  else
    echo "kept $branch: not merged into $into"; kept=$((kept + 1))
  fi
done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\/heads\/worktree-agent-/{sub("refs/heads/","",$2); print w, $2}')
git -C "$repo" worktree prune
# Branches with no worktree left (their worktree was removed above or earlier).
for b in $(git -C "$repo" branch --merged "$into" --list 'worktree-agent-*' --format='%(refname:short)'); do
  git -C "$repo" worktree list --porcelain | grep -q "^branch refs/heads/$b$" && continue
  git -C "$repo" branch -d "$b" >/dev/null && removed=$((removed + 1))
done
echo "clean-merged: removed $removed, kept $kept (into $into)"
