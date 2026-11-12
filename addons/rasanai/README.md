# RasanAI (daemon add-on)

Everything in Squeak that knows RasanAI films lives here: a film's director is a Claude session waiting on the person
for the product's own calls (brief, story, look, animatic, final, a question), answered through RasanAI's file protocol.
It ships in every build (`addon.json`: `distributed`) and is inert until the owner enables it in Settings › Add-ons
(core's `addons.json`); after the update it starts off for everyone. Core knows only `src/addons.ts`; this folder
imports core, never the other way round. Design: `docs/rasanai-plugin.md`.

- `index.ts` activates it: a `RasanaiProvider` and a `FilmService` (its extra folders are the cwds of the fleet's
  sessions) and the handle core consumes.
- `provider.ts`, `run.ts`, `actions.ts`: read a run's `session.json`, build the card, take an answer (`actions.jsonl`
  under `actions.lock`).
- `films.ts`, `director.ts`: films independent of chats, liveness, chat, resume and stop.
- `phone.ts`: the add-on's side of the phone channel. Core has already checked the device's signature, expiry, nonce and
  size and calls these only while enabled, handing each `(command, { deviceName, now, snapshot })`: `workflow` and
  `film` command handlers, `phoneImages`/`phoneMedia` (which folder a picture or media may be read from), the view's
  `films` and a row's `workflow`/`workflowProgress`.
- `phone-media.ts`: makes the phone copy of a film or soundtrack (core uploads it as sealed chunks).
- `types.ts`: the RasanAI shapes on top of core's opaque `WorkflowStatus` and `WorkflowProgress`.

Build: `scripts/addons.sh build` bundles it to `dist/addons/rasanai/`; `macos/scripts/embed-daemon.sh` does the same into
the app's daemon. Remove: delete this folder; core still builds and runs, and RasanAI simply isn't offered.
