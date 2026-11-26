# The People and remote journey

One test, written once, run twice. It is the proof in `docs/spec.md` ("People and remote", Proof; Testing Decisions). **This
area does not ship while it is red.**

- `src/flotilla/people-journey.test-fixture.ts` — the steps (`peopleJourney(world, step)`), plain sentences of what a person
  sees. No test runner is imported (node:assert), so the daily smoke runs the same file.
- `src/flotilla/people-journey.relay.e2e.test.ts` — runs it in CI on the relay double. It is an ordinary vitest file, so
  `npm run ci` runs it on every push and PR; nothing excludes it. Any change to `src/flotilla`, `src/cloud`,
  `cloud/catalyst-relay`, `webapp` is judged by it.
- `src/flotilla/relay-world.test-fixture.ts` — the double: the real `handler.js` over HTTP with the people tables, the change
  feed (a numbering store), a Stratus bucket and the live hub (`live/hub.js`) on its notice bus, all in memory; a mail sink; the
  relay's clock (`skew`, moved by `double.advanceClock`); every request a device makes is logged (`requests`).
- `src/flotilla/relay-mac.test-fixture.ts` — one Mac or browser (`nest` null) built as a daemon builds it, over any relay.
- `src/flotilla/room-host.test-fixture.ts` — the Owner's Room host and a Member's Room reader.
- `src/flotilla/live-relay-world.test-fixture.ts` + `scripts/smoke-people.ts` + `.github/workflows/smoke-people.yml` — the same
  steps on a real development relay, daily.

`src/flotilla/first-minutes.relay.e2e.test.ts` is the second journey (a new Pond: a Duck started and sent at once, an invitation,
put on GitHub, each landing only where asked). It drives the real session host, its HTTP routes, a real folder with real git
and a fake GitHub, plus the relay double. Not covered: that the buttons and sheets for those steps are where a newcomer looks (that
is the Mac app; `macos/Tests/.../FirstPondJourneyTests.swift` holds the words and the menu decision). It also records that putting a
Pond on GitHub is refused while a Duck is still working, with a sentence and nothing changed.

## What it drives

An Owner's Mac, an invitee on the web (a Mac stack with no Nest, plus the browser's account-token calls) and on a second Mac,
and another Member. Invite, then every invite state read from the one relay record on the Owner's side and the invitee's
(pending, declined, withdrawn, expired by moving the relay's clock, invite again, joined); Connecting; the Owner's Mac pass
lets them in; a second device is added by the account's own sync; the Owner's Mac is away and Members post and read each
other at once, then the Mac returns and takes the posts in order, once; the Owner removes the person and every device is
refused (feed, file, Pond token, live hub), its local copy wiped, and their posts read "(left)"; a new invitation brings them
back with the full history and no mark; they leave; the Owner deletes the Pond and a Member's device reads "<Pond> was deleted".

Cost budgets asserted: an idle device makes no requests; reading a Pond already seen is one feed read; a Room post is one write,
one live notice, and one small feed read per watching device.

Known gap: a whole Room page (`RoomSync.page`) reads three kinds plus the members behind each, so about eight feed reads and one
note document, not one. The journey only asserts it never falls back to a plain list. Closing it means reading the members once
per page.

## The daily smoke

`SQUEAK_SMOKE_RELAY_URL` (a development relay, never production), `SQUEAK_SMOKE_OWNER_TOKEN`, `SQUEAK_SMOKE_INVITEE_TOKEN` and
`SQUEAK_SMOKE_MEMBER_TOKEN` (account tokens of three development accounts, 30 days: mint with `POST /account/app-token` after a
hosted sign-in) as repository secrets. Without them the workflow does nothing and is not red. A real relay cannot expire an invite,
show its mail or open its hub, so those steps are skipped there and named in the output. It sends real invitation mail to the
accounts' addresses and deletes its Pond at the end.

## Changing it

A step that goes red is a product regression until proven otherwise: fix the code, not the step. When a shape changes, change the
fixture in the same commit. A new relay route a device uses should get a request in the journey.
