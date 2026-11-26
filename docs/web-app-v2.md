# Squeak web app (v2, `webapp/`)

The rebuild described in `docs/spec.md` ("Web app"). It lives beside the old `web/` (deleted in #138); nothing here
touches it. Scaffold only: sign-in and an empty router skeleton. Pond screens arrive in later issues.

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

## Deploy to Slate (not done yet; needs the owner)

1. In the Catalyst console, Slate, create the project (or use `squeak.onslate.in`) from the GitHub repo
   `Sibhimanyu/squeak`, branch `master`.
2. Build settings: install `npm ci`; build `npm run webapp:build` with `SQUEAK_WEB_ENV=production`; output directory
   `webapp/dist`; framework static. `webapp/slate-config.toml` is the config to place at
   `webapp/dist/.catalyst/slate-config.toml` (copy it in the build command if Slate needs it inside the output).
3. Fill `webapp/config/production.json` with the AppSail relay base and the final app origin (both https, no port).
4. Add the Slate origin and each preview origin to the relay's CORS allow-list and to `HANDOFF_ORIGINS`
   (`cloud/catalyst-relay/functions/squeak_relay/handler.js`); the daemon's control routes keep no CORS.
5. Enable preview deploys per branch; open the preview, check sign-in, an invite link `/join#<code>`, light and dark.
6. Old `web/`, the guest page and `/app/index.html` stay until #138.

`/join` needs a real page because Slate ignores redirect rules; the build writes `join/index.html` with `<base href="/">`.

## Ponds screen (#136)

`views/Ponds.tsx` draws Invitations (Join, Decline), Needs you (questions only) and the Pond list under All · Shared · Not shared, newest
first; narrow is one screen, from 860 px the list is the left column (400 px) with the open Pond on the right. `state/ponds-store.ts`
reads the overview once on open and again on a live notice or the 30 s poll; `relay/live.ts` is the web's `squeak-live` client (SSE read
with fetch because EventSource cannot send `x-squeak-account`; 35 s handover, 30 s poll fallback, "Live" / "Reconnecting…" from what the
stream knows; no `liveBase` in the config means polling and no connection line). Join and Decline change the screen only after the cloud
confirms.

Relay routes this assumes, not built yet (the fake relay implements them; shapes in `src/shared/shapes.ts`):

- `GET /account/overview` with `x-squeak-account`: `{ ponds: PondSummary[], invitations: Invitation[], needsYou: NeedsYouItem[] }`.
  Pond content documents on `GET /changes` are sealed with Pond keys the web does not hold yet, so the list's summary line, unread, working
  and waiting marks have to come from the relay as plain fields; the feed read of "reopen" is this one call.
- `POST /account/invitations/<inviteId>/join` (200 `{ pondId }`) and `/decline` (204), same header. The invitation lifecycle is #126.
- `liveBase` in `webapp/config/<env>.json`: the `squeak-live` URL (https), with CORS for the Slate origin and the `x-squeak-account` and
  `x-squeak-device` headers.
