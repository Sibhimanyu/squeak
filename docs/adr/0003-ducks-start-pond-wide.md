# Ducks start Pond-wide and choose their Streams

A Duck's agent runs in the Pond's main folder, not inside a Stream's worktree, and joins or leaves Streams through
agent tools (`streams`, `open_stream`, `leave_stream`), possibly several at once. We chose this over giving every new
chat its own branch and worktree before its first turn, because that locked a Duck to one line of work, made it fail
to start when its worktree was removed, and left the agent no say in where its work belongs. Squeak's code still does
the git work and keeps Main read-only for Ducks in Git Ponds.
