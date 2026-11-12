# Conductor (daemon add-on)

Everything in Squeak that knows Conductor (the Mac app by Melty, its `conductor.db`, Squeak Hands typing into its
window) lives here. It ships in every build (`addon.json`: `distributed`) and is inert until the owner enables it in
Settings › Add-ons (core's `addons.json`). Core knows only `src/addons.ts`; this folder imports core, never the other
way round.

- `index.ts` activates it: observer (`observer.ts`, with its `SourceRules`, watch paths and `waiting-resolve.ts`),
  replier (`replier.ts` window typing then background CLI, `mirror.ts`, `ui.ts`, `close-chat.ts`, `answer.ts`, queue,
  stop, setup), new chats (`new-chat.ts`, `chat-models.ts`), workspace actions, icons, front-app tabs (`tabs.ts`),
  core adapter, `squeak import-conductor` / `move-from-conductor`, and the `/control/conductor/link` and
  `/control/conductor/workspaces` routes the current Mac app uses.
- Workspace picks live in `<support dir>/conductor/workspaces.json`, starting empty. The old `conductor-link.json` is
  ignored and left alone.
- `relay-maintenance.ts`: at every start, enabled or not, puts Conductor back when it still points at Squeak's old
  loopback relay and the relay add-on did not load; also the `squeak uninstall` step that hands Conductor back.
- `registry.ts` opens `conductor.db` lazily, only while enabled.

Build: `scripts/addons.sh build` bundles it to `dist/addons/conductor/` (one self-contained file plus `addon.json`);
`macos/scripts/embed-daemon.sh` does the same into the app's daemon. Remove: delete this folder; core still builds and
runs, and Conductor simply isn't offered.
