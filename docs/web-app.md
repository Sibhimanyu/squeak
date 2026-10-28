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
