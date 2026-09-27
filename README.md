# Squeak

A pager for your coding agents, with a duck.

Squeak watches every Claude Code and Codex session on your Mac — the ones
[Conductor](https://conductor.build) runs and the ones in your terminal — and
tells you, at a glance, which ones need you. When an agent finishes or stops
to ask something, you can read what it said and answer it from your Mac, your
iPhone, or Telegram.

| Surface | What it does |
| --- | --- |
| **Squeak for Mac** (`~/Applications/Squeak.app`) | Every session grouped by what needs you; the agent's full last message; one-tap answers to lettered questions; replies; start and restart the service. |
| **The duck** | A floating rubber duck and menu-bar icon: its mood says whether anything is working, finished, or waiting on you. |
| **Squeak for iPhone** | The same list and answers, from anywhere. Installed through SideStore. |
| **Telegram** | Push cards when an agent is blocked or a Conductor chat finishes, with buttons to answer. |

The design system every surface follows is in [`DESIGN.md`](DESIGN.md).

## How it works

A small daemon (`squeak start`, run by launchd) reads agent transcripts,
Conductor's database and live agent hooks, and serves the result on a
loopback port (`127.0.0.1:8477`). Every surface draws from that one state, so
they never disagree.

Replies go into Conductor's own window, so they show up and stream there
live — typed by **Squeak Hands**, a tiny signed helper that is the only thing
holding the Accessibility permission. When the Mac is locked or the chat is
not open, the reply runs in the background instead and Conductor shows it the
next time it loads the chat.

An agent running in **Terminal** — `claude` or `codex` started by hand — is
answered the same way, typed into its own tab by Squeak Hands. It only types
at the agent's empty prompt, never into a question, a permission prompt, a
picker or a shell, and confirms from the transcript that the agent took it.
Sessions in other terminals, Claude Desktop and Cowork stay watch-only.

The iPhone talks to the Mac through Firebase, which only ever relays
encrypted data: replies are signed by a key in the phone's Secure Enclave and
the Mac acts only on signatures from phones you approved. See
[`docs/remote-channel.md`](docs/remote-channel.md).

## Setup

Requirements: macOS, Node 22, [Conductor](https://conductor.build) (for
replies), and a Telegram bot token from @BotFather (for push cards).

```bash
npm install
npm run build
node dist/squeak/cli.js setup          # writes ~/Library/Application Support/squeak/.env
node dist/squeak/cli.js install-hooks  # agent hooks: live state and approval prompts
./scripts/install-squeak-agents.sh     # start Squeak and the duck at login
./scripts/build-squeak-app.sh          # ~/Applications/Squeak.app
helpers/squeak-hands/build.sh ~/Library/Application\ Support/squeak   # live replies
```

Then grant **Squeak Hands** Accessibility in System Settings → Privacy &
Security. The first reply to a Terminal agent asks to let Squeak Hands
control Terminal (Privacy & Security → Automation). Rebuild Squeak Hands with
the same command after pulling changes to `helpers/squeak-hands/`; `ship.sh`
does not.

### iPhone

Set `SQUEAK_REMOTE_PROJECT` in Squeak's `.env` to your Firebase project id
(see `firebase/`), open Squeak on the Mac, choose **iPhone → Pair an iPhone**,
and scan the code with the iPhone app. Releases are built with
`ios/scripts/release.sh` and installed through SideStore.

### Zoho Cliq (optional, one-way)

Set `SQUEAK_CLIQ_WEBHOOK_URL` in Squeak's `.env` to a Cliq incoming-webhook
URL — a bot's (`https://cliq.zoho.com/api/v2/bots/<bot>/incoming?zapikey=…`)
or a channel's — and restart Squeak. Every push card that goes to Telegram
(blocked, finished, seems stuck, Codex quota) is posted there too, without
buttons: Cliq sends taps and replies to Zoho's servers, which cannot reach
the Mac. Answer from Squeak, Telegram or the iPhone. The `zapikey` is a
credential; it stays in `.env` and is redacted from logs.

## Development

```bash
npm run ci                      # typecheck, lint (incl. desktop/), format, tests
(cd ios/SqueakCore && swift test)
npx tsx scripts/e2e-remote.ts   # phone channel end to end, over real Firebase
./scripts/ship.sh               # from a worktree: CI, merge, build, restart
```

Working notes for anyone (or any agent) changing the code are in
[`CLAUDE.md`](CLAUDE.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
