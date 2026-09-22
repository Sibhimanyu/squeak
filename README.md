# Telegram Conductor Bridge

Use Telegram as a mobile control surface for the Conductor instance already running on your Mac.

Browse repos, switch branches, resume Codex or Claude chats, create new chats and workspaces, and follow streamed output from your phone without screen sharing or remote desktop.

This bridge is local-first: it must run on the same Mac that already has Conductor installed and initialized. It reads the local Conductor database and launches the local Codex and Claude Code binaries from that machine. It is not a remote bridge for controlling another computer's Conductor instance.

## Squeak

Named for the noise a rubber duck makes, which is also what a pager does.

A **second, separate daemon with its own Telegram bot**. The bridge above is a
conversation — you navigate it and talk to agents through it. Squeak is a
pager: it watches every coding agent on the Mac and messages you when one
finishes or gets stuck, and it never tries to hold a conversation.

They are deliberately apart. Status pings landing in the middle of a chat bury
the chat, and vice versa.

`assets/squeak.mp3` is a synthesised duck squeak, under Telegram's 5s / 300KB
limit, for use as the bot's notification tone.

```bash
squeak setup          # paste a token from @BotFather
squeak install-hooks  # live signal; see below
squeak                # start it
```

To have Squeak and the duck start at login and restart if they die:

```bash
./scripts/install-squeak-agents.sh
```

It points the agents at the main checkout, never a Conductor worktree — those
are archived when a workspace is finished, and a login item that depends on
one breaks quietly some weeks later. Logs land in `~/Library/Logs/squeak/`.

Its config lives at `~/Library/Application Support/squeak/.env`, its
state at `squeak.db` beside it, and it talks to a different bot than the
bridge. Only one of the two may run the fleet at a time — they would bind the
same hook port and double every notification — so the bridge no longer does.

**It messages you when a session is blocked on your approval, blocked on a
question, or has finished.** Errors and sessions running low on context wait on
the radar rather than interrupting. `/radar` shows everything at once; `/mute`
silences for an hour.

It watches **every coding agent session on the Mac**, not only the ones
Conductor started. A Claude Code run in your own terminal, a Codex thread from
the editor, and a Conductor chat all land on one radar, ranked by what is
actually waiting on you.

```
Fleet — 26 sessions · 1 waiting on you

Needs you
🔴 conductor-tg · ushuaia — claude · 3m
    Claude needs your permission to use Bash
    Waiting for approval

Working
🟢 ~ — claude terminal · just now
    Running Bash

Finished, unreviewed
✅ greenroom · hong-kong — codex · 12m
```

Open it with `/radar`. It anchors a live message in that conversation and keeps
editing it in place, and that anchor is also where push cards are sent.

**Only active sessions are shown.** A normal machine holds twenty-odd agent
sessions and almost all of them are abandoned; listing those makes this an
archive rather than a status display. A session is active if it is running,
blocked on you, finished in the last fifteen minutes, or quiet with its
process still up. On a typical day that is four sessions out of twenty-six.
The rest stay tracked, so one waking up is noticed, but they never reach a
screen.

**What counts as needing you**, in priority order: blocked on an approval,
blocked on a question, errored, finished-but-unreviewed, then running low on
context. Only the two blocked kinds and finishing send you a message; everything
else waits on the radar so the chat does not become a firehose. Cards are two
lines, because they arrive as phone notifications and have to be readable on a
lock screen; depth lives behind the buttons.

A session can want attention for more than one reason at once, and all of them
are shown.

### What the agent actually did

"Finished" tells you a turn ended, not whether it touched three lines or
rewrote a module, and not whether any of it left the machine. Sessions on the
radar carry their working-tree state:

```
✅ conductor-tg · ushuaia — claude · 12m
    Done, all tests pass.
    +283/−5 · 15 files · 2 commits, not pushed
```

Conductor branches usually have no upstream, so unpushed work is counted
against the repo's default branch rather than reported as nothing outstanding.
Git runs only for sessions that are actually rendered, and results are cached
for 30 seconds — the twenty idle sessions that never reach the radar cost
nothing.

### Usage tracking

Squeak reads OpenAI's own account-wide rate-limit report straight out of
Codex's rollout files — the 5-hour and weekly windows, and when each resets —
at the cost of one file read, no API call and no credential of its own. It
shows up on `/radar` once a window is worth mentioning, and pushes a one-time
warning past a configurable threshold (`FLEET_CODEX_QUOTA_WARN_PERCENT`,
default 85%) so you find out before you hit the wall mid-task rather than
after.

Claude Code never writes the same thing to disk — only to the live stream of
whatever process spawned it, which for a Conductor session is Conductor
itself, not Squeak. What Claude *does* persist for the CLI is a running cost total per session —
but Conductor drives Claude through the SDK, and that entry almost never
appears there (1/37 real SDK sessions on this machine had one). So Squeak
estimates it instead, from the token counts every entrypoint writes on every
message: real per-token rates, the same cache-write/read multipliers Anthropic
publishes, deduplicated against Claude Code's own habit of writing one
streamed message more than once. It is an estimate, labelled as one in the
tray (`~$X.XX est.`) — not Anthropic's own figure, which the tray uses
whenever Claude Code did report it.

### The duck

A rubber duck floats on your screen and shows the same thing the radar does.
It sleeps when nothing is running, bobs faster while an agent works, wears a
red ring when something is blocked on you, and hops when something finishes.
Click it for the list of active sessions with their diffstats.

```bash
cd desktop && npm install && npm start
```

There is also a duck in the menu bar, showing a count when something is
blocked on you. From there you can hide the floating duck and keep only the
menu bar item, jump to any active session's directory, or peek at the panel
with **⌃⌥D**.

It is presentational only: it polls the bridge's loopback `/state` and renders
the answer, so it cannot disagree with Telegram about what is happening. See
`desktop/README.md`.

### Reviewing the change

Any session with a working directory offers **View Diff**: a paginated file
list, then one file's patch at a time. The diff is taken against the base
branch rather than HEAD, so it shows what the workspace produced overall
rather than only what is still uncommitted, and it includes untracked files —
an agent that writes a new file almost never stages it, so a review that
skipped them would quietly omit most new code.

This needs no control channel, so the output of a Claude session running in
your own terminal is reviewable here too.

### Signals only Conductor has

Two things no transcript can tell you, read straight from Conductor's database:

- **Context pressure.** Conductor tracks how much of the context window each
  session has burned. Past `FLEET_CONTEXT_PRESSURE_PERCENT` (default 80) the
  session is close to compacting, which costs it fidelity on everything it has
  already worked out — worth knowing before it happens. Any session at 60% or
  more shows `ctx N%` on its radar row.
- **Retired workspaces.** A workspace Conductor has archived, or that you
  marked done or canceled, drops off the radar. On a machine with
  twenty-odd sessions this is most of the noise: the worktree is gone, so
  there is nothing left to look at.

### Live signal via agent hooks

Without hooks the radar reads agent transcripts on a poll, which is late and
cannot see an approval prompt at all: agents do not write those to disk.
Installing hooks fixes both.

```bash
squeak install-hooks    # merge into your existing hook config
squeak hooks-status
squeak uninstall-hooks  # removes only what this tool added
```

The hooks are additive: existing entries in `~/.claude/settings.json` and
`~/.codex/hooks.json` are preserved, and the file is backed up before it is
touched. The installed script backgrounds its request, times out after two
seconds, and always exits 0 — a bridge that is down, slow, or uninstalled is
indistinguishable from no hook at all, so it can never stall one of your
agents. Sessions already running pick the hooks up on their next start.

### What the bridge can and cannot do

| Session started by | Watch | Reply, steer, approve |
| --- | --- | --- |
| Conductor | yes | yes |
| Your terminal, an editor | yes | no — answer it where it runs |

Sessions the bridge did not spawn have no control channel, so their cards
say so and offer only the diff viewer.

## Why Use It

- See every agent session on the machine and what is blocked on you
- Continue existing Conductor chats from Telegram
- Browse repos, branches, workspaces, and chats without opening Conductor
- Create new chats and new workspaces from Telegram
- In forum-enabled supergroups, give each Conductor chat its own Telegram topic
- Stream assistant output as it arrives
- Queue follow-up prompts and interrupt active turns
- Inspect status and recent context without leaving Telegram

## Install Without Cloning the Repo

Install the published CLI package:

```bash
npm install -g conductor-tg
```

Create the default config file:

```bash
conductor-tg setup
```

The setup command writes the config to:

```text
~/Library/Application Support/conductor-tg/.env
```

It asks for at least these two values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`

Set `TELEGRAM_ALLOWED_CHAT_IDS` to the Telegram chat IDs that may use the bridge. Separate multiple IDs with commas.

If you prefer manual editing instead of the interactive setup flow, run:

```bash
conductor-tg init
```

That command only creates the template file. After that, open `~/Library/Application Support/conductor-tg/.env` and fill in the required values yourself.

Then start the bridge:

```bash
conductor-tg
```

The packaged install stores its local state DB at:

```text
~/Library/Application Support/conductor-tg/bridge.db
```

If you want to keep the config somewhere else, set `BRIDGE_ENV_PATH` before launching the bridge.

## Quick Start From Source

The fastest path is a private chat with the bot. Start there first. Add a forum-enabled supergroup later if you want one Telegram topic per Conductor chat.

1. Install dependencies

```bash
npm install
```

2. Copy the environment template

```bash
cp .env.example .env
```

3. Create a Telegram bot with `@BotFather`, then put the token into `.env` as `TELEGRAM_BOT_TOKEN`
4. Open a private chat with the bot and send `/start`
5. Fetch your chat ID with `getUpdates`, then put it into `.env` as `TELEGRAM_ALLOWED_CHAT_IDS`
6. Start the bridge

```bash
npm start
```

7. In Telegram, send `/start`, choose a repo, choose a branch, choose a chat, then send plain text

If you want the detailed Telegram setup, group setup, or topic mode, see the sections below.

## Requirements

- The bridge must run on the same Mac where Conductor is already installed
- Conductor must have been opened at least once on that Mac
- Node.js 22 or newer must be installed
- The local Conductor DB must exist at:
  `~/Library/Application Support/com.conductor.app/conductor.db`
- The local Codex binary must exist at:
  `~/Library/Application Support/com.conductor.app/bin/codex`
- The local Claude Code binary must exist at:
  `~/Library/Application Support/com.conductor.app/bin/claude`
- A Telegram bot token must be available
- In private chats, Telegram administrator permissions are not required
- In a forum-enabled Telegram supergroup, the bot should be promoted to administrator with at least `Manage Topics` enabled

If you use the bridge in a group without topics, promoting the bot to administrator is still recommended so it can receive normal group messages reliably.

## Conductor <-> Telegram Mapping

![Conductor to Telegram mapping](./docs/conductor-telegram-mapping.svg)

- A Conductor repository is the repo you pick in Telegram
- A Conductor workspace is the branch context you pick in Telegram
- A Conductor session is the current chat you continue from Telegram
- In forum-enabled supergroups, one Conductor chat is bound to one dedicated Telegram topic
- In private chats, or in chats without topics, the conversation stays in the current Telegram chat instead

## Telegram Setup

Menu names vary slightly between Telegram macOS, Desktop, iOS, and Android, but the flow is the same.

### 1. Create the bot

1. Open Telegram and start a chat with `@BotFather`
2. Send `/newbot`
3. Choose a display name for the bot
4. Choose a username for the bot. Telegram bot usernames normally end with `bot`
5. Copy the token that `@BotFather` returns
6. Put that token into `.env` as `TELEGRAM_BOT_TOKEN`

### 2. Choose where you want to use the bridge

Private chat is the simplest option. Forum-enabled supergroup is the best option if you want one topic per Conductor chat.

Private chat:

1. Open a 1:1 chat with the bot
2. Send `/start` once. Telegram bots cannot initiate a private chat on their own

Group or supergroup:

1. Create a new Telegram group and add the bot as a member
2. If you want one Conductor chat per Telegram topic, enable `Topics` in the group settings. Telegram uses a forum-enabled supergroup for this mode
3. Promote the bot to administrator from the group's `Administrators` settings
4. For topic mode, enable at least `Manage Topics`
5. Send `/start` in the main group chat after the bot has been added

### 3. Find the chat IDs for `TELEGRAM_ALLOWED_CHAT_IDS`

1. If the bridge is already running, stop it first so it does not consume updates before you inspect them
2. Send `/start` in each private chat or group that you want to allow
3. Fetch recent updates from the Bot API

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

4. Look for the latest `message.chat.id` value for each chat you just used
5. Private chat IDs are positive integers
6. Group and supergroup IDs are negative integers. Supergroups commonly start with `-100`
7. Put the allowed IDs in `.env`, separated by commas

Example:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1009876543210
```

## Configuration

At minimum, set these variables in `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1009876543210
```

Useful defaults:

- `BRIDGE_DB_PATH` defaults to `.context/bridge.db`
- `CONDUCTOR_DB_PATH` defaults to `~/Library/Application Support/com.conductor.app/conductor.db`
- `CODEX_BIN` defaults to `~/Library/Application Support/com.conductor.app/bin/codex`
- `CLAUDE_BIN` defaults to `~/Library/Application Support/com.conductor.app/bin/claude`
- `WORKSPACES_ROOT` defaults to `~/conductor/workspaces`

The current version creates `.context/` on startup, so you do not need to create it in advance.

## Run

Run the bridge on the same Mac where Conductor is installed:

```bash
conductor-tg
```

If you are working from a source checkout instead of the published package:

```bash
npm start
```

Development mode from source:

```bash
npm run dev
```

On startup the bridge calls Telegram `setMyCommands`, so the supported slash commands also appear in Telegram's command picker.

## First Successful Flow

1. Open a private chat with the bot in Telegram, or a forum-enabled supergroup where the bot is present
2. Send `/start`
3. Tap `Switch Repo`
4. Select a repo
5. Tap `Switch Branch`
6. Select a branch in that repo
7. Tap `Switch Chat`
8. Select an existing chat
9. Send plain text to continue the current chat

In topic-enabled supergroups, the bridge opens that chat's dedicated topic and streams follow-up output there.

Create a new chat:

1. Select a repo and branch first
2. Tap `New Chat Here` or send `/new`
3. Your next message creates a new Conductor chat and switches to it automatically
4. If the current Telegram conversation supports topics, the bridge also creates a dedicated topic for that new chat and sends follow-up updates there
5. Existing chats reuse their previously bound topic, so one Conductor chat stays attached to one Telegram topic

Create a new workspace:

1. Select a repo and branch first, or open a repo's branch list
2. Tap `New Workspace` or `New Workspace Here`, or send `/new_workspace`
3. Send the branch name as your next message, for example `berlin` or `feature/demo`
4. The bridge creates a git worktree, writes the Conductor workspace row, and switches you to the new branch

## Telegram Commands

- `/start` or `/home`: return to the home screen
- `/repos` or `/workspaces`: choose a repo
- `/branches`: choose a branch
- `/chats` or `/sessions`: choose a chat
- `/status`: open or refresh the current chat's status panel
- `/stop`: interrupt the current turn
- `/queue`: inspect the current chat queue
- `/context [N]`: open a paginated single-message context viewer with older, newer, refresh, and close controls
- `/new`: make the next plain-text message create a new chat on the current branch
- `/new_workspace`: make the next plain-text message create a new workspace in the current repo
- `/help`: show help

## Output Model

- `/status` creates or refreshes a reusable status panel when you want a compact status view
- `/context [N]` opens a separate context preview card; paging and refresh actions only update that single message
- In topic-enabled chats, each Conductor chat streams as a normal assistant message inside its dedicated topic instead of using the status panel
- The context preview stays scoped to the current topic instead of the whole Telegram chat
- Dedicated topics stay locked to their current Conductor chat; use the main chat to switch repos, branches, or chats
- Both the status panel and the context preview can be closed to keep the Telegram chat tidy

## Keep It Running on macOS

If you want the bridge to stay available after login, use a user `LaunchAgent` via `launchd`.

`Launchpad` is only an app launcher. It does not keep a CLI process alive.

Amphetamine can help prevent the Mac from sleeping while the bridge is running, but use a user `LaunchAgent` via `launchd` if you want the bridge to start automatically after login.

If you install the published CLI package, point `launchd` at the `conductor-tg` executable. It reads config from `~/Library/Application Support/conductor-tg/.env` by default, so it does not need to start from a repo checkout.

If you run from a source checkout instead, start the process from the repo root so it can find `.env` and `.context/`.

If your Node.js installation only exists in an interactive shell setup such as `nvm`, `launchd` may not see it.

## Common Setup Issues

- `Unauthorized account. Access to Conductor is disabled.`: the current Telegram chat ID is missing from `TELEGRAM_ALLOWED_CHAT_IDS`
- The bot replies to `/start` but not to plain text in a group: use a private chat first, or promote the bot to administrator in the group
- A dedicated topic is not created for a new chat: make sure the chat is a forum-enabled supergroup and the bot has `Manage Topics`
- The bridge starts but Telegram polling keeps returning `401`: the bot token is invalid

## Notes and Limitations

- The current version supports a single user across the allowed Telegram chats
- New chats inherit the active workspace's preferred agent. Existing Claude workspaces continue as Claude; otherwise new chats default to Codex
- Claude chats support queueing, streaming output, and interrupt
- Plan approval, plan feedback, and request-user-input replies are currently Codex-only bridge features
- The process will not start if `TELEGRAM_BOT_TOKEN` is not set
