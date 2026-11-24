# Getting started with Squeak

Squeak is a Mac app where you and AI agents work together. It runs Claude and Codex chats for you, tells you which ones
need you, and lets you answer from the Mac, your iPhone, the web, Telegram or Zoho Cliq. This page is the longer
version of the README's Quick start.

## What you need

- A Mac with Apple silicon, running macOS 14 or later.
- Claude Code or Codex installed on the Mac, so Squeak has an agent to run.
- [Conductor](https://conductor.build), only if you want your Conductor chats in Squeak. It is an extension, off until
  you add it.

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

Squeak updates itself (Sparkle). You can turn automatic checks off in
Settings › About.

## 2. Set up

On first launch, choose **Set up Squeak** on the Welcome screen. The guided setup has four steps:

- **Start Squeak** installs the background service. Required.
- **Your agents** finds Claude Code and Codex on this Mac and connects them. Required.
- **Account** signs you in with Zoho, Google or email. Optional.
- **Your phone** is a reminder to sign in on your iPhone with the same account. Optional.

You can skip the optional steps. While any step is still to do, a **Finish setting up** card sits at the top of the
Settings sidebar. Open it to finish.

## 3. Add extensions (optional)

Settings › Extensions lists everything that is off until you add it:

- **Claude Code (external)** and **Codex (external)** show chats you started outside Squeak, in Terminal or the Claude
  desktop app. Adding one puts Squeak's hooks in that agent's settings; removing it takes them out again.
- **Conductor** shows your Conductor chats and lets you start one from Squeak.
- **Telegram**, **Zoho Cliq** and **Phone calls** are described below.

Terminal agents (`claude` or `codex` in Terminal.app) are answered by typing into their Terminal tab. That needs the
Accessibility permission and, the first time, an Automation prompt for Squeak Hands to control Terminal. Other
terminals (iTerm, tmux, ssh), Claude Desktop and Cowork stay watch-only.

## 4. Telegram (optional)

Squeak sends cards to a bot you own, with buttons to answer.

1. In Telegram, message **@BotFather**, send `/newbot` and copy the token.
2. Open **Settings › Telegram**, paste the token and choose which chats may
   talk to the bot.

## 5. Zoho Cliq (optional, Zoho orgs only)

The Cliq channel is built for a particular Zoho org setup: a managed org blocks
a personal Zoho OAuth app, so taps and replies come back through three Deluge
handlers you paste into a Cliq bot. If you are not in a Zoho org, skip it.
Follow [`cliq.md`](cliq.md).

## 6. iPhone and web (optional)

Sign in to Squeak on the Mac first (Settings › Account). Then sign in with the same account on your other devices. They
find your Mac by themselves. There are no codes to scan or type.

The iPhone app needs iOS 18 or later and is installed through SideStore, not the App Store. Add
`https://sibhimanyu.github.io/squeak/ios/source.json` as a source in SideStore.

If you would rather not sideload, open
<https://squeak-60083782173.development.catalystserverless.in/app/index.html> in a phone browser and sign in. The web
app covers less than the iPhone app; see [`web-app.md`](web-app.md).

The design is in [`remote-channel.md`](remote-channel.md).

## Known limits

- **Not notarized yet.** Expect the Gatekeeper warning on first open.
- **Apple silicon only**, macOS 14 or later.
- **Sessions in other terminals, Claude Desktop and Cowork are watch-only.**
- **No push notifications on the iPhone** with a free Apple ID (SideStore);
  Telegram or Cliq can carry them.

## Troubleshooting

**Sessions never show as "needs you" or never update instantly.**
For chats started outside Squeak, check that the Claude Code (external) or Codex (external) extension is added in
Settings › Extensions. That is what installs the hooks.

**The app says the background service is not running.**
Open **Settings › Background service**. Install it if it is missing, or
use Repair if a version failed its health check. The service listens only on
`127.0.0.1:8477`.

**Nothing can be sent.**
Sending, terminal sessions and every channel need the background service; fix
that first.

**Copy diagnostics.** Settings › Background service has Copy diagnostics, a redacted
report you can attach to a bug report.

To remove Squeak again, see [Uninstalling Squeak](uninstall.md).
