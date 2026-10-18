# Changelog

## 2.0.0

First release of the native Squeak app for macOS (menu bar, macOS 14+).

What exists:

- A menu-bar popover and a conversation window listing your Conductor chats
  (and, through the Squeak service, Claude and Codex sessions in Terminal),
  grouped as pinned, active and recent, with search over session titles and
  cached messages.
- Conductor chats are read straight from Conductor's own database, read-only,
  so the list and a chat's full history work without the Squeak service.
- Sending a message to a Conductor chat goes through the Squeak service
  (already installed with Squeak 1.x), which types it into Conductor's window.
  If the service is down, sending is disabled and Settings says why.
- Quick message window with an optional global shortcut, drafts that are never
  sent automatically, and notifications that never contain message text.
- Settings › Connections shows each source honestly; Settings › About has
  "Copy diagnostics" (redacted: no message text, titles, paths, ids or tokens)
  and a switch for the update check.
- A daily check against GitHub for a newer release. It shows a notice with a
  link to the release page; it never downloads or installs anything.

Not done or not verified:

- The Swift relay (direct Conductor delivery without the Squeak service) is
  written and tested but not wired in.
- Approvals, attachments and Telegram/Cliq/iPhone channels stay in the Squeak
  service or are unsupported.
- A live send from this app, the global shortcut, notifications and onboarding
  have not been exercised end to end.
- The build is ad-hoc signed and not notarized; Gatekeeper warns on first open.
