# Deployment

Everything on the Mac runs from the **main checkout** (`~/conductor/repos/squeak`):
the daemon (`com.squeak.daemon`, `dist/squeak/cli.js`). Squeak for Mac is a
separate, self-contained native app (`/Applications/Squeak.app`) that is _not_
run from the checkout: it is built and released from `macos/`
(`macos/scripts/release.sh <version>`: tests, DMG, Sparkle appcast; it prints
the publish steps and never runs them) and updates itself through Sparkle.
Conductor workspaces are **git worktrees** on their own branches, so your edits
are isolated from the live processes. Nothing you do reaches them until it is
shipped:

```bash
./scripts/ship.sh
```

It runs CI, merges your branch into the live branch, builds beside the live
`dist` rather than over it, smoke-tests that the build imports, swaps it in,
then restarts the daemon. It does not touch the Mac app. If Squeak does not answer on `127.0.0.1:8477` it restores
the previous `dist` and leaves the bad build at `dist.failed`. The iPhone app
ships separately with `ios/scripts/release.sh`.

**Squeak.app also owns the daemon for installs without a checkout** (`macos/scripts/embed-daemon.sh`
bundles it; `DaemonManager` installs it to `~/Library/Application Support/squeak/daemon/<version>`, switches
`current`, health-checks and rolls back). A launch agent whose plist runs a git checkout (this dev loop) is
detected and left alone: the app never replaces or restarts it. `ship.sh` remains the way to update it.

**The native session host is its own launch agent** (`com.squeak.host`, `squeak host`, KeepAlive always, written and
loaded by `install-squeak-agents.sh` beside the daemon). `ship.sh` restarts it only when `src/native/` changed in what
it ships _and_ `GET /native/sessions` shows no chat working or waiting (host down counts as safe); otherwise it prints
"host not restarted: N chats running; rerun with --restart-host when they finish". `--restart-host` forces it. After a
restart the host must answer within 10 s or `ship.sh` warns loudly; it never rolls the daemon back for it.

Rules:

- **Never** run `npm run build` against the live checkout. It does `rm -rf dist`,
  and a failed compile would leave Squeak with no code to restart into.
- Only ship when the user asks. Editing and testing freely in the worktree is
  fine and expected; putting code live is their call.
- Commit before shipping — `ship.sh` refuses a dirty worktree.
- **A Mac release is one command, run by the `mac-release` agent (Haiku, `.claude/agents/mac-release.md`), never by hand
  or by a bigger model:** `macos/scripts/release-mac.sh <version>` (`--dry-run` builds and publishes nothing). It builds
  `origin/master` in its own warm checkout (`~/.squeak-release`), so other chats' uncommitted edits cannot ride along
  and a release does not wait for a clean tree; the version needs a `## <version>` section in `macos/CHANGELOG.md`
  _on master_. It makes the GitHub release with the DMG as its asset (`gh release upload --clobber`; the appcast enclosure is
  `https://github.com/Sibhimanyu/squeak/releases/download/v<version>/Squeak-<version>.dmg`, which Sparkle follows through
  its redirect to the asset host), publishes only the appcast and delta patches to sibhimanyu.github.io through the Git
  Data API (`publish-pages.sh`: no clone of that 1.6 GB repo, the commit may touch only the paths it names, never a DMG:
  three 66 MB DMGs made a ~208 MB deploy that timed out at "syncing_files"; `--prune-dmgs` is a one-time, manual
  cleanup of old Pages DMGs), waits until the live appcast on Pages and the DMG at the release URL both answer
  (`--finish` copes with a release made the old way, DMG on Pages), updates
  `website/release.json` and pushes the version commit. One at a time (`/tmp/squeak-mac-release.lock`). The uplink is
  the floor (~1 MB/s: a 50 MB DMG is ~1.5 min), so the DMG is uploaded once. The iPhone app has its own
  `ios/scripts/release.sh`; the daemon ships with `scripts/ship.sh`.

- **Conductor is an add-on the owner adds, off until then** (`addons/conductor/`, `src/addons.ts`; core's `addons.json`
  in the support dir, `{ enabled: { [id]: { enabledAt } } }`, absent = none). Every Mac starts with it off, including
  ones that were linked before: the old `conductor-link.json` is neither read nor deleted. Off: the observer returns
  nothing (conductor.db is not even opened), the replier, new-chat, workspace actions, icons, tabs and relay route
  refuse or answer empty with "Conductor isn't added to Squeak. Add it in Squeak › Settings › Extensions."; terminal,
  Claude, Codex and native chats are unaffected. `GET/POST /control/addons` (token-gated; `[{id, name, blurb,
available, enabled}]` / strict `{id, enabled}`), `/state.addons` (enabled ids). The add-on keeps serving
  `GET/POST /control/conductor/link` (`{linked, available, appInstalled}`; POST `{linked}` is enabling or disabling it)
  and `GET/POST /control/conductor/workspaces` for the current Mac app, and `/state.conductorLinked` /
  `conductorWorkspaces`. Enabling takes effect on the next refresh without a restart, Enabling alone
  shows nothing: the owner ticks Conductor workspaces (`<support dir>/conductor/workspaces.json`, starting empty). The
  observer still returns chats in unpicked workspaces but flagged closed and retired, so their transcripts are not
  rediscovered as anonymous sessions and nothing renders or pushes; the replier refuses them. The add-on's
  `maintenance` hook runs at every start whether or not it is enabled: when
  Conductor's `roundhouse_client_url_override` is Squeak's own loopback address, it puts Conductor back. A distributed
  add-on is one esbuild bundle (`scripts/addons.sh build`, `macos/scripts/embed-daemon.sh` puts `conductor` in the app's
  daemon); core must stay buildable and runnable with `addons/` deleted.
  `notify` finishes mode `conductor` is now `replyable` (the old spelling is still read from files and old phones).

- The relay as one AppSail server, the dual-run with the function, cutover and rollback: `docs/cloud-cutover.md`.
