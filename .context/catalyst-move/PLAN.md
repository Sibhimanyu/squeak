# Catalyst move: Functions + Web Client Hosting to AppSail + Slate

Status 2026-11-13 (late): Node 22 function live (Dev); AppSail app `squeak-relay` deployed (Dev) as a DEVICE-ONLY relay, no client points at it. Owner decision: sign-in and account linking stay on the function. Section 7 is current; sections 1-6 are the earlier plan (the Slate/AppSail-serves-sign-in parts are superseded).

## 1. Findings

**The deprecation claim is NOT confirmed by Zoho's public docs.** I searched and read the announcements page, the product
release notes and the AppSail/Web-Client docs:
- No notice deprecating Serverless Functions (Basic/Advanced I/O) or Web Client Hosting. Release notes list only: Event
  Listeners, File Store and Cron deprecated 27 Aug 2025, EOL 30 Apr 2026
  (https://forums.catalyst.zoho.com/portal/en/community/topic/announcing-deprecation-of-catalyst-file-store-event-listeners-and-cron-27-8-2025),
  and Node.js runtime deprecations. https://docs.catalyst.zoho.com/en/release-notes/product
- Real pressure on us: **Node.js 20 is deprecated in Catalyst (Oct 2026)**: no more security patches; move Functions and
  AppSail to Node 22 or 24. `squeak_relay` is `stack: node20` (catalyst-config.json). That alone forces a redeploy.
- Zoho's own Slate docs (plugin skill) call Slate "preferred for all new projects" and Web Client "legacy"; Slate went EA May 2025.
- The owner may have a private notice (console banner, email). Ask for it; do not rely on my not finding one.

**AppSail limits** (https://docs.catalyst.zoho.com/en/serverless/help/appsail/llms-full.md):
- Request must finish in **30 s**. Max **5 instances** per app, 100 concurrent requests/instance, scale-up at 80. Up to 5 AppSail
  services per project. Must listen within **10 s** of start or the instance is killed (cold start duration not published).
- Memory 128-2048 MB (default 512; I set 256). Disk 256 MB, not durable. Port = `X_ZOHO_CATALYST_LISTEN_PORT` (default 9000).
- Not documented: SSE/WebSocket on AppSail. The relay does not need it: it is plain request/response; live updates go over
  Catalyst Data Streams (clients connect to Zoho's DMS directly, the relay only mints token pairs and publishes). Do not add SSE.
- Pricing: free tier lists AppSail at $0.0013 per GB-minute with 900 GB-minutes free/month (account-wide), billed on instance
  uptime, not per call (https://catalyst.zoho.com/free-tier/, https://docs.catalyst.zoho.com/en/deployment-and-billing/billing/free-tier).
  256 MB x 24 h x 30 d = 10,800 GB-min if an instance stays warm all month: **far over the free tier** (about $13/mo). Unknown
  how long an idle instance is kept (docs: ~5 min lifetime then scale down), so a quiet relay should mostly cost little, but
  a phone polling every minute keeps it warm. Measure in Development first. Slate pricing: not published; check the console.
- Env vars: with `app-config.json` linked, the file is the single source of truth and a redeploy wipes console-set vars.
  `deploy-appsail.sh` therefore writes every secret into a temp copy of the config (like deploy-hosted.sh), never into git.

**Auth from AppSail** (skill docs `catalyst-appsail`, `catalyst-authentication`):
- The gateway injects admin-scope `x-zc-*` headers on EVERY AppSail request, anonymous ones too. `initialize(req)` always
  succeeds; the auth check is `getCurrentUser()` returning null. Our `index.js` already treats "no user" as anonymous
  (`currentUserOf`), and its fallback calls `https://<host>/baas/v1/project/<id>/project-user/current` with the browser
  cookie: that URL exists on the function/web-client host, **unverified on the appsail host**. This is the top risk (section 6).
- Session cookies do NOT cross `*.catalystserverless.*`, `*.catalystappsail.*`, `*.onslate.*`. A user signed in on the old host
  is not signed in on the AppSail host; Slate page + AppSail API are cross-site.
- `catalyst_auth: true` wraps the whole service in Catalyst SSO (would block Macs/phones with no cookie): keep `false`.
- Hosted login (`/__catalyst/auth/login`, `redirect_url`) belongs to the web-client/Slate host. Unverified whether AppSail
  serves it. Slate docs: set `client-package.json` `login_redirect` `/` (paths must start with `/`).
- SDK: use `zcatalyst-sdk-node >= 2.5` per the skill; our function uses `@zcatalyst/auth|nosql|datastreams` (modular SDK).
  AppSail passes the same request headers, so `zcAuth.init(req)` should work; **unverified until a deploy**. NoSQL and Data
  Streams are project-level services: AppSail reads/writes the SAME `squeak_docs` table and the same `squeak_notice` channel,
  so keys, accounts, devices and docs are shared between the function and AppSail with no data migration.

**Slate** (skill `catalyst-slate`): default URL `https://<subdomain>.onslate.<tld>` (`.in` for us); served from `/`, not `/app/`;
relative `/server/...` calls break (must be absolute); CORS: add the Slate domain under Authentication > Whitelisting
(Authorized Domains: bare domain via MCP/API, `https://origin` in the console) and **do not set CORS headers in AppSail code**
(the gateway injects them; ours sets none: confirmed, handler.js never writes Access-Control-*). SPA fallback via `_redirects`.
Console activation ("Start Exploring") needed once or `catalyst deploy slate` returns HTTP 400.
URL shapes: function now `https://squeak-60083782173.development.catalystserverless.in/server/squeak_relay`; AppSail
`https://<service>-<ZAID>.development.catalystappsail.in` (Production drops `.development`); Slate `https://<sub>.onslate.in`.
Path of the relay base on AppSail is the origin alone (no `/server/squeak_relay`); the handler strips that prefix if present, so
old and new base URLs both route.

## 2. What I built (all under cloud/catalyst-relay/, function untouched)
- `appsail/server.js`: plain `http` server on `X_ZOHO_CATALYST_LISTEN_PORT`; `/health`; every other request goes to the SAME
  function entry. `build.sh` stages `index.js handler.js rules.js scoped.js tenants.js kinds.json package.json` unchanged next to
  it (one copy of the rules; no forked code) and `npm install`s the same three `@zcatalyst/*` deps.
- `appsail/app-config.json` (node22, 256 MB, `catalyst_auth:false`, placeholder env), `appsail/deploy-appsail.sh` (operator,
  not run), `appsail/package.json` (commonjs marker, needed because the repo root is `type: module`).
- `slate/slate-config.toml`, `slate/build.sh` (stages client/ with `.catalyst/slate-config.toml`, `_redirects`, `relay-origin.js`).
  The client JS is NOT edited: it still assumes `/app/index.html` and `<origin>/server/squeak_relay` (see section 4).
- Tests: `test/transport.ts` wraps `createRelay`; with `RELAY_TRANSPORT=http` every existing relay and tenants test goes over a
  real HTTP server on a random port (appsail/server.js) and the answer is replayed to the fake res. One assertion made
  host-agnostic (Zoho redirect_uri). Run: `npx vitest run cloud` and `RELAY_TRANSPORT=http npx vitest run cloud`.
- Code finding: handler.js builds the Zoho photo `redirect_uri` as `https://<host>/server/squeak_relay/account/zoho-photo/callback`.
  On AppSail that path does not exist: set `SQUEAK_ZOHO_REDIRECT_URI` (supported) to `https://<appsail host>/account/zoho-photo/callback`
  and register it in the Zoho API console. Also `ZOHO_APP_PATH = "/app/index.html"` is where it sends the browser back: on Slate
  it must become `/index.html` (small handler change, needed before Slate cut-over, not done).

## 3. Deploy (for the owner to approve; none of this has been run)
```
cloud/catalyst-relay/appsail/deploy-appsail.sh         # Development; builds, fills secrets in a temp dir, then:
#   catalyst deploy appsail --name squeak-relay --build-path <tmp>/app --stack node22 --command "node server.js"
curl https://<service>-<ZAID>.development.catalystappsail.in/health        # {"status":"ok"}
curl -H "x-squeak-relay: $KEY" https://<...>/ping                          # store ready, channel
# Slate (after console "Start Exploring"):
RELAY_ORIGIN=https://<appsail host> cloud/catalyst-relay/slate/build.sh
catalyst slate:link   # or add {"slate":[{"name":"squeak-web","source":"<abs>/slate/build"}]} to catalyst.json
catalyst deploy slate -m "squeak web"
# Console: Authentication > Whitelisting: add the onslate domain with CORS on (and the Zoho redirect URI above).
```
Function redeploy on node22 meanwhile (independent of the move): change `stack` in catalyst-config.json, `deploy-hosted.sh`.

## 4. Dual-run and cut-over
Origin today: `HOSTED_RELAY_URL` constant in src/cloud/hosted.ts (overridable by `SQUEAK_CLOUD_URL`), `relayBaseUrl()` in
src/cloud/location.ts pins hosts by regex and keeps the path; the Mac stores the URL in cloud.json and gives phones the URL in
the sealed pairing grant (`cu`) and in a signed `move` doc (`c` + `ck`); the web client derives the relay from `location.origin`.
Because function and AppSail share NoSQL and the Data Stream, both are live at once with identical data. Order:
1. Deploy AppSail (Dev). Smoke: /health, /ping, run `RELAY_TRANSPORT=http` tests, then a scratch Mac with `SQUEAK_CLOUD_URL=<appsail>`.
   Spike the two unknowns: (a) `currentUserOf` on the appsail host, (b) hosted login on AppSail.
2. Decide the web app's home (see risk 1). Safest: serve the static web app from AppSail itself (express.static, same-origin,
   same cookie, no CORS), which sidesteps cross-site cookies; Slate then is optional. If Slate: web app must stop using cookies
   cross-site and use `POST /account/app-token` (cookie-only, so sign-in must happen on a host that has the cookie) then
   `x-squeak-account`: needs the sign-in step designed.
3. Ship clients that ACCEPT the new origin first (allow-lists already accept `.catalystappsail.*`; add nothing else). Mac: change
   `HOSTED_RELAY_URL` only in the release AFTER AppSail has run clean for days; existing Macs on the old URL keep working.
4. Move Macs by the existing mechanism: the Mac writes the signed `move` doc (same provider, new `relayUrl`; `sameLocation` sees a
   different URL) on the OLD relay; phones/web verify and switch, confirm via presence on the new one. Needs a small Mac change
   so "same provider, new URL" is allowed through `moveTo` (check hosted.ts deferMove / moveTo path; describe only).
5. Fallback while both run: either origin works for any client; a client that cannot reach the new origin keeps the old (a phone
   that has not seen `move` stays put). Rollback: set the Mac's URL back (`SQUEAK_CLOUD_URL` or cloud.json) and issue the reverse
   `move`; nothing was deleted.
6. Retire the function only when: logs/usage show no calls for 14 days, App Store/TestFlight iPhone builds with the old host
   baked in (ios `Account.swift`/`Channel.swift` default sign-in host) have shipped a version using the new one, and all paired
   Macs report the new URL. Then delete the function, keep the old web client until Slate/AppSail serves `/app/` bookmarks via redirect.
Sign-in redirects change: Zoho OAuth redirect (photo) and Catalyst login return URL both move to the new host; the Zoho API
console redirect URI list must contain both during the dual-run. Old `/app/index.html` links need a redirect page on the old host.

Client changes needed (describe only): src/cloud/hosted.ts `HOSTED_RELAY_URL`; confirm location.ts accepts a path-less base
(it does: path is optional); ios Account/Channel default host constants and the sign-in URL; macos SetupFlow.swift host
constant; web client `RETURN_PATH` `/app/index.html`, `RELAY_PATH` `/server/squeak_relay`, `accountRelayBase()` (use
`window.SQUEAK_RELAY_ORIGIN` on Slate); handler.js `ZOHO_APP_PATH` + redirect_uri default.

## 5. Custom domain (clean hostnames, no project numbers)
Researched from Zoho docs only; nothing bought, mapped or configured. Owner decisions are at the end.

**Default URLs.** AppSail: `https://<service>-<ZAID>.development.catalystappsail.in` (production drops `.development`): the ZAID
is a number, so yes, a project number is in it. Slate: `https://<subdomain>.onslate.in` (subdomain chosen at creation, no number
in the docs shape; the docs page for the exact development/production shape was not retrievable).

**Attach a domain** (https://docs.catalyst.zoho.com/en/slate/help/custom-domains, https://docs.catalyst.zoho.com/en/cloud-scale/help/domain-mappings/llms-full.md):
- Slate: deployment overview > Domain Mapping > Add Domain; CNAME 1 (value shown in console) then Verify; CNAME 2 (host = your
  name) then Verify; then Request a Zoho Group SSL cert ("activate it within 48 hours", auto-renews, free; Zoho cert is mandatory
  even if you have your own). One unique domain per Slate app; default onslate URL stays live. The domain must already be live.
- AppSail (and web client/functions): Cloud Scale > Domain Mappings (docs say an AppSail service can be mapped; the page I
  could read does not name AppSail, so confirm in the console): CNAME `<sub>` -> `catalyst.cs.zohohost.com`, then Add Mapping
  generates a hash key and a second CNAME `<hash>.<sub>` -> `catalyst.cs.zohohost.com`, then Verify. SSL by emailing
  support@zohocatalyst.com for a Group SSL cert (48 h, free, auto-renew). **Subdomains only (no apex), max 5 mappings per
  application, one domain to one app, mappings can only be added in the Production environment.** So the relay must be deployed
  to Production first (separate data from Development: check which environment holds the NoSQL table the Macs use today).
- No extra cost is stated beyond normal AppSail/Slate usage. Plan requirements not stated.

**Auth on a custom domain.** Documented: since Sept 2023 Catalyst Authentication lets you pick a Domain-Mapping custom domain as
a Redirect URL (https://docs.catalyst.zoho.com/en/release-notes/product/). Authorized Domains (Authentication > Whitelisting,
needs an auth type enabled) do CORS and iFrame only; no wildcard or limit information is published, so assume exact entries.
**Not documented, must be spiked:** whether hosted login (`/__catalyst/auth/login`) and the session cookie work on a mapped
AppSail/Slate host, and which cookie Domain Catalyst sets (we do not control it).

**Recommended layout.** Path routing on one domain is not offered (one domain = one app). Options, best first:
1. **One host, one app: `squeak.<domain>` -> AppSail serving both the relay API and the static web app** (express.static for
   the web client, relay routes alongside). Same origin: no CORS, no cross-host cookie, no Slate. Cost: the web deploy rides the
   relay deploy; Slate unused. Lowest risk given the unverified auth behaviour.
2. **Siblings under one parent: `app.<domain>` (Slate) + `relay.<domain>` (AppSail).** Same site, but a host-only cookie is NOT
   sent to the sibling; it works only if Catalyst sets the cookie with Domain=.<domain> (unknown) and the web calls use
   `credentials: "include"`, which needs the relay host to answer the exact origin `https://app.<domain>` with
   Access-Control-Allow-Credentials (gateway behaviour unverified; our code sets no CORS headers and must not). Fallback that
   avoids cookies across hosts: sign in on the host that holds the cookie, mint `POST /account/app-token`, then send
   `x-squeak-account` (already supported).
3. Keep the old hosts (status quo): no clean name.
Cookies/CORS summary: option 1 none; option 2 CORS entry for `https://app.<domain>` in Authorized Domains, credentialed fetch or
app-token, and a login redirect URL for `app.<domain>`. Both need the Zoho photo redirect URI (SQUEAK_ZOHO_REDIRECT_URI) and the
handler `ZOHO_APP_PATH` updated to the new host/path.

**Allow-lists (describe only; src/, ios/, macos/ not edited).** Today `relayBaseUrl()` in src/cloud/location.ts matches only
`.catalystserverless.*` / `.catalystappsail.*` hosts, and the iPhone, web client and docs (cloud-layer.md:78, web-app.md:54)
mirror it. A custom domain needs an **exact pinned host list, never a wildcard or "any https host"**: a compiled-in constant such
as `PINNED_RELAY_HOSTS = ["squeak.<domain>"]` (or relay.<domain>), checked by hostname equality (no suffix match, so
`evil.<domain>.attacker.com` and sibling subdomains of the owner's domain, including any user-takeover-able one, are refused),
https only, no port/userinfo, applied identically in Node (location.ts), Swift (iPhone SqueakCore Channel/Account, macOS
SetupFlow) and the web client. The pairing grant (`cu`) and a `move` doc may name only a Catalyst host or a pinned host; the
hosted `HOSTED_RELAY_URL` and the iPhone sign-in default switch to the pinned host. Add the pin to the apps in a release BEFORE the
domain is announced (older apps keep working on the catalyst hosts, which stay live in the dual-run). Fixture/tests: Node and Swift
must reject `https://squeak.<domain>.evil.com`, `https://x.squeak.<domain>`, `http://`, ports, and accept the pinned host and both Catalyst shapes.

**Owner must decide:** (a) which domain they own/want, and the DNS provider (needs CNAME access, and the zone must already be live);
(b) host names (suggest `squeak.<domain>` for option 1, or `app.` + `relay.`); (c) option 1 or 2; (d) go to the Production
environment (mappings are Production-only): confirm where today's data lives; (e) confirm with Zoho support that AppSail takes a
mapping and that hosted login works on it.

## 6. Risks
1. Auth on AppSail/Slate unverified (cookie lookup, hosted login, cross-site cookies). Spike before anything else.
2. Warm-instance cost on AppSail (above free tier if always warm); 30 s request limit (relay calls are short; Zoho photo fetch
   has its own 10 s timeout); 5-instance cap with in-memory `usageCache`/`ownerCache` per instance (same as functions).
3. Env wipe on redeploy (all secrets must be in the staged app-config.json every time; the script does).
4. Data Streams channel creation is manual in the console today and unchanged.
5. Old iPhone builds with the old host baked in: keep the function until they are gone.
6. No public deprecation notice found: confirm with the owner/Zoho before spending the effort; Node 20 EOL is the confirmed driver.


## 7. The split (owner decision, 2026-11-13): account origin vs relay origin
**Why.** Spiked on the AppSail host: Catalyst's hosted login works there and a session arrives, but `getCurrentUser`/`/project-user/current`
returns no user (user-scope call answers 200 with `data: null`), so Catalyst cannot tell AppSail who is signed in. The function can. Also
measured: the AppSail gateway APPENDS its own `x-zc-*` headers to client-supplied ones (forged `x-zc-user-type`/`x-zc-user-id`/cred token
arrive first, comma-joined), so those headers are forgeable and are never used for identity.
- **account origin = the function** `https://squeak-60083782173.development.catalystserverless.in/server/squeak_relay`: sign-in (hosted login),
  `/me`, link-ticket, app-token, Mac provisioning, device-request, avatar/Zoho photo by session. Unchanged.
- **relay origin = where device traffic goes**: the function today, optionally AppSail `https://squeak-relay-50047538056.development.catalystappsail.in`
  (path-less base; the handler strips `/server/squeak_relay` if present). Same `squeak_docs` table and `squeak_notice` stream, so no data moves.
- AppSail env: `SQUEAK_NO_CATALYST_USER=1` (index.js: `currentUser` is always null) and `appsail/server.js` refuses user routes first.
  `catalyst_auth` is `false` and nothing needs it (device routes prove themselves with keys/tokens). `SQUEAK_ME_DIAG` and the /me diagnostics are gone.

**Routes (handler.js, by who proves the caller)**
| route | proof | where served |
|---|---|---|
| `/doc` GET/PUT/DELETE, `/list`, `/ping`, `/token` | `x-squeak-relay` or `x-squeak-mac-key` | function and AppSail |
| `/pond-token`, `/pond-revoke` | relay key / Mac key | both |
| `/doc`, `/list`, `/pond-stream` as a guest | `x-squeak-pond-token` (HMAC) | both (a join that needs sign-in answers 401 `{error:"signin"}` on AppSail: join/invite flow stays on the function until it is moved with the account origin) |
| `PUT /doc` kind cliq | `x-squeak-cliq` | both |
| `/account/link`, `/account/unlink`, `/account/macs/cliq-token` | Mac/relay key | both |
| `GET /account/avatar?userId=`, PUT/DELETE avatar by a Mac | relay/Mac key | both |
| `/me`, `/account/macs` (list), `/account/macs/provision`, `DELETE /account/macs/<id>`, `/account/device-request`, `/account/avatar` (account) | Squeak `x-squeak-account` token (HMAC, 30 days) | both (the token is Squeak's own, verified by the relay; no Catalyst identity). Without the token: AppSail 401 `signin-on-account-origin` |
| `/account/link-ticket`, `/account/app-token`, `/account/zoho-photo*` | Catalyst session cookie only | function only; AppSail 401 `signin-on-account-origin` + `accountUrl` |
Enforced by `needsCatalystUser` in `appsail/server.js`; `cloud/catalyst-relay/test/appsail-routes.test.ts` checks every user route is refused
(with forged cookie and `x-zc-*` headers, with and without the function prefix) before the handler runs, every device route passes, and
the token routes pass only with `x-squeak-account`.

**Client code (done, defaults change nothing).**
- Node: `src/cloud/location.ts` `ACCOUNT_RELAY_URL`, `APPSAIL_RELAY_URL`, `pinnedRelayBase` (exact hosts, https, no port/userinfo/query,
  function path must be `/server/squeak_relay`, AppSail path empty; no wildcard). `HostedConfig.relay?` (cloud.json `hosted.relay`) routes the
  Mac's device traffic; absent = `hosted.url` = function. `HostedCloud`: provisioning/sign-in always use the account url; a provision answer's
  optional `relay` is kept only if pinned; `view()` adds `accountUrl`, `relayUrl`; `setRelay(url|null)` runs the normal move (round trip on the
  target, paired devices told by the signed `move` whose `c` is the new relay, daemon switched) and saves `hosted.relay` only if it held;
  `POST /control/cloud/hosted/relay {relay}` (token-gated) calls it. Tests: `src/cloud/hosted.test.ts` (pins, defaults, provision, setRelay).
- Web (`web/js/catalyst-session.js`): `accountRelayBase` stays the page origin; new `pinnedRelayBase`, `deviceRelayBase(named)`; tests in
  `web/test/account.test.js`. Nothing calls `deviceRelayBase` yet: the flip wires the move's `c` into it.
- Old apps ignore the new `relay` field and the new routes; an old phone told to move follows `c` (its host check already accepts `catalystappsail`).
- Swift untouched. Needed BEFORE flipping phones (not done, to keep Swift changes out of this step): iOS `Channel.isRelayURL`
  (`ios/SqueakCore/.../Channel.swift`) already accepts any `catalystappsail` host, so tighten it to the two pinned hosts in the same release;
  `Account.defaultAppURL` stays the function (sign-in). macOS `SetupFlow.fallbackBase` stays the function. Run `swift test` in ios/SqueakCore and macos then.

**Flip steps (owner approves each; nothing below has been run).**
1. Preconditions: AppSail `/health` 200 and `/ping` 200 with the Mac key (done); `npx vitest run cloud src/cloud web` and `RELAY_TRANSPORT=http npx vitest run cloud` green; ship the daemon (`./scripts/ship.sh`) so `/control/cloud/hosted/relay` exists.
2. Send: `curl -X POST -H "x-squeak-token: $(cat ~/Library/Application\ Support/squeak/hook-token)" -d '{"relay":"https://squeak-relay-50047538056.development.catalystappsail.in"}' http://127.0.0.1:8477/control/cloud/hosted/relay`
   (a move: test round trip on AppSail first, then phones told on the function store, then the daemon switches; any failure = nothing changes, `{error}` in the answer).
3. Verify: `GET /control/cloud` shows `hosted.relayUrl` = the AppSail origin and `accountUrl` = the function; `squeak.log` shows no relay errors for 5 min; a phone still pairs/sends (presence on the new relay); function `/ping` still 200 for old clients.
4. Rollback: same call with `{"relay":null}` (moves back to the function, phones follow the new `move`); if the daemon cannot reach AppSail, delete `hosted.relay` from cloud.json and restart the daemon. Nothing was deleted on either side.
5. Retire nothing until AppSail has run clean for days; the function remains the account origin permanently.

## 8. Web app on Slate (https://squeak.onslate.in), 2026-11-13
Deployed (Development) from `cloud/catalyst-relay/slate/build.sh` (= scripts/build-guest-client.sh output + .catalyst/slate-config.toml + SPA _redirects) with `catalyst deploy slate squeak` from a temp project dir (`catalyst slate:link --name squeak --source <stage> --framework static`). Legacy `/app/` on the function is untouched.
Sign-in without cross-site cookies: button -> `<function>/server/squeak_relay/account/handoff?return=https://squeak.onslate.in/` -> (signed out) Catalyst hosted login with redirect_url = the same handoff URL (+`&n=1`, one try then 401, never a loop) -> 302 to `https://squeak.onslate.in/#squeak-token=at....&exp=...` (fragment) -> web app stores it in sessionStorage (this tab only) and sends `x-squeak-account` on account calls (`/me`, `/account/macs`, `/account/device-request`, avatar). Relay pins HANDOFF_ORIGINS exactly (https, no port/query/fragment, path / or /index.html), else 400. Sign-out on that origin = forget the token.
Needs a console step (no CLI/API reachable here; the Catalyst MCP was not connected): Authentication > Whitelisting > Authorized Domains: add `https://squeak.onslate.in` (CORS), or the page's calls to the function fail with no Access-Control-Allow-Origin.
Daemon: `WEB_APP_URL` (src/cloud/location.ts), `hosted.webUrl` in `/control/cloud`; the Mac app should use it for "Copy web link"/QR (Swift not changed). Rollback: the function from the previous commit (git checkout 27088377 -- cloud/catalyst-relay && deploy-hosted.sh); Slate: redeploy an older stage or leave the legacy /app/ as the live web app.
