# Changelog

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
