# Squeak web app (v2, `webapp/`)

The rebuild described in `docs/spec.md` ("Web app"). The old `web/` and its guest page were deleted in #138; nothing here
touches it.

## Layout

- `webapp/src/` TypeScript with Preact (bundled by esbuild).
  - `main.tsx` boot; `app.tsx` the shell (sign-in, or Ponds / Pond / Duck / Join); `boot.ts` address preparation.
  - `auth/` `session.ts` (token and return path in `sessionStorage`, handoff URL), `auth.ts` (the sign-in state machine).
  - `relay/` `client.ts` (`/me`, invite preview; `x-squeak-account`, `credentials: "omit"`), `fake.ts` (fake relay as a `fetch`).
  - `router.ts` hash router: `#/ponds`, `#/ponds/<id>/room|ducks`, `#/ponds/<id>/ducks/<duck>`, `#/join/<code>`.
  - `views/` `SignIn.tsx`, `Screens.tsx` (placeholders). `styles.css` tokens from DESIGN.md, light and dark by `prefers-color-scheme`.
- `webapp/config/<env>.json` the relay and app origins, inlined at build (`SQUEAK_WEB_ENV`, default `development`).
- `src/shared/` the one module the daemon and the web both import: sealed-box layout and WebCrypto `seal`/`open`
  (`box.ts`), byte helpers, message shapes with readers (`shapes.ts`). It imports no Node module; `src/` never imports
  `webapp/`. `src/remote/remote-crypto.ts` takes its wire constants from `box.ts`; the test proves both paths open each
  other's boxes.
- Brand: the build copies the stacked lockup SVGs from `brand/logo/svg/` (ink in light, paper in dark). Never redrawn.

## Run it locally

```bash
npm install
npm run webapp:dev        # builds, serves http://localhost:5173, rebuilds the bundle on change (reload the page)
npm run webapp:build      # one build to webapp/dist
npm run webapp:test       # vitest for webapp/ and src/shared/
npm run ci                # includes typecheck, lint, format, every test and the web build
```

Local sign-in uses the real relay URL in `config/development.json`, which only returns to the pinned Slate origin, so
locally you see the sign-in page and failure states; to see Pond screens before the relay allows localhost, set a token
by hand: `sessionStorage.setItem("squeak-account-token", JSON.stringify({token, exp}))` on a token the relay minted.

## Sign-in

One page: the lockup, one line, Continue with Zoho / Google / email. All three go to the relay's
`GET /account/handoff?return=<app origin>/&provider=<zoho|google|email>`, which signs in on the relay's own origin
(Catalyst hosted login) and 302s back with `#squeak-token=...&exp=...` in the fragment. The page keeps the token in
`sessionStorage`, clears the fragment, sends it as `x-squeak-account` on every relay call, and returns to the route saved
before leaving (`squeak-return-to`). No cookie crosses domains. A 401 from `/me` is signed out; anything else is one
sentence and Try again. An emailed `/join#<code>` link opens the invite route; unauthenticated, it shows
"<inviter> invited you to <pond>" above the buttons.

Relay contract this depends on (the fake relay implements it):

- `GET /me` with `x-squeak-account`: 200 `{userId|id, email, name?}`, 401 signed out (exists today).
- `GET /invites/preview?code=` no auth: 200 `{pond, inviter, members, state, expiresAt}` (first names, no address) else 404 (built in #118, `docs/cloud-cutover.md`; until it
  exists the invite page falls back to the plain sign-in).
- Handoff `provider=` hint (built in #118; whether hosted login honours it is unverified, otherwise all three buttons reach the hosted page).
- CORS: the relay must allow the Slate origin (and preview origins) on `/me` and `/invites/preview`, with the
  `x-squeak-account` header.

## Deploy to Slate

Live on Development since 2026-11-27 (Slate app `squeak`, app_type cli, `https://squeak.onslate.in`). It deploys from a local folder, not
from GitHub: build with `SQUEAK_WEB_ENV=production npm run webapp:build`; in an empty temp folder run `catalyst init -p 53069000000381140 -ni`,
copy `webapp/dist` to `app/` and `webapp/slate-config.toml` to `app/.catalyst/`; `catalyst slate:link --name squeak --framework static
--source app --default` (it asks for the deployment name: `default`); then `catalyst deploy slate squeak -m "<note>"`. The steps below are
the GitHub-driven alternative, not used.


1. In the Catalyst console, Slate, create the project (or use `squeak.onslate.in`) from the GitHub repo
   `Sibhimanyu/squeak`, branch `master`.
2. Build settings: install `npm ci`; build `npm run webapp:build` with `SQUEAK_WEB_ENV=production`; output directory
   `webapp/dist`; framework static. `webapp/slate-config.toml` is the config to place at
   `webapp/dist/.catalyst/slate-config.toml` (copy it in the build command if Slate needs it inside the output).
3. Fill `webapp/config/production.json` with the AppSail relay base and the final app origin (both https, no port).
4. Add the Slate origin and each preview origin to the relay's CORS allow-list and to `HANDOFF_ORIGINS`
   (`cloud/catalyst-relay/functions/squeak_relay/handler.js`); the daemon's control routes keep no CORS.
5. Enable preview deploys per branch; open the preview, check sign-in, an invite link `/join#<code>`, light and dark.
6. The old `web/` and the guest page are gone (#138); `/app/index.html` is a redirect (#133).

`/join` needs a real page because Slate ignores redirect rules; the build writes `join/index.html` with `<base href="/">`.

## Ponds screen (#136)

`views/Ponds.tsx` draws Invitations (Join, Decline), Needs you (questions only) and the Pond list under All · Shared · Not shared, newest
first; narrow is one screen, from 860 px the list is the left column (400 px) with the open Pond on the right. `state/ponds-store.ts`
reads the overview once on open and again on a live notice or the 30 s poll; `relay/live.ts` is the web's `squeak-live` client (SSE read
with fetch because EventSource cannot send `x-squeak-account`; 35 s handover, 30 s poll fallback, "Live" / "Reconnecting…" from what the
stream knows; no `liveBase` in the config means polling and no connection line). Join and Decline change the screen only after the cloud
confirms.

Relay routes this assumes, not built yet (the fake relay implements them; shapes in `src/shared/shapes.ts`):

- `GET /account/overview` with `x-squeak-account`: `{ ponds: PondSummary[], invitations: Invitation[] }`, **metadata only** (the cloud never
  reads content, ADR 0005): per Pond `pondId, name, ownerName, ownerKey, mine, role, shared, lastActivityAt` (time of the newest feed row),
  `seqHead` (newest feed seq), `counts {members, ducks}`. No summary line, no marks, no questions: the browser works those out from the
  Pond's decrypted documents. (Built in #137 as a contract change; only the fake relay has the route so far. `ownerKey` is what the
  web pins a key grant's signature to: `GET /account/ponds` already carries it.)
- `POST /account/invitations/<inviteId>/join` (200 `{ pondId }`) and `/decline` (204), same header. The invitation lifecycle is #126.
- `liveBase` in `webapp/config/<env>.json`: the `squeak-live` URL (https), with CORS for the Slate origin and the `x-squeak-account` and
  `x-squeak-device` headers.

## The web is a device (#137)

`device/vault.ts` keeps this browser's key in IndexedDB (non-extractable P-256: one ECDSA key that signs, one ECDH key that opens
boxes; one set per account). `pond/device.ts` registers it (`POST /account/devices`, kind web). For each Pond `pond/session.ts` asks the
Owner's Mac (`POST /account/pond-devices` with both public keys) and the Pond reads "Connecting: waiting for <Owner>'s Mac" until the Mac
writes `keys/<deviceId>` (sealed to the box key, every key version, a Pond token, signed by the Owner). The web believes a grant only when
the Pond's pinned `ownerKey` signed it. `pond/feed.ts` reads `GET /changes` (account token), opens each document with the key its box
names (AAD = its path), and checks its signature (Owner's key for `room`/`rtasks`/`members`; a member's keys for their `rposts`,
`threads`; the starter's for `tevents`). Writes are sealed and signed with this device's key and sent with the Pond token to `PUT /doc`:
`rposts` (a message, Make task, a Duck request) and `tcmds` (message, answer, stop). The wire layout is `src/shared/` (`box.ts`,
`member-box.ts`), tested against the daemon's Node code.

Format knowledge sits in `pond/room-format.ts` (Room), `pond/duck-format.ts` (Ducks, commands) and `pond/people-format.ts`.

Mac-side follow-ups, done: the Owner's Mac adopts the Owner's own devices (browser, another Mac) into Ponds it owns, by the same
rule (the relay says which account asked; it must be this Mac's own account, `names().self`), sealed with every key version, and
rotation reaches them; the Owner's account is in the Pond's account index so the browser can ask. The signing key stays on the one
Mac, and a removal note never drops the Owner's own Mac. `stop` is a `tcmds` command kind (Owner only, any non-private Duck; a
Member or Viewer gets "Only the Owner can stop a duck."), wired to the session host's interrupt. The Owner's own `start`, as a `tcmds`
command or an `rposts` `start` ask from their device, runs at once with no approval; a Member's still waits in the queue.

The relay routes are built (`cloud/catalyst-relay/test/overview.test.ts`): `GET /account/overview` as above (rows from the account
index, which the Owner's Mac now fills with `ownerUserId` and each account's `roles`; people tables where present; feed head and its
time; members and ducks counted by document id), and `POST /account/invitations/<inviteId>/join|decline`, minimal: the invitation
must be pending and addressed to the caller's signed-in email; join records the membership and settles it, decline only settles it.
The rest of the invitation lifecycle (and the Owner's Mac learning that someone joined this way) is #126's. All three have CORS for
the Slate origin.

## People, Settings and connection states (#138)

`views/People.tsx` is the People sheet (route `#/ponds/<id>/people`, opened from the avatars in the Pond header, Done goes back). It reads
`GET /ponds/<id>/people` (relay: any member; members with name, email, role, `lastSeenAt`, and the Owner also gets the invites). A person
shows with their email under the name (the email stands in for a missing name), "online" (seen in the last 5 minutes) or "last seen 2 h
ago", and the role. The Owner has the invite box (email and Member or Viewer), a role picker and Remove (inline confirm) on each person,
invites below with their states ("Invited · 3 days ago" with Resend and Withdraw; "Declined · 2 h ago", "Expired", "Withdrawn" with Invite
again; Joined moves up into Members), and a typed-name Delete of the Pond. A Member or Viewer sees "Only <Owner> can invite, remove or change
roles." and Leave with the specced confirm. Every change calls the relay and the list is read again from the cloud only when it says yes; a
refusal keeps the screen as it was with one sentence.

Relay routes added for this (`cloud/catalyst-relay/test/people-routes.test.ts`), all with the account token and CORS for the web origin:

- `GET /ponds/<id>/people`, `POST /ponds/<id>/members/<userId>/role {role}`, `DELETE /ponds/<id>/members/<userId>`,
  `DELETE /ponds/<id> {name}` (the typed name must match). Owner only except the read. `POST /account/pond-leaves` (already there) now also
  takes the leaving account out of the people table and ends its devices' tokens in that Pond.
- Each takes effect in the cloud at once (people table, the account index row, the devices' tokens) and leaves a relay-owned note in the
  Pond's `devreqs` queue: `{v:1, reqId: "pn-<act>-<userId>", userId, act: "remove" | "leave" | "role" | "delete", role?}`. The Owner's Mac
  finishes what needs its keys (`FlotillaService.applyPeopleNote`): rotate the key and say it in the Room (remove, leave), sign the member
  document (role), delete the sealed documents (delete). A note waits there while that Mac is away.
- Also CORS now: `/account/devices[/<id>]` and the invite routes `/ponds/<id>/invites...`.

`views/Settings.tsx` (`#/settings`, from the avatar on the Ponds screen): the account's name and email from sign-in with the note that
Squeak does not change them; Your devices (`GET /account/devices?deviceId=` with this browser's id, `DELETE /account/devices/<id>` after a
confirm; "Removing a device removes it from every Pond."); the "Open on your Mac" line; Sign out. Devices appear only here.

Connection states: the Pond header says one of Live, Reconnecting… or Owner's Mac offline (the Mac being away outranks Live, the stream being
down outranks both because presence comes from it) and the offline banner says messages wait and arrive in order; a Pond that cannot be read is
one sentence with Try again.

A Pond the Owner deleted arrives in the overview as `deleted: true` (the relay keeps the row a week). `state/ponds-store.ts` drops it
from the list, stops its session (keys, Pond token and opened documents live only there; the IndexedDB vault holds the account's one
device key, nothing per Pond) and removes its `squeak-seen-<id>` mark; an open Pond or Duck of it reads "<Pond> was deleted." (`state.deleted`).
