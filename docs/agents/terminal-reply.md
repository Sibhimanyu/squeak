# Answering terminal agents

Read before touching `src/fleet/terminal-*.ts` or Squeak Hands' terminal modes.

- **A terminal agent is answered by typing into its Terminal tab**, never by
  `claude -p --resume` beside it (the live TUI would carry on from a history
  that no longer matches the file) and never through Claude Code's peer socket
  (`/tmp/cc-socks/<pid>.sock`), which delivers a message _from another
  agent_. Reply targets are `replyTargetFor(session)`: a Conductor id, or a
  fleet key (always has a `:`) for anything else; `fleet_reply_target` and
  the control routes carry either. Every link is proven before a key is
  pressed, and each check below was a real failure on a real screen:
  - Claude Code writes `~/.claude/sessions/<pid>.json` with the `sessionId`
    and `status` (`idle` / `busy` / `waiting` + `waitingFor: "permission
prompt"`). Only `idle` is typed into. Its `procStart` is **UTC**, while
    `ps -o lstart` is local time — run ps with `TZ=UTC` or the pid-reuse
    check fails for every process. The file does not exist until the
    folder-trust dialog is passed.
  - Codex writes no process→thread link anywhere (no pid file, rollout not
    held open, nothing in `state_5.sqlite`). It is the one Codex TUI with that
    cwd, _and_ the session's last message must be on that tab's screen.
  - The agent must own the tty's foreground (`pgid == tpgid`): after an
    agent exits, text arrives at bash and runs. Squeak Hands re-checks this
    with `ps` itself right before typing, so it cannot be aimed at a shell.
  - The screen must show the agent's own empty prompt (`terminal-screen.ts`,
    fixtures in `src/fleet/fixtures/screens/`). Claude's permission prompt,
    its trust dialog and Codex's update/hook pickers all take a digit and
    Enter; Codex's update picker's option 1 runs `curl … | sh`. Placeholders
    are dim but plain screen text has no colour, so only known ones count as
    empty (`Try "…"`, Codex's two); anything else is a draft and refused.
  - Typed as a bracketed paste (`ESC[200~ … ESC[201~`) through Terminal's
    `do script … in tab`, which adds the Enter: a multi-line reply stays one
    message. Control characters are stripped first so text cannot close the
    paste. Squeak Hands types only if the screen's SHA-256 still matches what
    node approved.
  - Confirmed from the transcript (Claude: a `user` entry; Codex: a
    `response_item` message with role `user` — there is no `user_message`
    event in 0.149), never retyped.
  - Apple Events to Terminal need the **Automation** grant, and it lives in
    Squeak Hands, not node: controlling Terminal runs arbitrary commands,
    and a grant to the node binary would be a grant to every Node tool.
    `ship.sh` does not rebuild Hands; an old build answers the new modes
    with nothing and the reply says to rebuild.
  - Only Terminal.app. The host app is found from the process's ancestry, and
    anything else (iTerm, tmux, ssh) is refused by name.
