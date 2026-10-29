# Getting started with Squeak

Squeak is a menu-bar app for your Mac that shows every Claude Code and Codex
session on it, tells you which ones need you, and lets you answer them. This
page is the longer version of the README's Quick start.

## What you need

- A Mac with Apple silicon, running macOS 14 or later.
- [Conductor](https://conductor.build) if you want to answer Conductor chats or
  start new ones from Squeak. Without it, Squeak still watches `claude` and
  `codex` sessions in your terminal.

## 1. Install Squeak for Mac

1. Download `Squeak-<version>.dmg` and its `.sha256` file from the project's
   GitHub releases (`Sibhimanyu/squeak`).
2. Check the download: `shasum -a 256 Squeak-<version>.dmg` must print what the
   `.sha256` file contains.
3. Open the DMG and drag `Squeak.app` to Applications.
4. The build is signed with a development certificate and is **not notarized
   yet**, so macOS warns the first time. Right-click the app, choose Open, then
   Open again. If macOS still blocks it, go to System Settings › Privacy &
   Security and choose **Open Anyway** next to the Squeak message.
5. Squeak has no Dock icon. Look for it in the menu bar.

Squeak updates itself (Sparkle). You can turn automatic checks off in
Settings › About.

## 2. Run the first-run Setup checklist

Squeak bundles its background service (the "daemon"). Nothing is installed
silently: the Setup checklist installs each piece when you ask. It lists:

| Item                                          | What it does                                                                              | Required      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| Background service                            | Watches your sessions and serves them to the app, the phone and Telegram.                 | Yes           |
| Agent hooks                                   | Lets Squeak know at once when an agent finishes or waits for an approval.                 | Yes           |
| Conductor                                     | Connects to Conductor (see step 3).                                                       | If you use it |
| Notifications                                 | macOS notifications when a session needs you.                                             | Recommended   |
| Quick-message hotkey                          | The double-tap shortcut that opens the quick composer.                                    | Optional      |
| Reply into Conductor's window (Accessibility) | Lets Squeak Hands type a reply into Conductor's own window so it shows and streams there. | Optional      |
| Channels                                      | Telegram, Zoho Cliq, iPhone (steps 4 to 6).                                               | Optional      |

Reading Conductor chats works with nothing else set up.

## 3. Turn on live replies and new chats (Conductor)

Reading is free; replying and starting chats from Squeak need Conductor's
remote-control relay pointed at Squeak.

1. Open **Settings › Conductor** and press the setup button. Squeak backs up
   Conductor's database before it changes anything, and can undo the change
   from the same page.
2. macOS may show a **Keychain prompt**. Squeak adds one login Keychain item
   that Conductor's relay needs. Allow it.
3. **Quit and reopen Conductor once.** It only reads the setting at launch.
4. Settings › Conductor should say connected. This can take a moment after
   Conductor starts.

Terminal agents (`claude` or `codex` in Terminal.app) are answered by typing
into their Terminal tab. That needs the optional Accessibility step and, the
first time, an Automation prompt for Squeak Hands to control Terminal. Other
terminals (iTerm, tmux, ssh), Claude Desktop and Cowork stay watch-only.

## 4. Telegram (optional)

Squeak sends cards to a bot you own, with buttons to answer.

1. In Telegram, message **@BotFather**, send `/newbot` and copy the token.
2. Open **Settings › Telegram**, paste the token and choose which chats may
   talk to the bot.

## 5. Zoho Cliq (optional, Zoho orgs only)

The Cliq channel is built for a particular Zoho org setup: a managed org blocks
a personal Zoho OAuth app, so taps and replies come back through three Deluge
handlers you paste into a Cliq bot and a relay in your own Firebase project.
If you are not in a Zoho org, skip it. Follow [`cliq.md`](cliq.md).

## 6. iPhone (optional, needs your own Firebase project)

The iPhone app is installed through SideStore, not the App Store. It reaches
your Mac through a Firebase project that **you** create (the free plan is
enough); there is no hosted backend you can sign up for. The data stored there
is encrypted, and replies are signed by a key on the phone that you approve on
the Mac.

1. Create the Firebase project and set `SQUEAK_REMOTE_PROJECT` to its id in
   Squeak's `.env`.
2. In the Mac app, choose iPhone › Pair an iPhone and scan the code with the
   iPhone app.

The full design and setup are in [`remote-channel.md`](remote-channel.md).

### No install: Squeak for Web

If you would rather not sideload the app, open <https://squeak-mac.web.app/> in
a phone browser. It has the same features as the iPhone app (new chats with
presets and split, answering plans and questions, queue and steer, Mac
controls, keep awake, notifications, usage, films review), except Face ID and
the same-Wi-Fi direct route. It needs the same Firebase project
(`SQUEAK_REMOTE_PROJECT`). Pair by choosing iPhone › Pair an iPhone in Squeak
for Mac, then scan the code with the page's camera button or paste the link.
The iPhone app is optional.

## Known limits

- **Conductor's interface is undocumented.** Live replies depend on how
  Conductor's remote control works today. A Conductor update can break it.
  Squeak is tested against specific Conductor versions and logs a warning on
  any other. If replies stop after an update, restart Conductor first.
- **Not notarized yet.** Expect the Gatekeeper warning on first open.
- **Apple silicon only**, macOS 14 or later.
- **Sessions in other terminals, Claude Desktop and Cowork are watch-only.**
- **No push notifications on the iPhone** with a free Apple ID (SideStore);
  Telegram or Cliq can carry them.

## Troubleshooting

**Replies or new chats fail with "relay isn't connected".**
Open Settings › Conductor. If it says to restart, quit and reopen Conductor.
If it says Conductor's version is untested, Squeak has left the relay off for
safety. Make sure Conductor's own mobile or remote access is not showing an
error. Reply typing into Conductor's window still works with the Accessibility
step.

**Sessions never show as "needs you" or never update instantly.**
The agent hooks are missing. Re-run the **Agent hooks** item in the Setup
checklist. Squeak merges them into `~/.claude/settings.json` without removing
other tools' entries.

**The app says the background service is not running.**
Open **Settings › About › Background service**. Install it if it is missing, or
use Repair if a version failed its health check. The service listens only on
`127.0.0.1:8477`.

**Reading Conductor chats works, but nothing can be sent.**
Sending, terminal sessions and every channel need the background service; fix
that first.

**Copy diagnostics.** Settings › About › Copy diagnostics gives a redacted
report you can attach to a bug report.
