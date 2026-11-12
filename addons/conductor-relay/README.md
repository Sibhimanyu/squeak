# Conductor relay (daemon add-on)

Conductor's own Remote Control host connects to Squeak on loopback, and a reply or a new chat goes into Conductor
through Conductor's own composer: live in its window, with the screen locked. The Mac app's half is
`macos/Addons/ConductorRelay/`.

## Why it is not distributed

It sets Conductor's `roundhouse_client_url_override` to Squeak's loopback server and adds a paired device to
Conductor's Keychain item. That changes another product's settings and credentials store, so it stays in the
checkout, for development, and never ships in Squeak.app's bundle or the release.

## Enable

It `requires` the Conductor add-on (`addons/conductor/`): add Conductor in Squeak › Settings › Add-ons first, since
the relay loads only at start and only while Conductor is enabled. Then add `SQUEAK_ADDONS=conductor-relay` to
Squeak's `.env` (the older `SQUEAK_CONDUCTOR_RELAY=on` still works), run `npm run build` (it calls
`scripts/addons.sh build`, which bundles this folder to `dist/addons/conductor-relay/`), restart the daemon, then use Settings › Conductor in a Mac app built with the add-on
(`macos/Addons/ConductorRelay/README.md`). Without the build output or the env the daemon never loads it.

## Remove

Delete this folder. Nothing else names it: core finds add-ons at run time (`src/addons.ts`), `npm run build`,
`typecheck`, lint, prettier and vitest skip a missing folder, and Conductor chats are still answered by
Squeak Hands typing and then the background CLI.

If you set the relay up while it was enabled, Conductor still points at Squeak's loopback server. The Conductor add-on handles that
without this folder: at every daemon start (enabled or not), when this add-on did not load,
`addons/conductor/relay-retire.ts` puts Conductor back (backs up its database, removes the override row and Squeak's Keychain device) if the override is Squeak's own
loopback address. It never touches any other override. Restart Conductor once afterwards.

## Layout

`index.ts` is the entry (`Addon.activate`), `core.ts` the one place it reaches into the Conductor add-on and core, `service.ts`
the relay service Squeak's reply path uses, `setup.ts` the `/control/relay*` routes' logic, `scripts/` fixture
generation for the Swift port.
