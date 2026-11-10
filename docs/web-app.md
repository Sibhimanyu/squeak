# Squeak for Web: structure

`web/` is a static page (no build step) that pairs with a Mac and shows what the Mac shows a phone. The
channel layer is `channel.js` (paths, signed documents), `channel-crypto.js`, `sync.js` (view, presence,
results) and `sends.js` (replies on screen). Everything else is drawn by `app.js` and the screens below.

Live at <https://squeak-mac.web.app/>: the no-install phone option with the iPhone app's features, minus Face ID
and the same-Wi-Fi direct route. It pairs by QR (camera button) or pasted link and needs the same Firebase project
(`SQUEAK_REMOTE_PROJECT`) as the iPhone app.

## Commands

`commands.js` is the typed API for every signed command except reply, stop, rename and queue (those stay in
`sends.js`, where a message is on screen). `command-shapes.js` checks each input the way the Mac does.

```js
const out = await ctx.commands.controls({ change: { volume: 40 } });
// { ok, status, result, reason, retrySafe, unconfirmed }
```

Kinds: start, answer, attach, history, subagent, diff, close, workspace, setup, usage, stats, awake,
lidActions, controls, notify, voice, telegramAvatar, hotspot, workflow, film, media, image. An ambiguous
command (`unconfirmed`) is never sent again by the module; offer "Send again" only when `retrySafe`.
`commands.hint(kind)` / `waitMs(kind)` / `throttle(kind)` carry the Mac's limits (attach: 40 pieces a
minute). `images.js` prepares, uploads (`uploadPhoto`) and fetches (`fetchImage`) pictures.
`view-model.js` reads the view fields (`chatModels`, `macControls`, `notify`, ...): null means the Mac does
not say, so the screen hides the control.

## Adding a screen

1. Write `web/js/<name>-view.js` exporting `render(ctx)` (a Node, an array of Nodes, or null).
2. Write `web/js/<name>-screen.js`:
   ```js
   import { registerScreen } from "./router.js";
   registerScreen({
     id: "usage",
     title: "Usage",
     icon: chartIcon,
     navPlacement: "tab",
     load: () => import("./usage-view.js"),
   });
   ```
   `navPlacement` is `"tab"`, `"action"` (a primary entry, like New chat) or `"none"` (reachable with
   `ctx.navigate(id)` only). Entries sort by `order` (new-chat 30, usage 40, settings 90, default 60).
3. Add one line to `web/js/screens.js`: `import "./<name>-screen.js";`.

`ctx`: `{ view, record, sync, commands, outbox, prefs: { get, save }, navigate(id), touch(), selectChat(key), settings }`.
The module loads on first open; a failed load shows an error and a retry, never a blank pane.

## Owner app on Catalyst, and the one entry page

The owner app speaks two stores. A pairing code with `cu` (relay base URL) and `ck` (relay key) and no `p`/`r` is a Catalyst
Mac; one with `p` and `r` is Firebase (`pairing-link.js`: `provider` is `"catalyst"` or `"firebase"`). The relay URL must be https,
no credentials or port, host under `.catalystserverless.` or `.catalystappsail.` + `com|in|eu|com.au|jp|ca|sa` (the Node
`relayBaseUrl` in `src/cloud/location.ts`, `guest-invite.js` here), the key `[A-Za-z0-9_-]{16,200}`; `cu` and `ck` come together
or the code is refused.

`catalyst-db.js` (`CatalystDb`) has `rtdb.js`'s surface (`get`/`set`/`delete`/`watch`/`closeAll`) over the relay with
`x-squeak-relay: <ck>`: it wraps the guest page's `RelayStore` and `watchPond` (`header` and `streamRoute` options: the owner's
Data Streams token route is `/token`, the guest's `/pond-stream`). One socket serves every listener; a notice carries no data
and wakes every listener with `{ kind: "change" }`, they re-read through `get`; `open` and `dropped` follow the socket; a 60 s
poll is the safety net. `pairing.js`'s `channelFor` picks the store from the saved device record, which now also holds
`provider`, `relayUrl`, `relayKey` (IndexedDB only). A record with no `provider` is a Firebase one and loads as before.
A Mac that moves the channel (`state/move`) is not followed by the web app: pair again.

Catalyst client hosting answers 200 only for `/app/index.html`, so `web/entry.html` (packaged as `index.html`) and
`js/entry.js` choose: an invite fragment goes to the guest page; a `#pair=` fragment, a stored owner device, or nothing goes
to the owner app; with no fragment, a browser holding only guest records (a joined pond, a parked invite) goes back to the guest
page. The entry loads the chosen app's stylesheets and module into the same page. `scripts/build-guest-client.sh` packages both
(it follows `entry.js`, `guest-boot.js` and `app.js` imports, comment lines ignored) into `cloud/catalyst-relay/client/`. The
entry's CSP is `connect-src 'self'`, Firebase databases, the Catalyst relay hosts and the Data Streams `wss://*.zoho.*` hosts;
`firebase/firebase.json` carries the same Catalyst hosts (a test pins both). Firebase Hosting still serves `web/index.html`
(`firebase/stage-web.sh`); a Firebase-hosted page reaching a Catalyst relay is cross-origin and needs the relay to allow it
(not verified; the relay sends no CORS headers today), so the Catalyst-hosted page is the one for a Catalyst Mac. The PWA manifest
is Firebase-only (its `start_url` is `/`).

## Owner accounts (Catalyst hosting)

Signing in never opens a Mac by itself: the Mac approves each browser. On a Catalyst page, an unpaired start asks the page's own
relay (`<origin>/server/squeak_relay`, same origin, `credentials: "include"`) who is signed in (`GET /me`, `guest-relay.js`
`fetchMe`):

- 200: "Your Macs" from `GET /account/macs` (name, "Linked <date>", each a button) and "Pair with a QR code instead".
- 401: "Sign in to see your Macs" (`/__catalyst/auth/login`: Zoho, Google or email) and the QR option.
- anything else (Firebase hosting, network): today's QR pairing screen only. `welcomeScreen` gets a way back to the account
  start only when there is one.

`catalyst-session.js` holds what the guest page and this app share: the login path, `sdkSignOut`, `signInRedirect`,
`accountRelayBase`. `account.js` is the account's calls and flow, `account-view.js` its screens and Settings section.

Picking a Mac: the browser makes its device signing key (`generateDeviceKey`, as `pairing.js` does) and a fresh non-extractable
P-256 ECDH key, and posts `{macId, name, publicKey, boxKey}` (`name` from `deviceNameFor`; `publicKey` = base64 x963 of the
signing key, as a QR pairing request sends it; `boxKey` = base64 x963 of the ECDH public half, a member key as
`guest-crypto.js` writes them). The waiting screen shows the six digits `pairingCode(publicKey)` gives (the QR pairing's code)
and "Approve on <Mac>". It polls `GET /account/device-request?macId=&id=` every 2 s: 202 keeps waiting; the tab being hidden
pauses the asking until it shows again; `expiresAt`, a 410 or Cancel ends it. `{result: {box}}` is opened with
`openFromMember` (the flotilla ECDH seal, pinned by `src/flotilla/fixtures/web-vectors.json`) into the Catalyst pairing payload
`{v:1, c, k, n, cu, ck}`, checked by `pairing-link.js` `parsePairingPayload` (same relay host and key rules as a scanned code),
and saved as a paired device exactly as a QR pairing is (provider `catalyst`, `relayUrl`, `relayKey`); the ECDH key is then
dropped. The device id is the request's id (the Mac's pending id), unless the sealed payload names one in `d`. `{denied: true}`
says "<Mac> said no."; 403 `mac` and 429 `busy` have their own sentences.

Settings, "Account" (only for a browser paired to a Catalyst Mac, never on a Firebase one): signed out, "Sign in to link this
Mac"; signed in with no `account` in the Mac's view, "Link <Mac> to your account (<email>)", which posts
`/account/link-ticket` and sends the signed command `accountLink {ticket}` (`accountUnlink {}` unlinks; both in
`command-shapes.js`); once the view carries `account: {email}` it reads "Linked to <email>" with Unlink. "Sign out" ends the
account's session only (`catalyst.auth.signOut`); the paired device stays, and "Forget this browser" is unchanged.
Tests: `web/test/account.test.js`.

### App sign-in (callback page)

Squeak for Mac and the iPhone app sign an owner in through this page (`/app/index.html`, `js/app-signin.js`, booted by
`js/signin-boot.js`; `entry.js` routes to it). `#mac-signin=<state>` asks for a link ticket, `#app-signin=<state>` for an account
token; `state` is 16-64 characters of `[A-Za-z0-9_-]`, else the page says the link is not complete. The page reads and clears
the fragment, asks `GET /me`; signed out, it parks `{mode, state, at}` in sessionStorage (no secret) and goes to the hosted
login, and on return with no fragment `entry.js` resumes a parked entry younger than 10 minutes before anything else. Signed in,
it shows "Signed in as <name> (<email>)", "Not you? Sign out" (parks the state again, then `catalyst.auth.signOut`) and a primary
"Continue in Squeak". The button, never an automatic redirect (so a page someone else opened cannot silently hand a token over),
posts `/account/link-ticket` and navigates to `squeak-mac://signed-in?ticket=&state=`, or posts `/account/app-token` and navigates
to `squeak://signed-in?token=&state=&email=&name=` (all URL-encoded); the app checks `state` too. Navigating to a custom scheme is
not governed by the page's CSP (`form-action 'none'` covers forms only), so the CSP is unchanged. sessionStorage is allowed in
`app-signin.js` alone (`security.test.js`). Tests: `web/test/app-signin.test.js`.

## Web guests

`web/join.html` is a second, small entry beside the paired-phone app: a person with an invite link and no Squeak joins a pond as a
member with no Nest (`client: "web"`) and sees its shared threads. They open `https://<app domain>/app/index.html#<code>`, sign in
(below) and wait for the owner's approval on their Mac. Contract: docs/ponds.md, "Web guests".

- **Files** (`web/js`, all `guest-*`, browser WebCrypto only): `guest-invite.js` (read the code from the fragment, check it as the Mac does,
  clear the fragment; a Catalyst invite with its join token only), `guest-crypto.js` (seal/open at a path, sign/verify, ECDH unseal, join
  proof, member id; pinned to `src/flotilla/fixtures/web-vectors.json`), `guest-docs.js` (readers for every pond document),
  `guest-relay.js` (`RelayStore`: doc/list with the pond-scoped token in `x-squeak-pond-token`; `watchPond`: the pond's own Data Streams
  socket through `POST /pond-stream`, subscribe/ack as the Mac's `CatalystStore`, reconnect with backoff, 60 s safety poll; a notice only
  wakes a read), `guest-pond.js` (the engine: `join`, `refresh`, `view`, `readEvents`, `sendCommand`, `hold`, `setPresence`),
  `guest-model.js` (what the screens say, pure), `guest-view.js` (draws), `guest.js` (wiring), `guest-boot.js`; `css/guest.css`.
  It reuses `encoding.js`, `dom.js`, `key-store.js`, `format.js` and `chat-timeline.js` (`same`, `workingLabel`). The phone's chat view is
  not reused: it is built around the phone's sessions and outbox, and a pond thread has neither.
- **Flow.** Join writes a request sealed with the pond key and signed by a new member key (join token). It then shows "Waiting for
  <owner> to let you in" and reads until the owner's members document names this key; the pond-scoped token and any newer pond key arrive
  sealed to the member key (`keys/<id>`), and the page moves to the pond. A removed guest's token is revoked by the relay (401), the page
  says so and drops its keys. The page keeps one pond per browser (IndexedDB record `guest`, non-extractable keys); a second invite asks to
  leave the first.
- **Sign-in.** After the invite is read the page calls `GET <relay>/me` (`credentials: "include"`). Signed in (200): "Joining <pond> as
  <name> (<email>)", Join, "Not you? Sign out"; the account name (100 chars) is the join request's `name`, so there is no name box.
  Signed out (a bare 401 or `{"error":"signin"}`): one button, "Continue with Zoho, Google or email", which goes to Catalyst's hosted
  login `/__catalyst/auth/login` and returns to `login_redirect` (`/app/index.html`, `client-package.json`). Sign-out loads the platform's
  `/__catalyst/sdk/init.js` on demand (same origin, so the CSP holds) and calls `catalyst.auth.signOut("/app/index.html")`. The invite
  secret never goes back in the URL or localStorage: it is parked in the page's IndexedDB (record `pending-invite`) before the
  redirect, restored when the page opens with no fragment (dropped if expired), and deleted once the join request is sent or on
  Cancel. If `/me` cannot answer (network error, a relay with no accounts, any other status) the old name screen stays. A join PUT's
  401 `signin` returns to the sign-in screen and 403 `email` says "This invite is for a different email. Sign in with the email it was
  sent to." Sign-in only says who the person is; the owner still approves.
- **What a guest sees and does.** The pond's name, the Flock (who is online, "Viewing <thread>"), its shared threads as cards grouped
  Needs you, Working, Done, newest first (private threads have no documents, so none show). A thread is the live conversation, resumed by
  `seq`. The composer sends signed `message` commands (Enter queues; Steer, only while it works, sends `steer`); a viewer, or a thread
  that runs `bypassPermissions`, gets the reason instead of a composer. A question is answered through a hold (30 s, renewed while
  typing); someone else's hold shows "<name> is answering" and disables answering. An approval is shown read-only ("Waiting for <starter>
  to approve"). There is no stop and no approve, and no code pane or file tree. A message stays on screen as "Sent. Waiting for the
  thread's starter" until the thread's own `user` event arrives; an ambiguous send is never resent, it can be put back in the box.
- **Tests** (`web/test/guest-*.test.js`, with the real relay handler over a fake store, `FlotillaService` as the owner and the engine's
  real crypto): vectors, browser/Node seal-sign-unseal agreement, join -> approve -> read -> message -> the Mac runs it, the fragment and
  secret never in a request, same-origin relative URLs, removal, the stream protocol, the screens driven end to end on a fake DOM, and the
  Catalyst client folder (`guest-client.test.js`).
- **Hosting.** Not Firebase Hosting: Catalyst web client hosting, so the page and `/server/squeak_relay` share an origin.
  `scripts/build-guest-client.sh` assembles `cloud/catalyst-relay/client/` (join.html, css, the duck, and the scripts `guest-boot.js`
  imports, found by following the imports; generated files are git-ignored, `client-package.json` is tracked) and `catalyst.json` has a
  `client` target. Nothing deploys it here.

## Settings sections

`registerSettingsSection({ id, order, title, render(ctx) })` (`settings-sections.js`), called from a module
that `screens.js` imports. `render` returns Nodes or null to hide the section. Built in: `thinking` (10) and
`device` (90, Forget this browser).

## Capabilities

The presence `caps` are `z`, `split`, `films` (`channel-crypto.js`). The Mac publishes `films` only to a
client that says `films`, and compresses and splits only for `z` and `split`.

## Chat extras

`chat-extras.js` is one long-lived controller (`createExtras(app)` in `app.js`, handed to the chat and Needs you
panes as `env.extras`). It holds what a redraw must not lose (an open dialog, a half-made answer, photos waiting)
and runs the commands; the views only draw: `plan-question-card.js` (plan and question answered in place through
`commands.answer`, single/multi-select, "Something else…", Approve / Ask for changes; an unconfirmed answer locks
the card and is never sent again), `chat-extras-view.js` (stuck notice, background strip, photo bar and paste/drop,
pictures in messages, "Earlier messages", the "More" menu, the model/thinking picker, dialogs), `subagent-sheet.js`
(a subagent's steps, polled from the `live/<handle>-s` document while open, the Mac told to stop on close) and
`diff-view.js` (file list, then one file's patch, long patches in pages of 400 lines). The rules are pure and tested
in `chat-extras-logic.js`.

- **Photos** are shrunk in the browser, saved on the Mac one at a time (`uploadPhoto`), then the message names each
  saved path (`composeMessage`) and goes through the outbox like any text. A failed photo sends nothing and gives
  the words back; an unconfirmed photo is dropped from the list, never retried.
- **Pictures** in a message (`[Image: ...]` lines, an agent's `![alt](/path)`) load on a tap through `commands.image`
  and enlarge in a dialog (Esc or Close). Thumbnails and pictures are `data:` URIs: the page's policy allows no
  `blob:`.
- **Earlier messages** asks `commands.history {key, before, n: 12}` and reads the page from the `live` document the
  Mac names; the live history now keeps each entry's cursor `id` (`live.js`).
- **Hide on this device** writes the `hiddenChats` preference (`{ [chatKey]: epochMs }`). Home and Settings read it
  with `hidden-chats.js`: `hiddenChats(ctx.prefs.get("hiddenChats"))`, `isHiddenHere(hidden, session)` (hidden until
  the chat has newer activity), `hiddenCount(hidden)`, and `ctx.prefs.save(showHiddenAgainChange())` for Settings'
  "Show hidden chats again". Home does not filter by it yet.
