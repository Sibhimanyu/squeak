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

| name             | env                       | default | parse                                                                                                                                                     |
| ---------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote.verbose` | `SQUEAK_REMOTE_VERBOSE`   | on      | off only for `off`                                                                                                                                        |
| `remote.local`   | `SQUEAK_REMOTE_LOCAL`     | on      | off only for `off`                                                                                                                                        |
| `caffeinate`     | `SQUEAK_CAFFEINATE`       | on      | off only for `off` (`working` is read separately)                                                                                                         |
| `askFormat`      | `SQUEAK_ASK_FORMAT`       | on      | off for `off`, `0`, `false`, `no`                                                                                                                         |
| `autoTitle`      | `SQUEAK_AUTO_TITLE`       | on      | off only for `off` (heuristic title, no model)                                                                                                            |
| `roomSummary`    | `SQUEAK_ROOM_SUMMARY`     | on      | off only for `off` (no model-written room lines)                                                                                                          |
| `roomJobs`       | `SQUEAK_ROOM_JOBS`        | on      | off only for `off` (no automatic job check; manual jobs still work)                                                                                       |
| `pondOwnThreads` | `SQUEAK_POND_OWN_THREADS` | off     | on for `on`, `1`, `true`, `yes` (stashed: a member's own-Mac threads in a joined pond)                                                                    |
| `ducksOwnBranch` | `SQUEAK_DUCKS_OWN_BRANCH` | off     | on for `on`, `1`, `true`, `yes` (every new chat in a git pond gets its own branch and worktree, Main read-only; `docs/ponds.md` "Ducks own their branch") |

Values are trimmed and case-insensitive.

## Environment switches outside the registry

These are read where they are used, not through `flag()`. They are not in `GET /control/flags`. Put them in the
daemon's `.env` (the host reads the same file) or the launchd environment.

- `SQUEAK_FLOTILLA`: ponds are on; `off` constructs nothing from `src/flotilla`.
- `SQUEAK_ADDONS`: comma-separated names of development add-ons (not `distributed`) to load. Shipped add-ons load
  always and stay off until enabled in Settings › Extensions.
- `SQUEAK_NATIVE_COMPACT`: on; `off` skips the compaction of `native.db` at start.
- `SQUEAK_AGENT_SDK_PREFETCH`: on; `off` skips fetching the Claude Agent SDK at start.
- `SQUEAK_API_STALL_MIN`: minutes without a stream event before the host gives up on a request (default 10, `0` = never).
- `SQUEAK_REMOTE_NATIVE_BYPASS`: off; `1` lets a phone start a native chat that skips approvals.
- `SQUEAK_CLOUD_URL`: use another Catalyst relay than Squeak's hosted one.
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
