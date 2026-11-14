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

| name             | env                     | default | parse                                             |
| ---------------- | ----------------------- | ------- | ------------------------------------------------- |
| `remote.verbose` | `SQUEAK_REMOTE_VERBOSE` | on      | off only for `off`                                |
| `remote.local`   | `SQUEAK_REMOTE_LOCAL`   | on      | off only for `off`                                |
| `caffeinate`     | `SQUEAK_CAFFEINATE`     | on      | off only for `off` (`working` is read separately) |
| `askFormat`      | `SQUEAK_ASK_FORMAT`     | on      | off for `off`, `0`, `false`, `no`                 |
| `autoTitle`      | `SQUEAK_AUTO_TITLE`     | on      | off only for `off` (heuristic title, no model)    |

Values are trimmed and case-insensitive. Other switches (`SQUEAK_FLOTILLA`, `SQUEAK_ADDONS`,
`SQUEAK_CLOUD_URL`) still read their own variables; move them here one at a time, with a test that the old values give
the same result.

## Reading them

`GET /control/flags` (token-gated, read-only, no CORS header) answers
`{ flags: [{ name, env, value, source: "env" | "file" | "default", default, stage, description }] }`.
