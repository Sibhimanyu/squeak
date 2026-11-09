# Conductor relay (Mac app add-on)

The Swift port of the Conductor relay client, and the app's half of the add-on: Settings › Conductor and the
Conductor step of setup. The daemon half is `addons/conductor-relay/` at the repo root.

## Why it is not distributed

The relay redirects Conductor's own Remote Control host to Squeak and adds a device to Conductor's Keychain item. The
release build leaves it out.

## Enable

`Package.swift` builds it in only when this folder exists and the environment asks for it:

```bash
cd macos
SQUEAK_ADDONS=conductor-relay swift build   # SQUEAK_CONDUCTOR_RELAY=1 also works
SQUEAK_ADDONS=conductor-relay swift test    # adds the ConductorRelayTests target
```

The app talks to it only through `AddonRegistry` / `ConductorLinkAddon` (core, `SqueakMacCore/Addons`). This target
registers a `RelayModel` from its own `SqueakMacAddons/InstalledAddons.swift`, which replaces the empty one in
`Sources/SqueakMacAddons` while the add-on is built in. The model describes Settings › Conductor as an `AddonPage`
that the app draws in its own design.

## Remove

Delete this folder and the block between the two `add-on block` comments in `macos/Package.swift` (the block only
turns itself off when the folder is missing, so deleting the folder alone also builds). Nothing else refers to it.
Conductor chats are still answered by Squeak Hands and the background route. If the relay was set up, the daemon's
core reset (`src/fleet/relay-retire.ts`) puts Conductor's settings back at the next daemon start.
