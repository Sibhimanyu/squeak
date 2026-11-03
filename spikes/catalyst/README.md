# Catalyst spike: can Catalyst replace the Realtime Database?

Status 2026-11-02: **blocked on the console**. Project, NoSQL table and Data Streams channel cannot be created by CLI, MCP or IaC.
Everything else is built; once the owner has done the steps below, three commands produce the numbers.

## What was scriptable and what was not

| Step | Scriptable? | Evidence |
|---|---|---|
| Log in CLI (org Sibhimanyu G, IN) | yes, already done | `catalyst whoami` |
| Create project `squeak-trial` | **no** | CLI has no `project:create`; the MCP "Projects" group has only get/list/delete. `catalyst iac:import <zip> -n squeak-trial` creates a project from a zip but ends by opening a browser URL the owner must visit to consent (`ensureUserAction` in the CLI source), and the template schema is undocumented in the CLI. Not attempted. |
| `catalyst init -p <id> -ni`, `functions:add -ni`, `deploy --only functions:squeak_relay` | yes, once the project exists | CLI + skill |
| NoSQL table | **no** (console) | catalyst-nosql skill; no CLI command, no MCP tool |
| Data Streams channel + access control | **no** (console) | catalyst-datastreams skill; MCP has only list/get/token/publish/live-count; the CLI knows Data Streams and NoSQL only as OAuth scopes |
| Function env vars | yes (`catalyst-config.json`, or MCP Update_Environment_Variable) | |
| Publish, token pair, live count | yes (function / MCP) | |

Product setup UX consequence: a "Catalyst" backend needs about 4 console steps per user (project, table, channel, pick the function as channel access control) before the CLI can do the rest. Firebase's setup is already automated (`FirebaseSetup.swift`).

## Console steps for the owner (about 5 minutes)

1. https://console.catalyst.zoho.in , Create Project, name exactly `squeak-trial`. Note the Project ID and the Development domain (Settings / Domains).
2. Cloud Scale, NoSQL, Create Table: name `squeak_docs`, partition key `pk` (String), sort key `doc` (String).
3. Cloud Scale, Data Streams, Create Channel: name `squeak_notice`, access control **Custom Logic**. It asks for an Advanced I/O function, which does not exist yet: create the channel after the function is deployed (step 4), or deploy first. Retention stays 48 h.
4. Lead or agent then runs:
   ```
   cd spikes/catalyst/relay
   catalyst init --org 60083782173 -p <projectId> -ni        # in relay/, writes .catalystrc
   catalyst functions:add ...  # not needed: functions/squeak_relay already has config; see below
   ```
   Layout the CLI expects: `functions/squeak_relay/` and a `catalyst.json` with `{"functions":{"targets":["squeak_relay"],"source":"functions"}}`. Move `relay/squeak_relay` to `relay/functions/squeak_relay`, then `catalyst deploy --only functions:squeak_relay`.
5. Console, Data Streams, channel, access control: select function `squeak_relay`. Copy the channel ID into the function's `CHANNEL_ID` env var, set `RELAY_KEY` to a random string, redeploy.
6. Measure:
   ```
   export RELAY_URL=https://<dev-domain>/server/squeak_relay RELAY_KEY=<key>
   COLD=1 node measure/catalyst.mjs     # after 15+ min idle: cold start
   node measure/catalyst.mjs            # PUT, GET, notice p50/p95
   (cd swift && swift run streams 20)   # the same notice from plain Swift
   node measure/firebase.mjs            # Firebase baseline (already run)
   ```

## Firebase baseline (measured here, asia-southeast1, 30 runs, 2 KB doc, from this Mac)

| | p50 | p95 |
|---|---|---|
| PUT | 136 ms | 286 ms |
| GET | 135 ms | 258 ms |
| PUT then SSE change notice | 142 ms | 415 ms |

Note: the task said the rules accept `channels/<random>/spike/...`; they do not (kinds are whitelisted), so the spike writes `state` under a random 32-char channel and deletes it.

## Data Streams wire protocol (from @zcatalyst/datastreams 1.0.1 `web-socket.js`, plain JSON text frames)

- Host: from the token (`url`, e.g. `in1-dms.zoho.in`); the client refuses anything not in its allow-list (zoho .com/.eu/.in/.com.au/.jp/... `-dms` hosts). Hardcode the same list.
- Connect: `wss://<host>/wsconnect?prd=CY&zuid=<token["wss-id"]>&key=<token.key>`. No headers, no subprotocol; auth is the query.
- Server frames are JSON arrays `[{mtype, msg}]`, string `mtype`: `"0"` auth OK (`msg:{sid,uid}`), `"-5"` auth failed, `"-2"` key missing, `"-11"` session closing/expired, `"-1"` switch host (`msg[msg.primarydc]`, reconnect with `?key=&i=<sid>&c=<uid>`), `"650"` data (`msg:{opr:"event"|"api"|"connect"|"error", data:{data, streamingId}}`), `"660"` blocked, `"670"` server down. An empty text frame is a pong.
- Client frames: subscribe `{"type":"con","value":"subscribe","streamingId":"0"}` (`-1` earliest, `-2` resume), ack `{"type":"ack","streamingId":"<id>"}` (required before the next message), unsubscribe `{"type":"con","value":"unsubscribe"}`.
- Keepalive: bare text `-` every 15 s; `{"type":"con","value":"ping"}` every 60 s; the JS client also closes and reopens every 27 min using `?key&i=sid&c=uid` and resubscribes `-2`.
- Verdict for Swift: not binary, not opaque; `URLSessionWebSocketTask` is enough (`swift/`). Built (`swift build` ok); not yet run against a live channel.

## Free tier (catalyst-pricing skill, verified May 2026, account-wide)

Functions 25,000 GB-s/month; API Gateway 100,000 requests (only if enabled); NoSQL and Data Streams are not listed in the pricing table at all (unknown meter and limits, ask the owner to read the console's usage page); Data Store 10k SELECT / 5k INSERT. $5/project/month minimum once over the free tier. $250 trial credits for 6 months. Data Streams: 48 h retention, one live session per connection name, 20-char connection names, delivery is acked one message at a time (about 300 ms per message from India to a US DC; the IN DC may differ), so publish "something changed" notices, never per-document data.
Request budget check: a phone polling nothing, a daemon writing a state doc every few seconds = each write is one function call + NoSQL write + publish; at 1 write/5 s that is about 518k calls/month, so the free request allowance is the number to watch.

## Files

- `relay/` (moved to `cloud/catalyst-relay/`, the hardened relay; see docs/cloud-layer.md).
- `measure/`: `firebase.mjs`, `catalyst.mjs`, `stats.mjs`.
- `swift/`: SwiftPM executable `streams`.
