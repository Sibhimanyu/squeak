# RasanAI in Squeak: directing a film from the phone

Status: phase 1 built 2026-10-21 (Mac `src/workflows/rasanai/`, iPhone `WorkflowCard.swift`): pages, story and look picks with posters, "three more", and the director's questions. RasanAI's side (branch `Sibhimanyu/squeak-interface`: `schema: 1`, `external_actions: 1`, the `squeak-phone` source, phone video proxies) is the contract in its `references/remote.md`; until it is released, Squeak answers headless Studio runs only.

## The pitch

RasanAI asks the person for five calls: confirm the brief, pick one of three
stories, pick one of three looks, give notes on the animatic, and review the
final film. Between those calls a crew of agents works for minutes to hours.
Today the only place to make a call is the Mac, in Studio or the Director's
Console. So the person waits at the desk, or comes back to find the film has
sat for an hour on "pick a look".

Squeak already pages you when an agent needs you and lets you answer from the
iPhone, Telegram or the menu bar. The partnership adds a RasanAI plugin to
Squeak:

- **The page:** "RasanAI needs you: pick a look for *Some Assembly Required*."
- **The call:** the iPhone shows a screen built for that call, not a chat
  message. The three looks appear as posters, the three stories as swipeable
  cards, and the animatic as a player you tap to leave a note at a timecode.
- **The answer:** it goes back the same way Studio sends one, so the director
  cannot tell whether you answered from the desk or from a train.

## What each side already has

| | RasanAI | Squeak |
| --- | --- | --- |
| Knowing a person is needed | `session.json`: `steps[current].status == "awaiting"` and no `sent` field, or an open `ask` | the fleet layer and attention kinds that decide when to push |
| Taking an answer | headless protocol: add a line to `actions.jsonl` while holding `actions.lock`; `console.mjs wait` reads it and records it in `consumed.json` | signed, encrypted, single-use commands from paired phones (`RemoteBridge.handleCommand`) |
| Showing progress | `activity[]`, `crew/ledger.jsonl`, `steps.build.scenes` | "What it's doing" feed, live turn |
| Media | look posters, story frames, animatic stills and WAV, draft and final MP4 | images on request only, shrunk to a JPEG of at most 700 KB; no video |
| Remote | none: the console is loopback only, with a token and a Host check | Realtime Database channel, pairing, Telegram, Cliq |

The two fit well. RasanAI already has a file protocol that needs no server,
which Studio uses, and Squeak already has a trusted path from the phone to
the Mac. The plugin connects them.

## Architecture

### 1. A workflow-provider seam in Squeak (the "plugin")

Squeak has no plugin mechanism today. Every source and command is wired in by
name. Add one narrow interface, `src/workflows/types.ts`:

```ts
interface WorkflowProvider {
  id: string;                                   // "rasanai"
  /** Is this fleet session running one of my workflows? Cheap: called every refresh. */
  attach(session: FleetSession): WorkflowRef | null;
  /** What the human is being asked right now, trimmed for a phone. Null if not waiting. */
  view(ref: WorkflowRef): WorkflowView | null;
  /** Validate and deliver one answer. Must re-check that the step is still waiting. */
  act(ref: WorkflowRef, action: WorkflowAction): Promise<WorkflowResult>;
  /** Phone-sized media for an asset the current view names (never an arbitrary path). */
  media(ref: WorkflowRef, assetId: string): Promise<WorkflowMedia>;
}
```

Its outputs reach the surfaces through the existing hooks:

- **Fleet:** a new attention kind, `workflow_decision`, which pushes.
- **`RemoteBridge`:** a new optional dependency `workflow?` that fills
  `phoneSession().workflow`, written only for phones whose `caps` include
  `"wf"`.
- **`handleCommand`:** a new signed command kind, `workflow`.
- **Mac window:** a `/control/session/<key>/workflow` route plus a POST.
- **Telegram and Cliq:** a renderer that takes a `WorkflowView` and returns a
  card and buttons.

RasanAI is the first provider. Squeak's own lettered choices and
AskUserQuestion cards could later move behind the same interface.

### 2. The RasanAI provider (`src/workflows/rasanai/`)

**Attach.** RasanAI's director is a Claude Code session, so the transcript
observer already sees it. Its `cwd` is the project folder:
`~/Documents/RasanAI/<name>` for Studio, or a workspace in plugin mode. The
provider attaches when `<cwd>/.rasanai/current` exists, then reads
`<cwd>/.rasanai/<current>/session.json`. It caches by mtime, the same way
`ClaudeCostReader` does. Add `.rasanai/` run folders to `change-watcher` so a
new `awaiting` pushes within a second.

**Waiting rule.** Use the same rule as Studio (`StudioStore.swift:298`):

```
(steps[current].status == "awaiting" && !steps[current].sent) || (ask && !ask.answered)
```

`working == null` together with `awaiting` gives the push. The step id maps
to one of the five calls using the table in `references/console.md`. For
example, `look`, `styleframes` and `films` all map to the Look call.

**Act.** Speak the headless protocol exactly as Studio does
(`RunTransport.swift`):

1. Take `actions.lock`. A lock older than 10 s, or whose pid is dead, can be
   taken over.
2. Append `{id, ts, step, type, value, note, source: "squeak-phone"}`.
3. Release the lock.
4. Confirm the answer by watching for its `id` in `consumed.json`. Never write
   it a second time.

Do not go through the HTTP console. It is deliberately loopback-only, with a
token and a Host check, and getting around that would weaken RasanAI.

**What the phone may send** is an allowlist per call, checked against the
current `session.json` and not just the command's own data:

| Call | Allowed actions | Checks |
| --- | --- | --- |
| Brief | `submit` (edited fields), `decide-rest` | fields keep the brief's own types; aspect, length and format come from the catalog |
| Story | `choose <id>`, `more` | id must be one of the stories shown now |
| Look | `choose <id>`, `more`; styleframes: `approve`, `comment`, `redo` | id must be one of the styles or frames shown now |
| Animatic | `comment {scene, t, x, y, scope, quick}` + note, `apply {ids}`, `approve` | scene exists; `t` within its duration; `x` and `y` in 0–1; note ≤ 4000 characters |
| Final | `comment`, `apply`, `choose render\|preview` | same as Animatic |
| Ask | `answer {ask, choice, text}` | the ask id is the one open now and not yet answered |

Each command names the step and a **step revision**, the `session.updated`
value the phone saw. A command made for a step that has since moved on is
refused. Squeak's current-turn check does the same job for chat replies.
`more` and `render` cost real tokens, so they also go through the per-device
`AnswerRateLimit`.

### 3. Media to the phone

| Asset | Raw | What to send |
| --- | --- | --- |
| Look poster (`specimen.png`), story frames | 35–600 KB PNG | the existing image path: `sips` makes a JPEG of at most 1600 px, sent inline (≤ 700 KB). Works today. |
| Animatic stills | 1.7–3.2 MB PNG each | the same, sent per scene as it is opened |
| Animatic audio | 6–17 MB WAV | **a new path**, see below |
| Draft or final film | 3–85 MB MP4 | **a new path**, see below |

Video and audio cannot go inline through the Realtime Database. Proposed path:

- **Make a proxy on the Mac.** `ffmpeg` (or `avconvert`, which ships with
  macOS) writes H.264 at 540p and about 1.2 Mbit/s with AAC audio. A
  30-second final drops from 85 MB to about 5 MB.
- **Animatic as one file.** The Mac renders the stills, at their real
  durations, over the mix into a single MP4. One file is simpler than
  rebuilding the player on the phone, and the phone's existing notes model
  still uses the scene timecodes.
- **Encrypt, upload, fetch.** The Mac encrypts the proxy with the channel key
  and uploads it to **Firebase Storage** (`squeak-5c9gvo`) at a random path.
  The phone downloads it, decrypts it and plays it locally. Storage only ever
  holds ciphertext, so the trust model in `docs/remote-channel.md` still
  holds: the Mac trusts a key, not a server.
- **Housekeeping.** Uploads are deleted when the step closes, with a 24-hour
  TTL as a backstop. Proxies are cached by `(path, mtime)`.

### 4. The interfaces

The phone gets one card per call. It follows DESIGN.md for the surrounding
UI; inside the card, RasanAI's own posters speak for themselves.

- **Brief.** The brief as one editable sentence, with chips for length,
  aspect and format. Buttons: "Confirm brief" and "Just make it"
  (`decide-rest`).
- **Story.** Three cards you page through: title, logline, device, and "why"
  (★ on the recommended one). Tap a card to see its beats. Buttons: "Go with
  Bold" and "Three more like this".
- **Look.** Three full-bleed posters you swipe between, plus the
  open/peak/end strip when there are frames. Buttons: "Use this look" and
  "Three more".
- **Animatic and Final.**
  - A video player with scene markers.
  - Tap the frame to pause and drop a pin, which captures `t`, `x` and `y`;
    then type a note or tap a quick chip (Slower, Faster, Bigger, Simpler,
    Cut it).
  - Notes collect in a tray marked "Apply 3 notes".
  - Buttons: "Looks right, build it" and, on the final, "Render final".
  - Resolved notes show what the director did about them.
- **Ask.** The existing `QuestionCard` fed with RasanAI's `ask`.
- **Between calls.** "What it's doing" shows `activity[]`, the crew
  (Tara, Kavi, Chitra… from `crew/ledger.jsonl`) and build scenes ticking
  from todo to done, with the latest frame.

The other surfaces get less:

- **iPhone Home:** the urgent card reads "Pick a look", with the three
  posters as thumbnails.
- **Telegram and Cliq:**
  - The card: "🎬 *Some Assembly Required* needs a look".
  - Pick buttons: Sure, Bold, Wild (`fleet:wf:<handle>:<id>`).
  - Posters go out with `sendPhoto`, which `src/telegram/client.ts` gains.
  - The animatic and final link to "Open in Squeak". Timed notes on a video
    need the phone app.
- **Mac window:** the same cards. "Open in Studio" hands over to the full
  console.

## What RasanAI would add (the partnership half)

Squeak can build everything above against today's files. To keep it from
breaking with every RasanAI release:

1. **Version the contract.** Add `schema: 1` to `session.json` and publish
   `references/remote.md`, covering the step map, the action shapes and the
   waiting rule, as a public interface.
2. **Name the media.** Give every payload asset a stable `assetId` in
   `session.json`, so Squeak never guesses a path. Optionally write the
   phone proxy (`proxy.mp4`) next to drafts at render time, when RasanAI
   already has the frames hot.
3. **Mark the source.** Accept `source: "squeak-phone"` and show "answered
   from iPhone" in the decisions drawer and taste ledger.
4. **Point to Squeak.** Studio's settings link to "Get calls on your phone
   with Squeak" when Squeak's daemon answers on `127.0.0.1:8477`.

## Plan

| Phase | Ships | Effort |
| --- | --- | --- |
| 1 | Provider seam, RasanAI attach and waiting rule, push on a pending call, phone cards for Story, Look (posters through the existing image path) and Ask, `workflow` command kind with step-revision checks | ~1 week |
| 2 | Video proxies plus encrypted Storage transport; Animatic and Final players with timed notes, apply, approve and render | ~1–1.5 weeks |
| 3 | Brief card, Telegram and Cliq cards with `sendPhoto`, Mac window cards, crew progress feed | ~1 week |
| 4 | Start a new film from the phone (brief composer → Studio project + director launch) | later |

Every phase needs:

- regenerated Swift and Node fixtures, plus `scripts/e2e-remote.ts`;
- a fixture run folder from a real `session.json` at each of the five calls,
  under `src/workflows/rasanai/fixtures/`;
- a test that a stale step revision is refused and that a choice not offered
  is refused.

## Open questions

- **Which mode first?** Studio only (`~/Documents/RasanAI`), or the CLI/plugin
  console too? The headless protocol covers both, but plugin mode starts a
  console server that also watches `actions.jsonl`. That needs checking
  before Squeak writes there.
- **Firebase Storage** is a new service on `squeak-5c9gvo`: rules, quota and
  cost. The fallback is the Realtime Database in chunks (about 5 MB as 64 KB
  chunks), which works but is slow.
- **Partnership shape:** two products that know about each other, or Squeak
  as "the phone for RasanAI" in RasanAI's own onboarding?
