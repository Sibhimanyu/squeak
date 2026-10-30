# Uninstalling Squeak

Squeak removes itself completely from one place: `squeak uninstall`. Squeak for Mac
(Settings › About › Uninstall Squeak…) runs the same command and draws its progress, so the
terminal and the app do exactly the same thing. Nothing is removed silently: `--dry-run` lists
every step and what it would touch first.

## What it removes, in order

1. **Hand Conductor back.** Puts Conductor's two relay settings rows back to what they were
   (after copying `conductor.db` aside as `conductor.db.before-squeak-relay-<time>`) and removes
   the one Keychain entry Squeak added to Conductor's paired devices. This goes **first** because
   Conductor is pointed at Squeak's local proxy while Squeak is set up; if Squeak were stopped
   first, Conductor would be left talking to nothing. If this step fails the run stops and
   nothing else is touched, so the proxy keeps answering Conductor. Restart Conductor once
   afterwards (the final message tells you when).
2. **Stop Squeak.** Boots out `com.squeak.daemon`, `com.squeak.awake-backstop` and any other
   loaded `com.squeak.*` launch agent, and quits Squeak Hands. Squeak for Mac is not quit.
3. **Undo system changes.** Runs the awake backstop once (it undoes a left-over sleep disable,
   Low Power Mode, paused apps and fans), sets Energy mode back to Automatic and the fans to
   automatic. Best effort, and done before step 5 removes the rules that allow it.
4. **Remove agent hooks.** Squeak's own entries in `~/.claude/settings.json`,
   `~/.codex/hooks.json` and the ask-format block in `$CODEX_HOME/AGENTS.md` (default
   `~/.codex`). A `.squeak.bak` backup is written beside each file; other tools' entries stay.
5. **Remove administrator rules.** One macOS administrator prompt deletes exactly
   `/etc/sudoers.d/squeak`, `/etc/sudoers.d/squeak-fans`, `/etc/sudoers.d/squeak-power` and
   `/Library/PrivilegedHelperTools/com.squeak.fans`. No prompt if none exist. If you cancel the
   prompt this step fails, the rest still runs, and the run ends as not complete; run it again
   to finish.
6. **Delete Keychain items.** The "Squeak hotspot" item and the Mac app's `com.squeak.mac`
   (account `squeak`) item. Conductor's and other apps' items are never touched.
7. **Delete Squeak's files.** `~/Library/LaunchAgents/com.squeak.*.plist`,
   `~/Library/Logs/squeak`, `~/Library/Caches/com.squeak.*`, `~/Library/Preferences/com.squeak.*.plist`,
   `~/Library/Saved Application State/com.squeak.*`, and (unless `--keep-data`)
   `~/Library/Application Support/squeak`, `Squeak Mac` and `SqueakMac`. Nothing outside that list
   is ever deleted, and a symlink is removed itself, never followed.
8. **Squeak.app.** Not removed here. The Mac app moves itself to the Trash after it quits; from
   the terminal, drag `/Applications/Squeak.app` to the Trash yourself.

Every step is safe to repeat: a second run reports each step as skipped and changes nothing.

## Three ways to run it

- **The app:** Settings › About › Uninstall Squeak…, review the plan, choose whether to keep
  your settings, confirm.
- **A checkout:** `node dist/squeak/cli.js uninstall` (build first with `npm run build` in a
  worktree, or use `npx tsx src/squeak/cli.ts uninstall`).
- **Bundled Node, with or without the app** (also works after the app was dragged to the
  Trash, as long as the daemon copy still exists):

  ```bash
  D="$HOME/Library/Application Support/squeak/daemon/current"
  "$D/node" "$D/dist/squeak/cli.js" uninstall
  ```

  While the app is still installed you can use
  `/Applications/Squeak.app/Contents/Resources/daemon/node` with the `dist/squeak/cli.js` beside it.

## Options

```
squeak uninstall [--dry-run] [--keep-data] [--yes] [--json]
```

- `--dry-run` changes nothing and prints the plan.
- `--keep-data` leaves the three Application Support folders so a reinstall resumes.
- `--orphan` is the Trash cleanup above; it implies `--keep-data` and `--yes` and skips the administrator step.
- `--yes` skips the y/N question (needed when there is no terminal).
- `--json` prints one JSON object per line on stdout (`plan`, `step` start/done/skipped/failed,
  `done`); text for people goes to stderr. Notes are fixed sentences; no secret is ever printed.

Exit codes: 0 every step done or skipped, 1 a step failed, 2 bad usage or not confirmed.

## If the app is dragged to the Trash

Squeak for Mac writes `app-install.json` in its support folder (`~/Library/Application Support/squeak`)
every time it launches. A daemon with that file is "app-managed" and watches for its app; a dev checkout
or CLI-only install has no file and never watches.

- Every 5 minutes (first look 2 minutes after the daemon starts) the daemon checks that the recorded app
  path is a folder with `Contents/Info.plist` whose bundle id is `com.squeak.mac`.
- Not there: it looks for another copy (`/Applications`, `~/Applications`, Spotlight), ignoring the Trash,
  mounted disk images (`/Volumes`) and build folders. A copy elsewhere means the app was moved, and the
  file is rewritten to point at it.
- A miss counts only with proof the app is really gone: a `Squeak*.app` in `~/.Trash`, or Spotlight
  demonstrably working and finding no copy. Otherwise the daemon logs "can't prove it was removed" once
  and does nothing.
- Three counted misses in a row (about 10 minutes, so an update swap or a re-copy never triggers it) start
  `squeak uninstall --orphan --yes`, detached. The app launching again rewrites the file and resets the
  count. One run per daemon start; if it cannot start, the next try is 24 hours later.
- `--orphan` means: keep your settings (`--keep-data`), ask no questions, skip the app step (it is gone),
  and skip the administrator rules, because nobody is there to type a password. When it finishes you get
  one notification, "Squeak was removed", which mentions the remaining rules only if they exist. Conductor
  is handed back first as always, and if that fails nothing else is touched.

To remove the administrator rules afterwards, run `squeak uninstall` (it asks for your password once), or
by hand: `sudo rm -f /etc/sudoers.d/squeak /etc/sudoers.d/squeak-fans /etc/sudoers.d/squeak-power
/Library/PrivilegedHelperTools/com.squeak.fans`.

## What is left on purpose

These live off this Mac, so Squeak does not touch them. The final message lists them:

- The iPhone app: delete it, which unpairs it.
- The Home Assistant add-on "Squeak Voice": remove it there.
- The Firebase project (named when `remote.json` or `SQUEAK_REMOTE_PROJECT` says which): delete
  it or leave it; it holds only sealed data. <https://console.firebase.google.com>
- The Telegram bot, if you made one: delete it with @BotFather. <https://t.me/BotFather>
- The Zoho Cliq bot.

## Finishing by hand

If a step failed, run the command again first. To do the important parts yourself:

- Conductor: with Conductor quit, `npx tsx scripts/conductor-relay.ts reset` from a checkout
  (it puts the two settings rows back), then reopen Conductor. In Keychain Access, remove
  Squeak's entry only if you know which one it is; the list item belongs to Conductor.
- Keychain: `security delete-generic-password -s "Squeak hotspot"` and
  `security delete-generic-password -s com.squeak.mac -a squeak`.
- Launch agents: `launchctl bootout gui/$(id -u)/com.squeak.daemon` (and `com.squeak.awake-backstop`),
  then delete `~/Library/LaunchAgents/com.squeak.*.plist`.
- Hooks: `squeak uninstall-hooks`.
