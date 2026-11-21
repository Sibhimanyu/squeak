# Usage, cost and limits

Read before touching `src/fleet/claude-pricing.ts`, `claude-cost.ts`, `claude-usage-api.ts`, `codex-usage.ts` or the assistant.

- **Codex quota is account-wide, not per-session.** `rate_limits` sits on
  every `token_count` event as a sibling of `info`, not nested inside it — a
  first attempt at `codex-usage.ts` nested it and silently returned null
  forever. Verified against a real machine before and after the fix.
- **`cost-state` is almost never written for a Conductor-driven session.**
  Measured on a real machine: 1/37 `sdk-ts` transcripts and 1/18 `sdk-cli`
  transcripts had one, against 2/3 for terminal (`cli`) sessions. So the
  original per-session cost tracking was correct but invisible for the
  overwhelming majority of real usage.
- **`src/fleet/claude-pricing.ts` estimates cost from raw token counts**
  instead, since every entrypoint writes those on every assistant message
  regardless of `cost-state`. Rates and the cache write/read multipliers
  (1.25x / 2x for 5-min / 1-hour TTL writes, 0.1x for reads) come from the
  `claude-api` skill, not memory — pricing drifts and a stale number here
  would be worse than admitting the model is unpriced (`rateForModel`
  returns `null` for anything not in the table, on purpose). The 0.1x
  cache-read rule does not hold for every model: Opus 5.5 reads at $0.20
  (0.05x) and Fable 5.1 at $0.25, so those carry `cacheReadPerMTok`. A
  missing model is silent in practice — every session on this machine ran
  Opus 5.5 and the whole Claude cost line read "no cost yet" — so check
  the table whenever a new model ships.
- **This needed a whole-file read, which is a different cost class from
  everything else in `src/fleet/`.** State detection only needs the _last_
  entry, which the 256KB tail read easily contains; cost needs a _sum_ across
  the entire session. A real 22MB transcript only has ~1% of itself in that
  tail window — computing the estimate from the tail alone would have
  silently under-reported exactly the longest, most expensive sessions by
  orders of magnitude. `src/fleet/claude-cost.ts` (`ClaudeCostReader`) reads
  the whole file instead, but only for sessions about to be rendered (same
  discipline as `GitStateReader`), caches by `(path, mtime)`, and returns
  `null` above a 16MB size cap rather than a silently partial sum.
- **Claude Code writes the same assistant message more than once as it
  streams**, each occurrence carrying the _full_ usage for that message, not
  a delta. Summing every occurrence instead of deduplicating by
  `message.id` overcounted a real session's cost by ~85% against Anthropic's
  own authoritative `cost-state` total — caught by checking the estimate
  against that one real number before trusting it anywhere else. Keep only
  the last occurrence per id.
- **Claude Code never persists its rate-limit event to disk.** `rate_limit_event`
  only ever appears in the live stdout of whatever process spawned the CLI —
  confirmed by dumping the raw hook payload too, which carries none of it
  either. Never spawn a probe process to read it, which would burn real
  quota just to check quota. A manual Refresh instead GETs
  `api.anthropic.com/api/oauth/usage` (`claude-usage-api.ts`, utilization 0–100)
  with Claude Code's own sign-in, read-only (`claude-credentials.ts`:
  `CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`, else on
  macOS the `Claude Code-credentials` Keychain item, which may show an access
  prompt and is read only on that press; a custom dir never falls back to the
  global Keychain). No model call and no `claude` fallback on any path; errors are
  fixed sentences, never a body or a token. And the Cliq assistant (`assistant.ts`) already
  spawns `claude` for every plain-language question, so it runs with
  `--output-format stream-json --verbose` and reads the event off that run:
  `rate_limit_info.unifiedWindows.{five_hour,seven_day}` carry `utilization`
  (0–1) and `resetsAt` (unix seconds). `ClaudeLimitsStore` keeps the latest
  (`claude-limits.json`), and `usage` shows it with its age. A first answer
  about limits can only say "not seen yet" — the reading arrives during the
  call it would describe — and must never say the user has no limit: an
  earlier prompt said "there is no Claude limit to report" and Haiku told
  the user "you don't have a Claude limit".
- The menu-bar panel's Usage section is folded away by default and is the only
  poll for usage while it is open; Refresh is the only thing that calls Claude's
  usage endpoint, and only on a press.
