# The fleet layer

**Claude Code and Codex started outside Squeak are two add-ons, off for everyone** (`addons/claude-external`, `addons/codex-external`, ids `claude-external` / `codex-external`, distributed, no migration). Core reads Claude transcripts and Codex rollouts in _claimed mode_ only (`observe({ ids })`: the sessions a native or host row names by `agentSessionId`, for `transcriptPath`, `waitingOn`, `looping`); the full scan, Cowork and process liveness (`AddonHandle.liveness`) are the add-ons'. Their watch folders exist only while enabled (`AddonHost.watchSpecs` checks `isEnabled`; `FleetMonitor.rewatch()` on a toggle). Enabling installs that agent's hooks and ask format, disabling removes only Squeak's entries (`fleet/external-hooks.ts`, also reconciled by each add-on's `maintenance` at every start); `fleet-notify.sh` does nothing unless `<support>/hooks/enabled` exists; `/hook` answers 200 and drops events while neither is on; `/control/hooks*` answer 404. A reply to an external session refuses with `EXTERNAL_NOT_ENABLED`. The terminal replier itself has not moved into the add-on yet.

`src/fleet/` watches Squeak's own chats. With the external add-ons enabled it
also reads every Claude Code and Codex session on the machine from their
transcripts, and ranks them by what is blocked on the human.

- **Refreshes are event-driven; the poll is only the safety net.** The monitor
  watches `conductor.db` / `-wal` and the Claude/Codex transcript folders
  (`change-watcher.ts`: `fs.watch`, stat-poll fallback), coalesces a burst to
  one refresh 250 ms after the first event and never more than one per 600 ms
  (a working agent writes constantly). A Stop hook for a chat Conductor still
  calls working schedules re-reads at 0.5/1.5/4 s, since Conductor flips its
  status a moment after the turn-end row. `RemoteBridge` publishes on a change
  in what the phone shows, not on timestamps alone. A refresh costs ~440 ms,
  ~300 of it the Conductor query, so that is the floor on latency.
- **Observers are independent and must stay that way.** Each one answers "what
  does my source say" and nothing else; `merge.ts` is the only place that
  reconciles them. That is what keeps them testable against fixture files.
- **A transcript cannot say a session is Conductor's.** `sdk-*` entrypoints
  (Claude) and `*sdk*` originators (Codex) are any harness — Superset, gstack
  and `codex exec` runs appear on a real machine beside Conductor's. They are
  origin `sdk` ("headless"); only `mergeObservations` joining a Conductor row
  makes a session `conductor`. Codex's interactive CLI writes
  `originator: "codex-tui"`, and the Codex desktop app `codex_work_desktop`
  with `source: "vscode"`, so originator is checked before source.
- **Claude Desktop has two surfaces.** The Code tab writes ordinary
  transcripts to `~/.claude/projects` (`entrypoint: "claude-desktop"`,
  origin `desktop`). Cowork (`entrypoint: "local-agent"`) runs Claude Code
  with a config folder per session under `Application Support/Claude/
local-agent-mode-sessions/<account>/<org>/local_<id>/`, so its transcripts
  and hooks never touch `~/.claude` — `claude-cowork.ts` finds them, takes
  the title and `isArchived` from the sibling `local_<id>.json` (~300KB,
  parsed only when a transcript is recent), and follows `cliSessionId` since
  one session can hold several transcripts. No hooks means Cowork can never
  report being blocked on an approval.
- **Sessions join on the agent's own session id.** Conductor stores it in
  `sessions.claude_session_id` for both agents, despite the column name.
- **Transcripts cannot record an approval prompt.** Blocked states only ever
  come from hooks. Anything that infers "awaiting approval" from a file is
  wrong.
- **Use `PermissionRequest`, not `Notification`, to detect blocked-on-approval.**
  Both measured with a temporary settings file against a real SDK-mode run:
  `Notification` never fires there, because the prompt goes to the host app
  rather than to a terminal user — but `PermissionRequest` does. So Conductor
  sessions _can_ report that they are waiting on an approval, which an earlier
  version of this file wrongly said was impossible. `Notification` is still
  installed, because it also covers idle-waiting-for-input on terminal agents.
  Do not try to infer approval from a "PreToolUse then silence" timer — a slow
  test run looks identical. Note that a third of Conductor sessions run
  `bypassPermissions` and never block on approval at all.
- Hooks _do_ fire in SDK-spawned sessions: 32 of 34 `sdk-ts` transcripts on
  this machine ran a Stop hook.
- **Hooks must never block.** The installed script backgrounds its request,
  caps curl at 2s, and exits 0 unconditionally. These run inside other people's
  agents; a Squeak problem must never become their problem. There is a
  regression test that runs the real script against a dead port.
- **`~/.claude/settings.json` is shared.** On a typical machine it already
  carries entries from other tools. Install merges, uninstall removes only
  entries naming `fleet-notify.sh`, and both back the file up first.
- **Callback data caps at 64 bytes.** Session keys do not fit, so
  `FleetStore.handleFor` allocates short integer aliases. Never put a raw
  session key in `callback_data`.
- **Every list is newest first by last activity; urgency lives in Needs you, not in sort order.**
  Home projects by their newest chat, chats newest first inside a project and inside a status group
  (group order stays Needs you, Working, Done, Error, Idle), on the phone, web, Mac and the daemon's
  `/state` and radar. Ties are stable by title. Do not reintroduce attention ranking into a sort. The Mac sidebar's ponds may follow the person's own order
  (`/native/pond-order`, mode manual) when they choose it; every other list stays newest first.
- **Only _active_ sessions reach a screen** — running, blocked, finished in the
  last 24 hours (`DEFAULT_RECENTLY_FINISHED_MS`; the Mac app's `ConductorStatus`
  and `SessionOrdering` mirror it), or quiet with a live process. Everything else stays
  tracked but hidden. On this machine that is 4 of 26; without the filter the
  radar is an archive rather than a status display.
- Blocked sessions get pushed to Telegram wherever they run; a **finish only
  pushes for a Conductor session** (`shouldPush` in `attention.ts`). Every
  agent on the Mac ends turns all day and those finishes were the bulk of the
  noise. Errored and low-on-context ones only appear on the radar.
- Push cards are **three short lines at most** — which session, what the agent
  said it did, what changed on disk — and the last one is only on a finish.
  They are lock-screen notifications, not documents: no commit counts
  (`describeGitState(state, { countCommits: false })`), and the heading drops
  the repo rather than wrapping, since the branch identifies the work. The
  agent's own last message is the point of the card; `card-text.ts` strips its
  markdown, because Telegram would otherwise show `##` and `**` literally.
- **A card carries no button that is also a command.** Snooze and Radar sat on
  every card and read as chrome repeated down the chat; they are `/snooze` and
  `/radar`. Only per-session actions stay.
- `src/fleet/active.ts` owns the active rule. The monitor, the radar and the
  local state endpoint all read it; do not reimplement the predicate.
- **The surfaces decide nothing.** Mood, the active set and every rendered field
  come from `/state`; the Mac app, the phone and Telegram only draw. Logic put in
  a client escapes the daemon's CI and can start disagreeing with Telegram about
  what is happening. Formatting an existing field (agent name, a context-percent
  warning glyph) is fine and duplicated on purpose; a real computation across
  sessions (the title-collision check below) is not, and belongs server-side in
  `radar.ts` so every surface stays in sync instead of drifting.
- **Two sessions can share repo, branch, _and_ agent** — Conductor allows a
  second chat on the same workspace, and this is not hypothetical: this
  session and an earlier one in it were, on this machine, simultaneously
  "squeak · blume-style-session-hub" with nothing to tell them apart.
  `distinctTitles` in `radar.ts` appends each session's own title, but only
  once two rows actually collide, and `/state` carries the result so the duck,
  the window and Telegram disambiguate identically — the same
  discipline `formatWorkspaceLabel` already uses for repo names, applied here
  because most rows never collide and don't need the extra text. Conductor's
  own "Untitled" placeholder counts as no title.
- **The Electron app (`desktop/`) is gone** — retired 2026-10-18, deleted 2026-10-21;
  it is in git history. Anything that still says duck window, NSPanel, Electron or
  `desktop/renderer` is stale. Its icon, menu-bar template and mood sprites now live
  in `macos/assets/`, `brand/logo/` and `brand/mood-sprites/`.
- The ingress serves `GET /state` unauthenticated on loopback for local UIs.
  It is read-only and exposes nothing a local process could not already read
  from the same files; hook posts still require the token.
- **Conductor writes two timestamp spellings.** The app writes ISO-8601 with an
  offset, but its `update_sessions_updated_at` trigger rewrites `updated_at`
  with `datetime('now')` — a UTC wall time with no offset. `Date.parse` reads
  that in local time, so on a UTC+5:30 machine every trigger-touched row looked
  5.5h stale: finished sessions permanently missed the 15-minute active window
  and the fleet never pushed them, while brand-new chats (still carrying the
  app-written ISO stamp) pushed a bogus "done" at creation. `listFleetSessions`
  normalizes via `conductorTimestampToIso` (and orders by `datetime()` so both
  spellings sort by real recency); the conductor observer additionally reports
  a session with no `last_user_message_at` as idle, since a chat nobody spoke
  in never ran. Do not compare raw `updated_at` strings across rows — the `' '`
  in the naive spelling sorts before the `'T'` in ISO and inverts recency.
- **An idle Conductor chat is "finished" only if its last turn _ended_.**
  The observer used to infer a finish from `sessions.updated_at` being recent,
  but Conductor's trigger bumps that on any write to the row: closing a chat
  (`is_hidden`), touching several at once, a rename. And a turn that errors a
  second after you send it is just as recent as one that completed. Both made
  the duck celebrate and Telegram push "done" with nothing done — seen on a
  real machine for a user-aborted turn, an "OpenCode 2 required" failure, and
  a chat idle since the week before. The turn-end record is the `result` /
  `error` row every agent writes (Claude and Codex both), read per chat in
  `listFleetSessions` via the `session_id` index (~20ms for the whole list).
  `{"type":"error","content":"aborted by user"}` is you pressing stop, so idle;
  other `error` rows or `is_error: 1` are `error`. A resting chat's
  `lastActivityAt` is its content time, never `updated_at`.
- **A turn ending is not the chat being done when background work is
  running.** A Claude chat that fans out background subagents ends its turn
  ("waiting on the workers"), and each time one reports in (a
  `<task-notification>` user entry) Claude Code runs a short turn by itself
  that also ends with `end_turn`, fires Stop, and writes a `result` row to
  Conductor. Read as finishes, one fan-out of nine workers pushed six "done"
  cards in ten minutes on a real machine. Conductor alone knows better: its
  status is `working` during those turns and `waiting` between them (and
  while a background shell it started is still alive). So `waiting` maps to
  working, a Stop hook cannot finish a chat Conductor says is working, and a
  working Conductor status gets a 30s grace over a newer transcript — its
  status write lands a moment after the `end_turn`, in whole seconds. A
  status minutes behind still loses, as a stale one should. Terminal
  sessions have no such referee and can still flicker "finished" on the
  radar between workers; they never push a finish, so it stays visual.
- **A `waiting` Conductor chat is finished when only an old shell is left.** The observer keeps `waiting` as `conductorWaiting` (still state `working`); `resolveWaiting` (`addons/conductor/waiting-resolve.ts`, run by the monitor with `BackgroundWorkReader` before hooks) makes it finished when the transcript's turn ended, no subagent runs and the newest running background shell began over 60 s ago (a dev server left up for preview), which also lets the Stop hook through; any subagent, a fresh shell, no task or no transcript stays `working`.
- **"Seems stuck" is timed from the transcript's last entry, not the session's
  activity.** The Claude observer records what an unfinished turn waits on
  (`waitingOn`: a running tool, the model, or an API retry) and since when;
  `isStalled` flags a working session (by Squeak's or Conductor's word) waiting
  on the model 10 min or API retries 5 min, never a running tool. Measured
  over 1,580 turns: 17 of 48 long waits after a tool result ended inside 5
  min and thinking alone ran to 10, while 26 went past 10 — sessions that
  never came back; long tools (builds, renders, 66 cases, median 10 min) are
  legitimate. A newer hook is a sign of life; Conductor's `updated_at` is not
  (its trigger bumps it on any write). Each stall is its own episode, keyed by
  `waitingSince`, so it pushes once. Merged `lastActivityAt` includes
  Conductor's row, so do not time a stall from it. And a quiet transcript no
  longer makes a chat Conductor says is working look idle.
- **Closed Conductor chats stay in the Conductor observation, flagged.**
  `listFleetSessions` used to skip `is_hidden` chats, but their transcripts
  still exist, so the fleet rediscovered each one as an anonymous
  non-Conductor session (labelled by folder, not repo). They are returned with
  `isHidden` and the observer marks them retired. Hidden repos likewise.
- **An idle Conductor chat is never active because of a live process.**
  Conductor's sidecar keeps a warm `claude` process per recently used chat
  for many hours (four at once on a real machine, all idle 16h), so "quiet
  with a live process" — the right signal for a terminal agent — means nothing
  for a Conductor chat, whose status Conductor reports itself.
- **A session can want attention for several reasons at once**, so
  `classifyAttentions` returns a list. Do not collapse it back to one.
- **`workspaces.state = 'archived'` does not mean "done", it means the worktree
  is gone** — which is still a reason to stop asking for review. On this
  machine that is 8 of 18 workspaces, so getting it wrong either buries the
  radar in dead work or hides live work.
- **Git runs only for sessions that will be rendered**, and is cached for 30
  seconds including misses — an archived workspace whose directory is gone must
  not be re-probed every refresh. Enrichment happens _before_ push cards are
  emitted, so the card carries the diffstat.
- **A Conductor branch usually has no upstream**, so `@{upstream}` exits
  non-zero and that is the normal case, not an error. Unpushed work is counted
  against `origin/<repos.default_branch>` instead — and note that
  `default_branch` is the real target branch, not necessarily `main`.
- **The diff is taken against the base branch, not HEAD**, and includes
  untracked files. Agents create files without staging them, so a review built
  on `git diff HEAD` alone silently omits most new code.
- **`git diff --no-index` exits 1 when the files differ**, which for a new file
  is always. Its stdout is the answer even though execFile rejects; read
  `error.stdout` rather than treating it as a failure.
- **Diff buttons carry absolute file indices**, not positions on the page, and
  the page number is clamped — a stale button from a longer list must not open
  the wrong file.
- Writing to `diff_comments` is **not implemented**. Every row in that table on
  this machine was written by an agent via the MCP DiffComment tool
  (`author` is a model alias), so there is no example of a human-authored row
  to copy, and Conductor renders a wrong envelope as broken. Confirm the shape
  against a real human comment before writing one.
- Conductor fields that look useful but are **not populated** on a normal
  single-user install: `sessions.unread_count`, `workspaces.unread`,
  `sessions.queue_paused_at`. They read as all-zero; do not build on them
  without checking a real database first. `context_used_percent` is populated
  for roughly two thirds of sessions and is the one worth using.
