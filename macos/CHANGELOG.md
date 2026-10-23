# Changelog

## 2.1.19

- A chat whose reply ends with a question ("Want me to open a PR?") now counts as needing you:
  it moves to Needs you, shows the question, and raises the same banner as an agent waiting on
  an answer. Click the banner to answer in Quick message.

## 2.1.18

- The menu-bar panel no longer sits inside a taller, square-edged window after a section folds:
  the window shrinks to the panel, and its shadow is redrawn to match.

## 2.1.17

- Quick message: when Send is off because Squeak has no way to reply to the chat it is aimed at
  (a chat that is not Conductor's, or a Claude or Codex it cannot type into), it now says so and
  points to the To menu, instead of leaving a greyed button.

## 2.1.16

- Keep Mac awake: the menu lists the lid-closed choices first, so a Mac you set to stay
  awake stays awake with its lid shut. Lid open, and until you end it, are still there.

## 2.1.15

- Two new shortcuts for Quick message, easy to reach with one hand: ⌃⇧ Space and
  ⌃⇧ K. Choose one in Settings.
- ⌘\ shows or hides the sidebar from anywhere in the window, even while typing.
- The session list now says "10 sessions · 3 working" instead of "10 active
  across your Mac", which also counted finished and errored chats.

## 2.1.14

- Settings now opens inside the main window, System Settings style: a sidebar of
  pages (General, Connections, Telegram, Zoho Cliq, iPhone, Privacy, About)
  and one page at a time. Esc or Back to sessions returns to your chats.

## 2.1.13

- Squeak for Web moved to its own address, squeak-mac.web.app.

## 2.1.12

- Pairing now has a Copy pairing code button, for Squeak for Web
  (squeak-mac.web.app): paste the code there, then approve here.

## 2.1.11

- A redesigned menu-bar panel: chats are grouped into Needs you, Errors,
  Finished, Working and Idle (Idle folded away), each row shows its state, age,
  repo and agent, and a finished chat shows the start of its reply. New chat
  sits in the header; Settings, Check for Updates and Quit are under "…".
- Rows stay in place while the pointer is over the list, and Escape closes the panel.
- Clicking a notification shows the reply that notification was about, even
  if the chat has moved on since. If that reply can't be found, it says so
  instead of showing a different one.
- A reply only counts as read once you have actually seen it.

## 2.1.10

- Quitting Squeak from the Dock, or with ⌘Tab then Q, while its window is open
  now closes the window like ⌘Q does, and Squeak keeps running in the menu
  bar. "Quit Squeak" in the menu-bar panel, ⌥⌘Q, and logging out or shutting
  down still quit it completely.

## 2.1.9

- Clicking a notification opens the quick message on exactly that chat, also
  when Squeak was not running: the click is kept until the app is ready
  instead of being dropped at launch.
- Opening Squeak from Spotlight or Finder, or the activation a clicked
  notification causes, shows the quick message instead of the conversation
  window, and Squeak no longer opens a window by itself at launch.
- ⌥ Space is the default quick message shortcut. Anyone still on the old
  ⌥⌘M default is moved to it once; it stays selectable in Settings.
- Notifications have no inline reply. Clicking one, or dismissing it, never
  sends anything; unsent text stays as a draft per chat.

## 2.1.8

- ⌘Q in Squeak's window now closes the window and keeps Squeak in the menu
  bar. "Quit Squeak" in the menu-bar panel, or ⌥⌘Q, quits it completely.
- Clicking a notification opens the quick message on that chat. Unsent text
  is kept per chat, and the composer closes when you click elsewhere or
  switch Spaces.
- Refreshing Claude usage reads it with Claude Code's own sign-in and spends
  no tokens.

## 2.1.7

- A compact menu-bar panel in the style of macOS system menus, with grouped
  sections, inset dividers, and full-width actions for messages, chats and settings.
- The panel fits the display it opens on and keeps its actions reachable on
  smaller screens. New chat is available with ⌘N from the panel.

## 2.1.6

- Keep Mac awake with the lid closed, from the menu bar: "Set up lid-closed…"
  asks for your Mac password once (macOS's own prompt), then "Lid closed too"
  sessions start from the popover or your iPhone without asking again. Squeak
  checks the rule allows only its four sleep and Low Power Mode commands
  before installing it.

## 2.1.5

- Notifications say what a session wants: a question ("is asking you
  something", with the question when session names are on), a plan to review,
  or an approval. A second question in a chat that is still waiting notifies
  again.
- Reply to a finished Conductor chat straight from its notification.
- Settings says when macOS is hiding Squeak's banners (alert style None) and
  opens the right pane to fix it.

## 2.1.4

- Quick message (⌘K) is a glass pill: type on top; the chat, its state, repo
  and agent under it, with a round Send. A soft warm light glows from under it
  and breathes while your message sends. ⌥↩ steers a working agent.

## 2.1.3

- The awake session shows on the Mac: what is left beside the duck in the menu
  bar ("1:52", "∞" until you end it), and a Keep Mac awake row in the popover
  to start one, add an hour, or end it.
- When the Mac has switched to your iPhone's hotspot, the popover says so.

## 2.1.2

- Usage bars show what is left, like a battery: "58% left", full once a
  window resets.

## 2.1.1

- A usage window that has reset since its last reading now says Reset and
  draws an empty bar, instead of keeping the old window's number (a 76% bar
  for a window that had just started over).

## 2.1.0

- Answer an agent's question from Squeak: when Claude asks you to choose (one
  option, several, or your own words) or approve a plan, the window and the
  menu-bar panel show it as a card. Squeak delivers your answer to that chat:
  through Conductor when it can, otherwise by stopping the waiting question and
  sending your answer as a message (the card says so first).

## 2.0.9

- Start a new Conductor chat from Squeak: ⌘N, the menu-bar panel or Quick
  message. Pick the workspace and agent, write the first message.
- Finishes and changes show up within a couple of seconds: Squeak watches
  Conductor's database instead of checking on a timer.
- Session headers in two lines; Send holds Steer while an agent works.

## 2.0.8

- Settings › About has Report a problem… to tell us what's broken, confusing
  or could be better (Help › Report a problem still works).

## 2.0.7

- Messages read like documents: headings, lists, tables, code with Copy,
  quotes, and links you can copy but never open by accident.
- Sending shows your message at once with one status line, then what the
  agent is doing ("Running tests…") until its reply arrives. The reply box
  stays put.
- While an agent works, Send becomes Queue (it reads your message after this
  turn), with Steer now to send it into the turn in progress. Each message
  says whether it was sent, queued or steered.
- A chat waiting on a question or a plan now shows as needs you, with the
  question.
- Usage: Claude and Codex limits in the menu-bar panel and the window, with
  Refresh for Claude.
- The menu-bar panel is glass, like the rest of macOS.

## 2.0.6

- Settings › Channels: set up Telegram (paste a bot token, link your chat by
  messaging the bot, send a test message) and Zoho Cliq, without the
  terminal. Saved tokens are never shown again.
- Settings › iPhone: pair Squeak for iPhone with a QR code and approve it on
  the Mac; see and remove paired phones.
- Updates download from sibhimanyu.github.io, which works on networks that
  stall GitHub's release downloads.

## 2.0.5

- Follows Squeak's design guide throughout: the approved duck (facing right),
  the brand yellow, red for "needs you", and plain sentence-case wording.
- Session rows lead with the chat's title, then repo and agent, then what the
  agent is doing right now. Groups: needs you, done, working, error, idle.
- Lucide icons everywhere, the same set as Conductor.
- The menu-bar duck is regenerated from the approved logo.
- Send is ink on light and duck yellow on dark; glass on the reply box, the
  answer rows and Send on macOS 26.
- Help › Report a problem… (⌥⌘R) sends feedback straight to the team.

## 2.0.4

- A new main window: a native three-column layout with a translucent sidebar
  (filters with counts, sources, service status), a session list whose rows say
  what each agent is doing right now ("Running tests", "Waiting for your answer"),
  and a conversation pane with Conversation and Activity tabs.
- Questions with lettered options show as large answer cards with a
  "Recommended" badge; one click sends the letter.
- Liquid Glass on macOS 26 for the reply box, answer cards and Send, with
  fallbacks on older macOS; Reduce Motion and Reduce Transparency are respected.
- The main window and Settings now open on a normal desktop instead of on top of
  another app's full-screen window. The popover and Quick message still appear
  over full screen.

## 2.0.3

- Opening the Squeak window from the menu-bar duck now gives Squeak the menu bar
  (it said "Finder" or whichever app was in front before).
- No more Keychain prompts: the key for the local message cache is now a private
  file beside the cache (0600), not a Keychain item that macOS asked about again
  after every update. The old cache is rebuilt once.

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
