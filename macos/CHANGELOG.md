# Changelog

## 2.0.2

Updates install themselves, and Squeak behaves like a real app while its window is open.

- Updates install themselves (Sparkle 2). Squeak checks once a day, downloads a new
  version signed with Squeak's own key, and installs it when you quit or relaunch.
  "Check for Updates…" is in the app menu, the popover's gear menu and Settings,
  About; "Automatically check for updates" is a switch there. This replaces the old
  notice that only linked to the GitHub release.
- While the conversation window, Settings or Welcome is open, Squeak shows a Dock
  icon, appears in Cmd-Tab and has its own menu bar (About, Check for Updates…,
  Settings…, Edit, Sessions, Window, Help). When the last of them closes it goes
  back to the menu-bar duck alone; it never quits. The popover on its own does not
  change this. Clicking the Dock icon with no window open reopens the conversation.
- The build number now grows with every version (2.0.2 is 20002) so updates compare
  correctly.

## 2.0.1

A calmer redesign of every screen.

- New menu-bar icon: a crisp template duck, traced from the brand artwork, that
  follows light and dark menu bars; it shows a count when chats need you and
  dims when Squeak is offline.
- Popover: list-first, grouped as Needs you, Working, Recent and Earlier. A chat
  that needs you shows its question with one-tap answer chips and an inline
  reply. "All quiet" when nothing does.
- Window: a centred reading column; agent replies are plain prose, your
  messages sit on a soft fill; the question that needs you is marked in red with
  answer chips under it; a floating composer.
- Quick message is a Spotlight-style panel; Settings uses native tabs and
  grouped forms; onboarding is shorter and quieter.

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
- Messages render safe Markdown (headings, lists, quotes, code blocks, bold,
  italic, inline code). Links show their address as text and are never
  clickable; no HTML is interpreted.
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
