<p align="center">
  <img src="brand/logo/svg/squeak-duck-full-color.svg" alt="Squeak duck" width="100">
</p>

# Your agents. In view.

**A pager for your coding agents, with a duck.**

Squeak is a native Mac app that runs Claude Code and Codex chats and pages you
when one needs you. Every project is a pond. Work on a branch gets its own
stream, a separate git worktree. An agent's helpers are ducklings. Step away
from the desk and keep going from your iPhone, a browser, Telegram or Zoho Cliq.

It also watches the Claude Code and Codex sessions already running on your Mac,
with replies supported in Apple's Terminal. Squeak is free, open source and
independent.

**[Download for Mac](https://github.com/Sibhimanyu/squeak/releases/latest)** ·
[Website](https://sibhimanyu.github.io/squeak/) ·
[Getting started](docs/getting-started.md) · [Uninstall](docs/uninstall.md) ·
[Report an issue](https://github.com/Sibhimanyu/squeak/issues)

<p align="center">
  <img src="website/assets/mac-decision.webp" alt="Squeak for Mac: sessions grouped by attention, with an agent's question and answer choices open" width="920">
  <br><sub>Product preview with example sessions.</sub>
</p>

## Keep the work moving

- **Run chats in Squeak.** Start Claude Code and Codex chats from a pond, a
  branch, a PR or an issue. Each runs in its own stream, so work never collides.
- **See what needs you.** Questions, approvals, finished work, errors and active
  sessions have a place in one inbox. Read the agent's own messages and activity.
- **Answer in context.** Pick a lettered answer, respond to a question or plan,
  or write a message. Squeak checks delivery before calling a reply sent.
- **Stay close without staying at the desk.** Pair an iPhone or browser; add
  Telegram or Cliq cards when you want another way to hear about waiting work.
- **Reach it quickly.** A menu-bar duck, notifications and a configurable
  quick-message shortcut keep the inbox within reach.

Question and plan responses have different routes and limitations, explained in
[Answering questions](docs/answering-questions.md). Ponds are described in
[docs/ponds.md](docs/ponds.md).

## Install and set up your Mac

**Requirements:** an Apple-silicon Mac running **macOS 14 or later**, plus the
coding agents you want to run (Claude Code, Codex). The download includes Node and Squeak's
background service, so normal installation needs no terminal or developer tools.
There is no Windows, Linux or Intel Mac app in this repository's release builds.

1. **Download the DMG and checksum** from
   [the latest release](https://github.com/Sibhimanyu/squeak/releases/latest).
   Verify the download if desired:

   ```bash
   # Run in the folder containing your downloaded DMG.
   shasum -a 256 Squeak-*.dmg
   ```

   Compare the result with `Squeak-<version>.dmg.sha256`.

2. **Drag Squeak to Applications and open it.** Builds are signed with a
   development certificate and **are not notarized**. On first launch, use
   right-click → Open; if macOS blocks it, use **System Settings → Privacy &
   Security → Open Anyway**. Look for the duck in the menu bar.
3. **Choose “Set up Squeak” in Welcome.** Follow **Settings → Setup** to install
   the background service and agent hooks. Hooks provide live state and waiting
   signals; installation preserves other tools' hook entries. It also adds
   removable instructions for agents to end questions with lettered choices.
4. **Enable the conveniences you want.** The Setup checklist links to
   notifications, the quick-message shortcut and live typing permissions.
   You can add remote channels later.

Updates are delivered through Sparkle; use **Settings → About → Check for
Updates** or adjust automatic checks there. Squeak's own chats and the session
list need the background service.

### Which permissions do I need?

| Feature                           | Permission or setup                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| macOS notifications               | Allow Squeak notifications when prompted.                                                                       |
| Double-tap quick-message shortcut | Allow **Squeak** in **Privacy & Security → Input Monitoring**. The alternate keyboard shortcuts do not need it. |
| Type into Terminal (or Conductor) | Allow **Squeak Hands** in **Privacy & Security → Accessibility**. Hands is Squeak's typing helper.              |
| Reply to a Terminal agent         | Also allow Squeak Hands to control **Terminal** at the Automation prompt.                                       |

### Supported sessions

| Source on your Mac                         | Read and watch | Reply                                                               |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| Squeak's own Claude and Codex chats        | Yes            | Yes.                                                                |
| Claude Code or Codex in Apple's Terminal   | Yes            | Yes, at an eligible empty agent prompt, with the permissions above. |
| Conductor chats (optional add-on)          | Yes            | Yes, once the add-on is added.                                      |
| Other terminals, Claude Desktop and Cowork | Watch-only     | No.                                                                 |

## Works with Conductor (optional add-on)

If you also use [Conductor](https://conductor.build), add it in **Settings ›
Add-ons**. Squeak then shows your Conductor chats in the workspaces you pick and
can answer them by typing into Conductor's own window. Squeak reads Conductor's
database and never writes to it. It is off until you add it, and nothing else
depends on it. Details: [the integration notes](docs/conductor-local-feasibility.md).

## Take the inbox with you

Your Mac must be awake, online and running Squeak for remote actions. You can
use Squeak's keep-awake controls when stepping away.

### iPhone and web browser

In Squeak for Mac, open **Settings › iPhone** and choose **Set up…**. Squeak
sign in to your Squeak account: Squeak hosts the cloud, so signing in is the
whole setup (no Firebase project, no server of your own). Details are in the
[remote channel guide](docs/remote-channel.md).

1. Choose your client:
   - **Web:** open [Squeak for Web](https://squeak-60083782173.development.catalystserverless.in/app/index.html) in your browser;
     no app installation is needed.
   - **iPhone:** install through SideStore using the
     [iPhone installation page](https://squeak-5c9gvo.web.app/). The native app
     requires **iOS 18 or later** and is not distributed through the App Store.
2. In **Settings → iPhone** on the Mac, choose **Pair an iPhone**. Scan the QR
   code in the iPhone app or use the pairing link in Squeak for Web, then
   approve the device on your Mac.

The native iPhone app supports Face ID and a direct route on the same Wi-Fi;
web uses the cloud route. Free Apple ID / SideStore installs do not receive
native iPhone push notifications; Telegram and Cliq can provide alerts.

Squeak hosts the cloud for the phone, web and Cliq; a Squeak account is required
and signing in on the Mac sets it up (see
[the remote channel guide](docs/remote-channel.md)).

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`. In
**Settings → Telegram**, enter its token and allow only the chats you want to
use. The bot sends attention cards with answer buttons and accepts replies.
Telegram uses its own bot service and does not require the iPhone channel.

### Zoho Cliq and phone calls

[Zoho Cliq setup](docs/cliq.md) covers the bot, owner restriction, webhook and
three Deluge handlers for two-way cards. It needs a Squeak account (the hosted cloud) or, on older installs, your own Firebase relay.

[Phone call setup](docs/voice.md) covers SIP/PBX calls that read a waiting
question and accept a keypad answer. Use a direct PBX connection or the Home
Assistant voice gateway. This is optional and needs additional infrastructure.

## Privacy and control

The Mac app reads local session data. Its background service listens on
`127.0.0.1:8477`; local control routes require a token.
The iPhone and web channel encrypt data end to end. The Mac accepts commands
only from approved device keys and checks signatures, freshness and replay
protection. You can disconnect devices from **Settings → iPhone**. Treat pairing
codes as secrets: a paired device can read sessions and send instructions to
your agents.

Telegram and Cliq use their providers' messaging services; they do not have the
phone channel's end-to-end encryption. Only connect channels you trust with
your agent conversations. The Mac app's message cache is encrypted on disk,
can be deleted in Settings, and expires after 14 days, with a 50 MB cap.

## Troubleshooting

| Symptom                                   | Next step                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Reading works, but sending is unavailable | Check **Settings → Connections** and **About → Background service**; install or repair the service.         |
| Waiting states are missing or slow        | Run **Agent hooks** again in **Settings → Setup**.                                                          |
| Live typing fails                         | Check Squeak Hands' Accessibility grant and Terminal Automation permission. Other terminals are watch-only. |
| A phone stops updating                    | Check that the Mac is awake and online, then check your connection in **Settings → iPhone**.                |

For a bug report, use the app's **Report** button or
[GitHub Issues](https://github.com/Sibhimanyu/squeak/issues).
**Settings → About → Copy diagnostics** provides a redacted connection report.
The [getting-started guide](docs/getting-started.md) has more detail.

## Build and contribute

For daemon development, use **Node.js 22 or later**, npm and a native build
toolchain for `better-sqlite3` (on macOS, Xcode Command Line Tools). The native
Mac app additionally needs a Swift 6 toolchain. iPhone builds need Xcode and
XcodeGen; see [`ios/project.yml`](ios/project.yml) and
[`ios/scripts/release.sh`](ios/scripts/release.sh).

```bash
git clone https://github.com/Sibhimanyu/squeak.git
cd squeak
npm ci
npm run build
node dist/squeak/cli.js help
npm run ci
```

Run the daemon in the foreground with `node dist/squeak/cli.js start`. Stop an
existing Squeak service first so both processes do not compete for the same
port. Native development and packaging are described in
[`macos/README.md`](macos/README.md); the marketing site has its own
[`website/README.md`](website/README.md).

Useful CLI commands from the repository root:

```bash
node dist/squeak/cli.js config-path      # locate the .env file
node dist/squeak/cli.js init             # create a template without prompts
node dist/squeak/cli.js setup            # interactive Telegram configuration
node dist/squeak/cli.js hooks-status
node dist/squeak/cli.js install-hooks
node dist/squeak/cli.js uninstall-hooks
```

Configuration and secrets normally live in
`~/Library/Application Support/squeak/`; `SQUEAK_ENV_PATH` overrides the `.env`
path. Local Mac development tests:

```bash
(cd macos && swift test)
(cd ios/SqueakCore && swift test)
```

Read [`CLAUDE.md`](CLAUDE.md) for engineering context and [`DESIGN.md`](DESIGN.md)
for the shared design system. Additional guides cover
[the web client](docs/web-app.md), [questions and plans](docs/answering-questions.md)
and [RasanAI workflow integration](docs/rasanai-plugin.md).

## History

Squeak began as a fork of
[conductor_mobile](https://github.com/xudong963/conductor_mobile); see
[docs/PROVENANCE.md](docs/PROVENANCE.md).

## License

[Apache-2.0](LICENSE), with attribution in [NOTICE](NOTICE).
