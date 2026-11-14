# Changelog

## [1.26.0] - 2026-11-14 (iOS)

- Sign in with your Squeak account and every Mac signed in to it is listed, with whether it is online, asleep or offline and when it was last seen. Open one and use it. Nothing to scan, no code to type.
- The first screen is just sign-in. A Mac that is not on an account yet is reached from one small link at the bottom ("Mac not on an account yet?").
- Switch between Macs from Home or Settings. Each Mac keeps its own chats on this iPhone.
- A Mac that asks first shows "Waiting for your Mac to approve".
- "Unpair" is now "Remove this iPhone from <Mac>" for one Mac; signing out removes this iPhone from all of them. An iPhone that was paired before keeps its Mac.

## [1.25.3] - 2026-11-13 (iOS)

- Recent no longer empties when a read fails.
- Face ID no longer drops the live stream.
- The connection bar no longer resizes the lists beneath it.
- Ponds are drawn exactly as the Mac sends them, and the last ponds are kept.

## [1.20.9] - 2026-10-30 (iOS)

- Settings shows the New chat presets link once.

## [1.20.6] - 2026-10-30 (iOS)

- Phone calls: pause calls for an hour, four hours, until tomorrow morning, or until you turn them back on.
- Phone calls: choose whether calls to you and calls you make ask for your calling PIN. Choosing "Don't ask" needs Face ID or your passcode first.

## [1.20.5] - 2026-10-29 (iOS)

- Photos you send now remain visible in your chat as tappable thumbnails; open them full screen to zoom, share, or save.

## [1.20.4] - 2026-10-29 (iOS)

- Phone calls: a clearer calling PIN status, with separate actions to change it, turn it off, or reset a forgotten PIN with Face ID or your passcode.

## [1.20.3] - 2026-10-29 (iOS)

- Scanning the Mac's pairing QR with the Camera app now opens Squeak and starts pairing.

## [1.20.2] - 2026-10-29 (iOS)

- Code blocks in messages are easier to select and copy.

## [1.20.1] - 2026-10-29 (iOS)

- Steer now, Edit and Delete stay on a message you queued even when your Mac can't list Conductor's queue for a moment (its relay reconnecting); they say why if the Mac can't act.

## [1.19.7] - 2026-10-29 (iOS)

- Turn the calling PIN off from Phone calls with Face ID or your passcode: no need to remember the old PIN, and it works while the PIN state is still loading.

## [1.19.6] - 2026-10-29 (iOS)

- Photos you send show up as real images in Conductor, and images sent from Conductor show as photos here.
- Calling PIN: change it, turn it off or on, and reset a forgotten one with Face ID or your passcode.
- New Settings switch to stop asking for Face ID before each send.

## [1.19.5] - 2026-10-29 (iOS)

- Make editable fields in Settings easier to identify and use, including
  extension, PIN, and hotspot fields.

## [2.0.0] - 2026-09-25

The project is now **Squeak**: a pager for coding agents, not a Telegram
chat bridge. The earlier bridge has been removed; its history remains in git.

### Added

- Squeak for Mac: a main window with every session, full messages, lettered
  decisions, replies and service control; packaged as `Squeak.app`.
- Replies typed into Conductor's own window (Squeak Hands), shown live.
- Squeak for iPhone, over an end-to-end encrypted Firebase channel with
  Secure Enclave–signed replies and on-Mac pairing approval.
- `DESIGN.md`: the design system every surface follows.

### Changed

- Agent hooks report with `X-Squeak-*` headers; `install-hooks` upgrades
  hooks written by earlier installs in place.
- `ship.sh` restarts Squeak and the duck and rolls back if Squeak does not
  come up.
