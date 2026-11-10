# The cloud layer: Firebase or Catalyst

Squeak's devices (the Mac daemon, the iPhone app, the Home Assistant voice add-on) meet in one cloud store. Every
document is sealed by the devices (docs/remote-channel.md), so the store only ever holds opaque boxes. This file is the
contract the daemon, the relay function, the Mac app and the iPhone app are built to. Change it first, then the code.

The spike that measured this is `spikes/catalyst/` (README: Firebase baseline, the Data Streams wire protocol).

## What a store is

Exactly what `src/remote/rtdb-rest.ts` (`RtdbRest`) and `RealtimeDatabaseClient` (Swift) already do:

| op                                  | meaning                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `get(path)`                         | one document or null                                                                                             |
| `set(path, doc, {timeoutMs?})`      | write (overwrite) one document                                                                                   |
| `delete(path)`                      | remove one document (missing is fine)                                                                            |
| `list(collection)`                  | `[{ id, doc }]` of a collection's direct children                                                                |
| `watch(path, onChange)` → `unwatch` | a wake-up when anything under `path` may have changed; never carries data, the reader re-reads through the store |

Paths are `channels/<channelId>/<kind>/<doc>` (the RTDB rule: channel id `^[A-Za-z0-9_-]{22,64}$`, the kinds the rules
whitelist, doc `^[A-Za-z0-9_-]{1,80}$`, box < 900000 chars). `ChannelDoc` is unchanged.

Node: `interface CloudStore` in `src/cloud/store.ts` with exactly `RtdbRest`'s public signatures; `RtdbRest` implements
it unchanged; `CatalystStore` (`src/cloud/catalyst-store.ts`) is the second implementation; `createCloudStore(config)`
picks one. Every current `RtdbRest` user takes a `CloudStore` instead (types only; behaviour on Firebase identical).
`FakeRtdb` keeps working for tests. Swift: `protocol CloudStore` in SqueakCore with the same five operations;
`RealtimeDatabaseClient` conforms; `CatalystClient` is the second.

## Catalyst: how the five operations map

- **The relay** is one Catalyst Advanced I/O function, `squeak_relay` (Node), shipped in `cloud/catalyst-relay/`
  (moved and hardened from `spikes/catalyst/relay`). Base URL `https://<project app domain>/server/squeak_relay`.
  - `GET /doc?path=` → `200 {doc}` | `404`; `PUT /doc?path=` body `{doc}` → `204`; `DELETE /doc?path=` → `204`;
    `GET /list?prefix=channels/<id>/<kind>` → `200 {items:[{id,doc}]}`; `GET /ping` → `200 {ok, store, channel, channelId?, version}`
    (`store`/`channel`: `"ready"|"missing"`, so setup can check the console steps); `POST /token` body
    `{name}` → `200 {url, key, wssId}` (a Data Streams token pair for a fresh connection name, ≤ 20 chars, no `.`/`:`).
  - Every request carries header `x-squeak-relay: <RELAY_KEY>` (a random 32-byte base64url secret the daemon makes at
    deploy, set as the function's env var, and handed to paired devices inside the sealed pairing grant, never logged).
    A wrong or missing key is a bare `401`.
  - The path rule, kinds whitelist and size cap are the RTDB rules', checked in the function.
  - Storage: the NoSQL table `squeak_docs` (partition key `pk` = `channels/<id>/<kind>`, sort key `doc`; the item holds
    the `ChannelDoc` JSON as a string). If the spike's open question (does `insertItems` overwrite) fails, update.
  - After every successful PUT or DELETE the relay publishes `{"p":"channels/<id>/<kind>"}` to the Data Streams channel
    `squeak_notice` (Custom Logic access control, the function `squeak_relay` selected). The channel id is found by the
    relay itself (`getAllChannels`, name `squeak_notice`) and cached; no env var for it.
- **watch** = one Data Streams subscriber per process (subscribe `'0'`, `sendAck` after every message, release and resubscribe
  on reconnect exactly as the datastreams skill says, unsubscribe before every deliberate close), fanned out to every
  `watch(path)` whose path is a prefix of (or equal to) the message's `p`. A 60 s safety poll stays, as with RTDB.
  Node uses `@zcatalyst/datastreams` or the spike's protocol notes; Swift implements the JSON-over-WebSocket protocol in
  `spikes/catalyst/README.md` with `URLSessionWebSocketTask`.

## Configuration (`~/Library/Application Support/squeak/cloud.json`, 0600)

```json
{
  "active": "firebase",
  "firebase": { "databaseUrl": "https://<id>.<region>.firebasedatabase.app", "projectId": "<id>" },
  "catalyst": {
    "projectId": "<id>",
    "projectName": "<name>",
    "dc": "in",
    "appUrl": "https://<domain>",
    "relayKey": "<secret>",
    "deployedVersion": "<relay version>"
  }
}
```

Absent file: today's behaviour (Firebase from `SQUEAK_REMOTE_DATABASE_URL` in `.env`). `active` decides the store the
bridge, the voice relay and pairing use. The Cliq relay stays on Firestore (out of scope).

## Pairing and devices

The sealed pairing grant (and the add-on's pairing grant) gains the provider: Firebase as today (`r` = database URL);
Catalyst `cu` = relay base URL and `ck` = relay key (`cu`, not `c`: in a pairing code `c` is already the channel id;
`p` and `r` are absent when the Mac has no Firebase; the `move` document below keeps `c` = relay URL). Both sides accept a relay URL only for an https host under
`.catalystserverless.com/.in/.eu/.com.au/.jp/.ca/.sa` or `.catalystappsail.*` (mirror of the RTDB host check). A device
paired before keeps Firebase until told to move.

**Moving.** `POST /control/cloud/select` to a provider other than the active one: the Mac first checks the target
(`/ping` ready + a test round trip), then writes one sealed, signed `state` document `move` on the _current_ store
(`{v:1, provider, r?|c?, ck?, at}`) that paired phones and the add-on act on: they verify it like any Mac-signed doc,
switch their store, and confirm by writing their presence on the new store. The Mac switches at once after writing it
and keeps reading the old store for 10 minutes for stragglers. A device that never saw the move can be re-paired.

## Accounts (Catalyst Hosted login; relay routes)

The account identifies the person; device keys authorise. The relay holds nothing that opens a Mac's channel, and a
signed-in account alone never grants access. Cookie routes answer a bare 401 when nobody is signed in and always send
`Cache-Control: no-store`; Mac-side routes need `x-squeak-relay`.

| route                                                             | who       | answer                                                                                                 |
| ----------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `POST /account/link-ticket`                                       | cookie    | `{ticket, expiresAt}`; 10 min                                                                          |
| `POST /account/link` `{ticket, macId, name}`                      | relay key | `{userId, email}`; bad/expired ticket `400 {error:"ticket"}`; the newer link wins over an older user's |
| `POST /account/unlink` `{macId}`                                  | relay key | 204; drops both link records and the Mac's pending device requests and results                         |
| `GET /account/macs`                                               | cookie    | `{macs:[{macId, name, linkedAt}]}`, this user's only                                                   |
| `POST /account/device-request` `{macId, name, publicKey, boxKey}` | cookie    | `{reqId, expiresAt}`; `403 mac` unless linked to this user; `429 busy` at 3 open                       |
| `GET /account/device-request?macId=&id=`                          | cookie    | 202 `{}` pending; 200 `{result}` (result and request then deleted); 410 `gone`; 403 another user's     |

- **Ticket** `al.<userId>.<expMs>.<emailBase64url>.<mac>`: HMAC-SHA256 under `RELAY_KEY` over a domain prefix and the
  fields (`scoped.js`, constant-time verify). The email of the signed-in user is one of the signed fields, so the relay
  stores nothing at issue and `/account/link` learns the email from the ticket alone.
- **Records** (store partition keys): `accounts/<userId>` doc `<macId>` = `{macId, name, linkedAt}`; `maclinks` doc
  `<macId>` = `{userId, email}`; `channels/<macId>/devreqs` doc `<reqId>` = `{v:1, reqId, userId, email, name, publicKey,
boxKey, at}` (a request older than 10 min is gone); `channels/<macId>/devresults` doc `<reqId>` = whatever the Mac wrote.
- **Kinds**: `devreqs` is relay-owned (the relay key may GET/list/DELETE, never PUT); `devresults` the Mac writes (relay
  key); no pond token touches either. A device request wakes the Mac with the same change notice a PUT would; the Mac
  checks the keys and answers.

## Daemon control routes (token-gated `x-squeak-token`, no CORS, like every `/control/*`)

- `GET /control/cloud` →
  ```json
  {
    "active": "firebase",
    "firebase": {
      "configured": true,
      "projectId": "...",
      "databaseUrl": "...",
      "lastTest": { "at": 0, "ok": true, "writeMs": 136, "readMs": 135, "noticeMs": 142 }
    },
    "catalyst": {
      "configured": false,
      "cli": { "installed": true, "version": "1.29.1", "loggedIn": true, "org": "..." },
      "projectId": null,
      "projectName": null,
      "dc": "in",
      "appUrl": null,
      "steps": [
        { "id": "cli", "state": "done" },
        { "id": "project", "state": "todo" },
        { "id": "table", "state": "todo" },
        { "id": "deploy", "state": "todo" },
        { "id": "channel", "state": "todo" },
        { "id": "verify", "state": "todo" }
      ],
      "lastTest": null
    }
  }
  ```
  `state` is `done | todo | working | error`, plus optional `detail` (a fixed sentence) and `consoleUrl` (where to click).
- `GET /control/cloud/catalyst/projects` → `{ projects: [{id, name}] }` (from the CLI, for the picker).
- `POST /control/cloud/catalyst/project` `{ projectId }` → selects it (CLI `project:use`, records id, name, app domain).
- `POST /control/cloud/catalyst/deploy` `{}` → packs `cloud/catalyst-relay` with a fresh or kept relay key and runs
  `catalyst deploy --only functions:squeak_relay` in a private copy under the support dir; progress in `steps`.
- `POST /control/cloud/catalyst/check` `{}` → re-reads every step (CLI status, `/ping`).
- `POST /control/cloud/test` `{ provider }` → `{ ok, writeMs, readMs, noticeMs, error? }` (a throwaway random channel,
  written, watched, read and deleted; never real channel data).
- `POST /control/cloud/select` `{ provider }` → `{ ok, moved, error? }`.
- `POST /control/cloud/firebase/rename` `{ displayName }` → renames the Firebase project's display name (Firebase CLI's
  token or REST `projects.patch`); `{ ok, error? }`. Catalyst has no rename API: the tab shows the console steps.
- Errors are fixed sentences; never a CLI's raw output or a token.

## Catalyst setup steps (what the Mac tab shows, in order)

| id        | who                     | what                                                                                                      | done when                              |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `cli`     | app/daemon              | Catalyst CLI installed and signed in (`npm i -g zcatalyst-cli`, `catalyst login` opens the browser)       | `catalyst project:list` works          |
| `project` | **you, in the console** | create a project (Console → Create Project), then pick it in the tab                                      | a project is selected                  |
| `table`   | **you, in the console** | Cloud Scale → NoSQL → Create Table `squeak_docs`, partition key `pk` (String), sort key `doc` (String)    | `/ping` `store: ready` (after deploy)  |
| `deploy`  | daemon                  | deploy `squeak_relay` with the relay key                                                                  | `/ping` answers with the right version |
| `channel` | **you, in the console** | Cloud Scale → Data Streams → Create Channel `squeak_notice`, access control Custom Logic → `squeak_relay` | `/ping` `channel: ready`               |
| `verify`  | daemon                  | a test round trip on Catalyst                                                                             | `lastTest.ok`                          |

Console links use the project's DC (`https://console.catalyst.zoho.<tld>`).

## Mac app: Settings › Cloud (a new tab)

Two cards, Firebase and Catalyst, each with: status line (In use / Ready / Not set up), project and region, the last
test's numbers, **Set up** (Firebase: the existing `FirebaseSetupModel` flow moves here; Catalyst: the step list above,
each step's button: Run / Open console / Check), **Test**, **Rename** (Firebase: a name field; Catalyst: the console
steps), and **Use this** (confirm sheet: "Paired devices will move to Catalyst."). Hidden routes (older daemon) → the tab
shows only the existing Firebase settings. DESIGN.md applies.

## Setting up Catalyst: what the CLI can and cannot do (verified on CLI 1.29.1)

- `catalyst project:list` and `project:use` are interactive (an org menu) outside a project, so setup does not use them. `catalyst init -ni` with no `-p` fails by design and prints the account's projects as `* name(id)` lines (the CLI calls them "orgs"); that is the project picker. `catalyst init -p <id> -ni` needs no `--org`, writes only a local `.catalystrc` (no cloud change) and holds the project's name and `domain.name` (`<project>-<orgId>.development`). The app URL is `https://<domain.name>.catalystserverless.<tld>`.
- The CLI never names the data centre; `dc` defaults to `in` and is a setting (`CatalystSetup.setConfig`).
- Function env vars come only from `deployment.env_variables` in the function's `catalyst-config.json` (a deploy overwrites console-set ones); setup writes `RELAY_KEY` there in its private copy `<support>/catalyst-relay`, never in the repo.
- Assumed, not run (a deploy changes a real project): `catalyst deploy --only functions:squeak_relay -ni`, and that the CLI ships the function's `node_modules` (setup runs `npm ci --omit=dev` first).
