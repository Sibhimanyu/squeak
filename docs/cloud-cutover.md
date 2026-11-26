# Relay cutover: the AppSail server becomes the relay (#118)

The relay is one AppSail app, `squeak-relay`. It runs the same handler as the Catalyst function
(`cloud/catalyst-relay/functions/squeak_relay/handler.js`, the shared core); `cloud/catalyst-relay/appsail/server.js` only
hosts it and adds CORS. There is no second copy of any rule, so a change to the handler is a change to both during the
dual-run. Live connections are not here: they go on a separate AppSail service, `squeak-live` (#121), because open streams
count against an instance's 100 concurrent requests and would starve ordinary calls (`docs/cloud-spike-2026-11.md`).

## What the server does

- Every relay route is answered in-process, with the same auth, limits, quota and notices (the handler). Nothing is
  forwarded, except the temporary live-token bridge below.
- CORS, on the web app's account routes only (`/me`, `/invites/preview`, `/account/macs*` except the two Mac-key token
  routes, `/account/device-request`, `/account/ponds`, `/account/pond-leaves`, `/account/pond-devices`,
  `/account/avatar`, `/ponds/short/redeem`): the exact origin `https://squeak.onslate.in`, plus each preview origin the
  owner lists in `SQUEAK_WEB_PREVIEW_ORIGINS` (comma separated, https only; `*` matches one run of letters, digits and
  dashes inside a label, for example `https://pr-*-squeak.onslate.in`). Allowed headers: `x-squeak-account`,
  `content-type`. No credentials header: the web sends the account token, never a cookie. Control and device routes
  (`/doc`, `/list`, `/ping`, `/token`, `/pond-*`, `/ponds/short`, `/account/link`, hosted-login handoff, `/health`) never
  get a CORS header, preflight included (tests: `test/appsail-web.test.ts`).
- `GET /invites/preview?code=<inviteId>`, no sign-in: `{ pond, inviter, members, state, expiresAt }`, with first names
  only, no address, no ids. `members` is empty unless the invite is pending. Every miss is the same 404; 60 lookups a
  minute for all callers, then 429. (`docs/web-app-v2.md` listed `email` in this answer; it is left out on purpose.)
- `GET /account/handoff?return=...&provider=<zoho|google|email>`: a known value rides through the retry URL and is
  passed to hosted login as `provider`; any other value is dropped. Whether Catalyst's hosted login honours a `provider`
  parameter is not verified (it ignores unknown ones, so the worst case is the plain hosted page).
- The handoff's retry URL is built from the path the request arrived on, so it works behind the function's
  `/server/squeak_relay` prefix and on AppSail's bare paths alike.

## Settings (AppSail environment variables)

- `SQUEAK_NO_CATALYST_USER`: `1` (the dual-run default in `app-config.json`) refuses every route that needs a signed-in
  Catalyst session (cookie) with a 401 pointing at `SQUEAK_ACCOUNT_URL`. Unset or `0`: this server answers them, reading the
  session by asking Catalyst with the browser's own cookie (`index.js`, `currentUserOf`); no `x-zc-*` header is ever trusted
  for identity.
- `SQUEAK_ACCOUNT_URL`: the function's URL. Used for the 401 pointer and for the live-token bridge: `/token` and
  `/pond-stream` are forwarded to the function, because only the function can mint Data Streams tokens (verified live).
  Unset: they are answered here and fail until `squeak-live` replaces them.
- `SQUEAK_WEB_PREVIEW_ORIGINS`: see CORS.
- `deploy-appsail.sh` passes these three through when set in its environment.

## Cutover, in order

Nothing here has been run. Each step is the owner's.

1. Deploy the new bundle to `squeak-relay` (`appsail/deploy-appsail.sh`, Development) with the defaults above. Behaviour
   is unchanged for every current client; the function stays up. Check `/health`, then the web's two calls from the Slate
   origin (`/invites/preview`, `/me` with a token).
2. Prove sign-in on AppSail: set `SQUEAK_NO_CATALYST_USER=0` for a test app (or temporarily), open
   `<appsail>/account/handoff?return=https://squeak.onslate.in/&provider=google` in a browser. It must return to Slate
   with a token in the fragment. If hosted login on the AppSail origin does not recognise the session, this is the blocker:
   keep `SQUEAK_NO_CATALYST_USER=1` and the sign-in routes stay on the function (the web calls the function's origin for
   `/account/handoff` only).
3. Point clients at AppSail: the Mac's pinned relay (`POST /control/cloud/hosted/relay { relay }`), the web's
   `webapp/config/production.json`, then the next Mac and iPhone releases default to it. Old apps keep calling the
   function, which still works.
4. Both run side by side (the dual-run) while old app versions are in use. The stores are the same NoSQL table, so
   either answers any request.
5. When `squeak-live` (#121) is live and clients use it for live updates, remove `SQUEAK_ACCOUNT_URL` and redeploy: the
   bridge and the 401 pointer turn off.
6. Delete the function (`catalyst functions:delete squeak_relay`, plus its Hosted-login entry in the console) only when
   the function's request log shows no client for two weeks and the Mac and iPhone minimums are past the first version that
   calls AppSail. Then delete `functions/squeak_relay/index.js`'s function wiring, `catalyst-config.json` and `deploy-hosted.sh`,
   and the bridge in `server.js` (`forwardToken`); `handler.js` moves under `appsail/`.

## Rollback

Until step 6 the function is untouched, so rolling back is configuration only: put the Mac's pinned relay back
(`POST /control/cloud/hosted/relay { relay: null }` returns to the account origin), revert the web's
`production.json`, and set `SQUEAK_NO_CATALYST_USER=1` plus `SQUEAK_ACCOUNT_URL` on the AppSail app (or redeploy the
previous bundle). After step 6, rollback is a redeploy of the function from the last commit that still has
`deploy-hosted.sh`; keep that commit tagged `relay-function-last`.
