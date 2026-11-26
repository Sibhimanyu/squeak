# Cloud spike, November 2026: live connections and people tables

Research for issue #117 (part of #101), before building the cloud foundation of ADR 0005
(`docs/adr/0005-people-data-in-tables-content-sealed-targeted-notices.md`; spec: `docs/spec.md`, "Cloud: what is stored
where, and how changes travel"). Evidence: the Catalyst skill docs, the public Catalyst docs, the current relay code, a
local prototype (`cloud/spikes/appsail-sse/`) and, on 2026-11-26, a live test in the Development environment (steps 1 to
6 of the plan at the end ran; steps 7 and 8 are waiting on the owner; see "Live results"). Sections 1 to 5 below are the
desk research written before the live test; where the live test measured something it is marked **Live**.

## Decision (after the live test)

1. **Live connections: SSE from a separate AppSail service (`squeak-live`).** WebSocket is ruled out: the front door
   strips `Upgrade` (Live, step 6).
2. **People tables: Catalyst Data Store**, limits designed around (composite keys, slot rows for the 10-person cap, no emoji
   in names, caches). Still unmeasured live (step 7 needs a console-made table); the choice does not depend on it.
3. **The documented 100 concurrent requests per instance is real and open streams count against it** (Live, step 3/4): one
   AppSail app holds at most 500 open streams (5 instances x 100), also in Development; beyond that every request,
   streams and ordinary calls alike, gets HTTP 429 `Concurrency limit reached for the feature APP_COMPUTE`. So `squeak-live`
   serves about 500 devices until Zoho raises the limit (ask now: draft below). The sharded Data Streams fallback (section
   5) becomes the plan only if Zoho refuses and we pass about 400 devices.
4. **The platform ends every stream at about 45 s, cleanly** (Live, step 1), and **never tells the app when a client goes
   away** (Live, step 3). So the hub must rotate streams itself: send `event: bye` and close at 40 s, the client opens its
   replacement at about 35 s, heartbeat every 15 s. `lastSeen`, "last connection closed" and membership removal must not
   depend on a socket `close` event; use the 40 s rotation and an explicit client "alive" call.

## Live results (2026-11-26, Development, `squeak-spike-sse`, Node 22, 256 MB, from the owner's Mac, direct to the front door)

Note: the Mac's sandbox proxy cut streams at the same 45 s; every number below was taken with the proxy bypassed.

- **Step 1, survival**: first byte immediate (response headers and `: open` about 1 s after connect, including TLS). Heartbeat 15
  s: stream stayed open to **45.3 to 45.8 s** (4 runs), then closed by the platform with a normal end (curl exit 0, no
  reset), no `bye` from the app. Nothing reached 60 s or 5 min. Response is not buffered.
- **Step 2, heartbeat**: 5 s heartbeat: still cut at about 46 s (9 heartbeats), so the cut is a **maximum age**, not idle.
  60 s heartbeat (silence after `hello`): cut at **35 to 38 s** (3 runs), so there is also an idle cut near 35 s. Heartbeat 15 s is
  right; it is not what sets the lifetime.
- **Step 3, 100-request cap**: 120 streams opened without error, `/stats` p50 123 ms (idle baseline 122), no 429 at 120 or 200.
  Streams do count: they are spread over more instances (Development did not stay at 1 instance): with the pond's state on
  one instance, 100 of 191 streams landed on it and 91 elsewhere. At 600 attempted streams: **500 open, the rest 429**, and
  while saturated 65 of 84 ordinary `/stats` calls were 429 too; first byte p95 6.5 s during scale-out (instance start).
  Whether the limit is per service or per project was not tested (it would have touched the live relay): ask Zoho.
- **Disconnect is invisible to the app**: after clients went away, `conns` stayed at 5 for 100+ s and at 518 for 5+ min (the app kept
  writing heartbeats). With the hub's own max age (30 s) they reached 0 within 35 s.
- **Step 4, 200 streams over 100 to 180 s**: all opened (p50 first byte 117 ms, p95 234 ms), about 3 instances, RSS 56 to 62 MB
  per instance, 4,933 platform cuts re-opened without an error. Instance count is read from per-instance `conns`; the console was not opened.
- **Step 5, redeploy with 20 streams**: `catalyst deploy appsail` returned in 4 s; all 20 streams ended cleanly (normal end, no reset)
  18 s after it returned; with 0 to 3 s of random delay all 20 were back within 3 s.
- **Step 6, WebSocket**: the `Upgrade` header is stripped by the front door: the request reaches the app as a plain `GET`
  (404 from the app's own handler, identical to a normal request). No WebSocket route is possible on AppSail.
- **Step 7, Data Store**: not run. The CLI and SDK cannot create a table; the owner must make `spike_people` in the console.
- **Step 8, Data Streams User Roles from AppSail**: not run, waiting for the console-made channel `spike_live` and app user `spike-live-1`.
- **Step 9**: email drafted below, not sent.

Cost of the test: about 0.5 GB-hours of AppSail, no Data Store use.

### Cleanup: the owner must delete the test service

The CLI (1.29.1) has no command to delete an AppSail service (`functions:delete --remote` is interactive-only and lists the live
`squeak_relay`, so it was not used). **`squeak-spike-sse` is still deployed in Development**; delete it in the console
(Serverless, AppSail, `squeak-spike-sse`, id `53069000116008223`). It holds no secrets (`x-key: spike` only) and scales to zero.
No Data Store table, channel or app user was created. The temporary deploy directory was removed; the relay, its function and
tables were not touched.

### Draft email to Zoho support (step 9, not sent)

To: support@zohocatalyst.com. Subject: Raise AppSail concurrent request limit; streaming response limits (project 53069000000381140)

> Hello, we run a notification service on Catalyst AppSail (project 53069000000381140, development, India DC) that holds
> one long-lived Server-Sent Events response per user device. In a test we found: (1) every open stream counts toward the
> 100 concurrent requests per instance, so an app tops out at 500 open streams and then returns 429 "Concurrency limit
> reached for the feature APP_COMPUTE" for all requests; (2) the front door ends every response at about 45 s (about 35 s
> with no bytes) and does not tell the app when the client disconnected; (3) the `Upgrade` header is stripped, so WebSocket
> does not work. Please tell us: can the concurrent-request limit per instance and the 5-instance maximum be raised for
> this project (target 5,000 concurrent streams in production), is the limit per AppSail service or per project, can the
> maximum response age and idle timeout be raised or disabled for text/event-stream responses, and is there a supported way
> to learn that a client has disconnected. Thank you.

## 1. Can AppSail hold long-lived SSE or WebSocket connections? (desk research; **Live** results above override it)

Documented (Catalyst docs, AppSail "Platform Management",
<https://docs.catalyst.zoho.com/en/serverless/help/appsail/key-concepts/platform-management>; skill
`catalyst-appsail`):

- "An app request needs to be completed in 30 seconds." Nothing says streaming responses are exempt. The relay's own
  comment in `cloud/catalyst-relay/appsail/server.js` ("the platform's 30 s request limit") assumes the same.
- "Catalyst can execute 100 requests concurrently per app instance"; a new instance spawns at 80 concurrent requests;
  at most 5 instances per app ("\*": limits Zoho raises case by case via support). A forum/search summary says the
  development environment gets **1** instance only.
- Inactive instances scale down after 5 minutes (development 1 minute per a search summary of the same page); an
  instance must listen within 10 s of starting; memory 256 to 2048 MB (skill).
- The skill says AppSail is "best for ... WebSockets". No page states a WebSocket or SSE idle timeout, a maximum
  duration, proxy buffering, or a connection cap. A Catalyst KB article says WebSockets are **not** supported in
  Catalyst _functions_ (not AppSail).

Measured locally (`node cloud/spikes/appsail-sse/load.js <N> <port>` against a separate `node server.js`, Node 22, macOS,
no proxy, so this is the server's own cost only):

- Idle server 41.5 MB RSS. With 500 / 2000 / 5000 open SSE connections on one Pond: 53.5 / 77.6 / 110.1 MB RSS (about
  14 to 24 KB per connection, heap 8.7 / 18.8 / 39.4 MB).
- Fan-out of one notice to every connection: 18 ms (500), 24 ms (2000), 63 ms (5000), all received.
- So memory is not the limit: 256 MB would hold several thousand streams after the relay's own footprint. **The
  documented 100-concurrent-requests cap is the limit, not RAM.** (Running 2000 clients against the hub in one process
  also showed a harness trap, not a server issue: opening 300+ sockets in one burst stalls handshakes on this Mac; open in
  waves.)

Behaviour on scale-out and redeploy (design, from the docs):

- Connections are pinned to the instance that accepted them; a notice produced on instance A must reach streams on B.
  The spec's answer (one internal Data Streams channel, at most 5 subscribers) holds; see the token caveat in section 5.
- Scale-out is driven by concurrent requests, so open streams alone would start a second instance at 80 devices.
- A redeploy or scale-down drops every stream on that instance. Clients must reconnect with random delay (0 to 5 s) and
  repair from the change feed. This is the reason SSE must not share an app with the relay (section 2).

Heartbeat and keeping streams open:

- Send an SSE comment line (`: hb`) every **15 s** (under any plausible 30 s idle cut, over-frequent enough to survive
  a 20 s one); clients treat 45 s of silence as dead and reconnect. Prototype default is 15 s (`HB_MS`).
- Send `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`; Node's own `requestTimeout` must be 0 for
  the stream route (the current relay sets 30 s globally; the prototype sets 0).
- If the front door cuts at 30 s, the server closes at about 25 s with `event: bye` and the client has already opened the
  next stream at about 20 s (overlap, no gap). On open the server sends the Pond heads it knows, and a device reads the
  change feed only if its own head differs, so an idle device still makes no reads. Prototype test: "a platform max-age
  cut ends the stream cleanly; the client can reopen" (`MAX_AGE_MS`).
- Browsers: `EventSource` cannot send `x-squeak-account`, so the web uses a `fetch` stream; the Mac and iPhone use
  `URLSession` byte streams. WebSocket would add nothing the notice flow needs (the client never sends).

Unmeasured, in the live plan: does the front door cut at 30 s or buffer; does an open stream count toward the 100 cap;
does `Upgrade` pass; per-instance behaviour at 1 to 5 instances.

## 2. Is the existing AppSail app a safe place?

No; use a separate service. Reasons:

- Shared budget: 100 concurrent requests per instance would be split between Mac requests (the owner's Mac is on this app
  since 2026-11-16; token routes are forwarded to the function) and held streams. Streams would starve ordinary requests,
  and the relay's 80-request scale trigger would fire on devices, not load.
- Deploys: the relay redeploys often (relay 1.x releases); every deploy would drop every device's stream at once.
- Different shape: the relay is stateless with `requestTimeout` 30 s and 256 MB; the hub holds state in memory
  (watcher sets) and wants different timeouts.
- A project allows 5 AppSail services; this uses a second. Code stays one module: `squeak-live` imports the same
  `scoped.js` token verification and Data Store membership reads; the relay posts a notice to it (Data Streams internal
  channel, or a direct call to the hub with the relay key) after a write.
- The relay keeps working unchanged until clients move; the Mac's existing path is untouched.

## 3. Data Store limits for the people tables

Sources: Data Store docs (<https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/llms-full.md>), skill
`catalyst-datastore`.

- Columns: **100 per table** (raisable). Types: varchar max 255, text max 10,000 chars, int 4-byte, bigint 8-byte,
  boolean stored as the strings `"true"`/`"false"`. No row-count limit or row size is documented (unmeasured).
- Unique: `IsUnique` is **per column, cannot be changed after the column is created**; composite uniqueness is not
  documented. Work-around: a derived column `key` = `pondId:accountId` (varchar 255, unique). One pending invite per address per
  Pond: `pondId:email` unique among pending rows only means the unique column must be cleared when an invite stops being
  pending (or a pending/accepted state encoded in the key).
- The 10-person limit without transactions: **no multi-statement transactions** (skill, confirmed). Use slot rows: a
  membership insert claims `pondId:slot<0..9>` (unique), so the constraint, not a count-then-insert race, enforces the cap.
- ZCQL: max **300 rows** per query, max 20 columns per SELECT (`SELECT *` counts as one), `LIMIT offset,count`,
  joins within one Data Store, `COUNT/SUM/IN/ORDER BY/GROUP BY`. `LIKE` wildcards silently return nothing, `AS` aliases are
  silently dropped. Table and column names case-sensitive. Results are wrapped under the table name.
- Bulk: 200 rows per bulk delete or insert call; bulk write up to 100,000 in the background.
- **Emoji and other 4-byte UTF-8 are stored as `?`.** Display names from sign-in and Pond names must be stored as
  escaped text or kept in NoSQL, or people's names will be corrupted. Decide in 2b.
- `CREATEDTIME` is in the project timezone without an offset; store our own epoch-ms bigint for `joined`, `left`,
  `lastSeen`, never parse `CREATEDTIME`.
- Concurrency: the skill notes 10 concurrent executions per function and HTTP 429 when the queue is full (per function
  environment); applies to the old function, unmeasured for AppSail.
- Latency: not documented; unmeasured. Design assumption to confirm: a single-row read is tens of milliseconds, so
  membership is cached in memory per instance (invalidated by the same notice bus) and read per subscribe, never per notice.

Versus NoSQL: NoSQL has partition-key reads only (no filter by secondary column without a scan), no unique constraint
beyond the key itself, and typed attribute builders. The people tables need lookups by account (my Ponds), by Pond (members),
by email (pending invites): three access paths, which a relational table with an index serves and NoSQL does not without
duplicated rows. Keep NoSQL for sealed content only, as the ADR says. The one overlap is `memberships`: a NoSQL
`pondId` partition with an `acct` sort key gives a free one-row-per-account uniqueness and a cheap "members of Pond"
query, but "my Ponds" would need a second copy; not worth the dual write.

## 4. Cost (pricing skill, USD, last verified May 2026 in the skill; India DC is billed in INR)

AppSail is billed per instance uptime: $0.08 per GB-hour, 15 GB-hours free per month for the whole account, $5 minimum per
project over free tier.

- One always-on instance: 256 MB = 182.5 GB-h/month, so **$13.4/month** (182.5 minus 15 free times $0.08); 512 MB $28;
  2048 MB $115.6.
- Relay app plus `squeak-live`, one 256 MB instance each: 365 GB-h, **$28/month**.
- `squeak-live` at five 256 MB instances: 912.5 GB-h, about $72/month. That is also the price of the 500-device ceiling
  if the 100-request cap holds (about $0.14 per device per month at the ceiling).
- Whether an instance with only an open stream counts as "active" or scales down after 5 minutes is unmeasured.
  Count it as always on.
- **Idle device = 1 connection, no requests**: heartbeats are bytes on one request, not billed requests. If the front
  door forces a 30 s cut, each device makes about 2,880 reconnect requests a day: free on AppSail itself, but if
  API Gateway sits in front, $0.000001 each is about $0.09 per device per month (and 86,400 of the 100,000 free
  per month). Unmeasured.
- Data Store: membership read per subscribe (not per notice) at $0.00006 per SELECT with 10,000 free: a device that
  reconnects daily costs under $0.002 a month. Writes: INSERT $0.0001 (5,000 free), UPDATE $0.00008 (1,000 free: the
  tightest free tier; `lastSeen` must be one update when the last connection closes, as the spec says).
- Room post: one NoSQL write, one Data Streams publish per instance (at most 5), in-process fan-out, one small read per
  watching device. **The pricing skill lists no NoSQL or Data Streams rate**, so those lines cannot be priced; ask or
  read the pricing page before the budgets become acceptance tests.

## 5. Fallback if AppSail cannot hold connections: sharded Data Streams

Facts that shape it (skill `catalyst-datastreams`):

- Channels are made **by hand in the console** (no SDK or REST). 64 shards means 64 hand-made channels per environment
  (128 with production), each with the same access control.
- Token rules: Custom Logic channel = `connectionName` (at most 20 chars, no `.` or `:`), token generated **only inside the
  function chosen as that channel's access control** (otherwise "Invalid access control source"); the relay code
  already records that AppSail got a 500 for this. User Roles channel = an app user's `userId` from Authentication
  (works from any function or REST, untested from AppSail). Each connection name or user has **one live session per
  channel**; a reconnect needs a new name or a release of the old session.
- Delivery is sequential and each message must be acked (about one round trip each, about 300 ms from India), so one
  subscriber on one shard handles about 3 messages per second. Resume after a drop duplicates and replays 48 hours, so
  reconnect with a fresh token and `subscribe('0')`, then read the change feed; the browser SDK also reconnects itself
  every 27 minutes.
- Design: shard = first byte of SHA-256 of the existing notice tag, mod 64. A device opens one socket per distinct shard
  of the Ponds it is in (a person in 3 Ponds: about 3 sockets, plus its account shard), ignores tags it does not watch.
  Per-subscriber traffic is about 1/64 of the system's notices; at 100 notices per second system-wide that is 1.6 per second,
  inside the 3 per second ack limit, so the design is good for hundreds of notices per second but each socket stays a
  token request (function invocation) per connect.
- Costs of the fallback: a removed member still receives opaque tags for the shards of their old Ponds (metadata, no content;
  rotate the tag salt per key version to close it); no server-side targeting, so "removal closes the subscription" becomes
  "the client stops listening"; the Custom Logic function (`squeak_relay`) cannot be retired, which contradicts the
  spec's "the function is retired once every client uses it".
- **The same token rule matters for the preferred design**: the instance-to-instance Data Streams channel (at most 5
  subscribers) has the same problem. Prefer a **User Roles** channel with one app user per instance
  (`live-1..5`), so AppSail can mint tokens itself, or the hub instances poll a tiny notices table once a second. Which of
  the two works from AppSail is in the live plan.

## Changes to 2b to 2e if the preferred design holds

(Issue numbers for 2b to 2e were not in the material I was given; match by topic.)

- Relay: a second service `squeak-live` (hub, heartbeat 15 s, rotate before 25 s), the relay posts a notice to it after
  a write; Node's `requestTimeout` is 0 on the stream route only; keep the function until clients move.
- Tables: a composite `key` column with `IsUnique` for membership and pending invites, slot rows for the 10-person cap,
  epoch-ms columns instead of `CREATEDTIME`, names without emoji (or kept in NoSQL), caches with notice-driven
  invalidation.
- Change feed and `seq`: the stream's `hello` carries Pond heads so an idle device reads nothing after a reconnect.
- Clients: reconnect with jitter and overlap, 45 s silence watchdog, `fetch` stream on web, no `EventSource`; the
  30 s polling fallback and "Reconnecting..." stay.
- Cross-instance bus: one User Roles channel (preferred) or Custom Logic; the console step is the owner's (the agent
  cannot create it).
- Cost budgets: replace "an idle device makes no requests" with "one open stream, a reconnect request every 25 s if
  the platform cuts streams", until the live test says which.
- If the fallback is chosen instead: 2b's "retire the function" is dropped, and 64 console-made channels per environment
  become an owner task.

## Open risks

1. 100 concurrent requests per instance may cap live devices at about 500 (production) and 100 (development, 1 instance).
   Ask Zoho to raise the limit now (the page marks it as negotiable).
2. The front door may cut or buffer streams (not documented either way).
3. Data Store single-column unique constraints and no transactions push logic into key design; the slot-row trick for
   the 10-person cap needs a live test with concurrent inserts.
4. Emoji in names are corrupted by Data Store.
5. Latency, row limits and Data Store rate limits are undocumented.
6. NoSQL and Data Streams pricing is not in the skill.
7. Prototype memory figures are without TLS and the real front door; multiply by about 1.5 for TLS-terminating proxies if
   the front door passes connections through unterminated (unknown).

## Live test plan (approved and run 2026-11-26; results above)

Steps 1 to 6 ran as written against `squeak-spike-sse`, deploying the spike server through a small wrapper (adds a `/id`
probe and a `/ws` echo, plus the `ws` package). Steps 7 and 8 need console work by the owner:

- Step 7: make a Data Store table `spike_people` in Development with columns `k` (varchar 255, unique), `acct` (varchar 64),
  `n` (bigint); then ask for the run (200 inserts, duplicate `k`, 10 slot races, 300-row SELECT, emoji name, p50/p95 over 100 calls).
- Step 8: make a Data Streams channel `spike_live` (User Roles) and an app user `spike-live-1`; then ask for the run.
- Delete `squeak-spike-sse` (see Cleanup above) and, afterwards, the table, channel and app user.
