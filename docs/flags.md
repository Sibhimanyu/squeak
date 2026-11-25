# Feature flags

One registry for Squeak's on/off switches: `src/squeak/flags.ts`. Each flag has a name, an environment variable, a
default, a description and a stage (`stable`, `beta` or `off-switch`). `flag(name)` answers a boolean.

## Where a value comes from

1. The flag's environment variable, parsed exactly as its call site always did (a blank value counts as unset).
2. `flags.json` in the support dir: a flat object of flag name to `true` or `false`, for staged rollout.
3. The default.

The environment always wins over the file. The file is read once, when the config loads at start; edit it and restart
the daemon. A missing file is fine. An invalid file, an unknown name or a non-boolean value is logged and ignored.

```json
{ "remote.local": false }
```

## Flags

On by default. Set the environment variable to `off` to disable it.

- `remote.verbose` / `SQUEAK_REMOTE_VERBOSE` enables live turns on the phone.
- `remote.local` / `SQUEAK_REMOTE_LOCAL` enables the direct same-Wi-Fi path.
- `caffeinate` / `SQUEAK_CAFFEINATE` keeps the Mac awake. The separate value `working` disables the plugged-in hold.
- `autoTitle` / `SQUEAK_AUTO_TITLE` uses a model to name new chats. Off uses a local title from the first message.
- `roomSummary` / `SQUEAK_ROOM_SUMMARY` enables model-written Room status lines.
- `roomJobs` / `SQUEAK_ROOM_JOBS` checks Room messages for Tasks. Manual Tasks still work when it is off.

These also default to on and accept `off`, `0`, `false` or `no`.

- `askFormat` / `SQUEAK_ASK_FORMAT` gives agents the lettered ask format.
- `ducksOwnBranch` / `SQUEAK_DUCKS_OWN_BRANCH` lets Ducks start Pond-wide in a Git Pond and choose their Streams with
  `streams`, `open_stream` and `leave_stream`; Main is read-only for them. The name is from the earlier "own branch"
  design and is kept so Macs and phones keep reading it.

`pondOwnThreads` / `SQUEAK_POND_OWN_THREADS` is off by default. Set it to `on`, `1`, `true` or `yes` to let
a Member run a Duck on their own Mac in a joined Git Pond.

Values are trimmed and case-insensitive.

## Environment switches outside the registry

These are read where they are used, not through `flag()`. They are not in `GET /control/flags`. Put them in the
daemon's `.env` (the host reads the same file) or the launchd environment.

- `SQUEAK_FLOTILLA=off` disables Ponds. The host checks for the literal value `off`. Ponds are on by default.
- `SQUEAK_ADDONS` lists extra add-on IDs to load, separated by commas. Distributed add-ons load automatically.
  Enable an add-on in Settings › Extensions to run it.
- `SQUEAK_NATIVE_COMPACT`: on; `off` skips the compaction of `native.db` at start.
- `SQUEAK_AGENT_SDK_PREFETCH`: on; `off` skips fetching the Claude Agent SDK at start.
- `SQUEAK_API_STALL_MIN`: minutes without a stream event before the host gives up on a request (default 10, `0` = never).
- `SQUEAK_REMOTE_NATIVE_BYPASS`: off; `1` lets a phone start a native chat that skips approvals.
- `SQUEAK_CLOUD_URL` overrides the hosted relay base URL for sign-in and provisioning. The daemon accepts an HTTPS
  Catalyst relay URL and falls back to Squeak's hosted URL if the value is invalid.
- `SQUEAK_CLOUD_DEFER_MOVE`: off; `on`, `1`, `true` or `yes` (or a `cloud-defer-move` file in the support dir) holds an
  existing install's move to the hosted relay until `POST /control/cloud/move-now`.
- `SQUEAK_HOST_PORT`: the session host's port (default 8479).
- `SQUEAK_ENV_PATH`: where the daemon's `.env` lives; Squeak's support folder follows it.
- `SQUEAK_DB_PATH`: Squeak's own `squeak.db`, when it is not in the support folder.
- `SQUEAK_HANDS_APP`: path of Squeak Hands, or `off`.
- `SQUEAK_RASANAI_ENGINE_DIRS`: extra folders, colon-separated, where the RasanAI add-on looks for its engine.

Channel and voice settings (`SQUEAK_BOT_TOKEN`, `SQUEAK_ALLOWED_CHAT_IDS`, `SQUEAK_CLIQ_*`, `SQUEAK_VOICE_*`) are
described with their features: `docs/cliq.md` and `docs/voice.md`. `SQUEAK_REMOTE_DATABASE_URL` and
`SQUEAK_REMOTE_PROJECT` belong to the old Firebase setup, which a Mac keeps until it signs in. When a new
switch is added, add it to the registry, not here.

## Reading them

`GET /control/flags` (token-gated, read-only, no CORS header) answers
`{ flags: [{ name, env, value, source: "env" | "file" | "default", default, stage, description }] }`.
