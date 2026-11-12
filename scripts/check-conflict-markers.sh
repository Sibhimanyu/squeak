#!/bin/bash
# Fails when a tracked text file holds a committed merge-conflict marker (`<<<<<<< ` or `>>>>>>> ` at line start).
# `=======` is not matched on purpose: it is also a markdown setext heading underline.
# Used by `npm run ci`; also usable as a git pre-commit hook:
#   ln -sf ../../scripts/check-conflict-markers.sh "$(git rev-parse --git-path hooks)/pre-commit"
cd "$(git rev-parse --show-toplevel)" || exit 1
if git grep -nIE '^(<<<<<<< |>>>>>>> )' -- . ':(exclude)package-lock.json'; then
  echo "check-conflict-markers: merge-conflict markers found above; resolve them before committing." >&2
  exit 1
fi
