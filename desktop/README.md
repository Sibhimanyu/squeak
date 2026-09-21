# The duck

A rubber duck that floats on your screen and tells you what your coding agents
are doing. Click it for the list; it quacks at you on Telegram separately.

```bash
cd desktop
npm install
npm start
```

It needs the bridge running, because it draws what the bridge already knows.
With no bridge it goes grey and says so rather than showing stale state.

## Menu bar, hiding, and the shortcut

There is a duck in the menu bar whenever the app is running. It shows a count
beside it when something is blocked on you, and nothing at all otherwise —
a menu-bar item that always displays a number stops being read.

Click it for the active sessions (each opens its working directory), plus:

- **Show duck** — uncheck to hide the floating duck and keep only the menu bar
  item. Remembered across restarts, and the app starts hidden without
  flashing on screen first.
- **Peek at panel (⌃⌥D)** — global shortcut. If the duck is hidden it comes
  back with its panel open; otherwise it just toggles the panel. It never
  hides the duck, so the same keystroke cannot make it vanish on you.
- **Reset duck position** — for when it ends up on a display you unplugged.

The panel closes when you click anywhere else, the way a macOS popover does.
That is why an open panel takes focus — without it there is no click-away to
detect. A collapsed duck never takes focus.

Right-clicking the duck itself offers Hide, Reset position and Quit.

Change the shortcut by adding `"shortcut": "Control+Alt+K"` to
`~/Library/Application Support/conductor-tg-duck/duck.json`. If another app
already owns the combination, the duck logs that it could not register it
rather than failing silently.

## What it shows

| duck | meaning |
| --- | --- |
| eyes shut, drifting `z`s | nothing running |
| gentle bob | sessions open, nothing happening |
| quick bob | an agent is mid-turn |
| red ring, red badge | something is blocked on you |
| hopping, sparkles, blue ✓ | something just finished |

Click to open the panel, click again to close. Drag it anywhere; it remembers
where. Right-click for reset-position and quit. Clicking a session's name
opens its working directory.

## Artwork and states

The duck has six states and wants a drawing for each. Only `duck.png` exists
so far, so the others fall back to it — which is why the sleeping duck is
wide awake. Animation carries tempo; it cannot close an eye.

`docs/duck-states/` has a pasteable prompt per state and the exact filenames.
Drop the PNGs into `renderer/` and restart; missing ones fall back to
`duck.png`, so they can be added one at a time.

## Replacing the artwork

The hand-drawn duck is a fallback. Drop a PNG at `renderer/duck.png` and the
app uses that instead — no code change, just restart it. Optionally add
`renderer/duck-asleep.png` (same duck, eye closed) and it will be swapped in
when nothing is running.

The current `duck.png` was generated from the prompt in the project README and
normalised: trimmed to its content, re-centred on a square canvas with even
padding, and resized to 512px (4x the display size). Generators frame things
inconsistently, so normalising is what makes the sprite sit predictably.

What the image needs: transparent background, square, the duck centred with a
little padding, and a keyline or otherwise enough contrast to read against
both a white editor and a dark terminal. It is displayed at 96px, so detail
below roughly 3px of the source will disappear.

Everything that is not the duck — the badge, the alert ring, the sparkles, the
sleeping `z`s, the shadow — is drawn as an overlay, so it keeps working
whatever the artwork is. Offline is shown by desaturating the sprite, since a
PNG cannot be recoloured the way the fallback's fills can.

## How it is wired

The duck is presentational and decides nothing. It polls
`http://127.0.0.1:8477/state` on the bridge's loopback server every two
seconds and renders the answer. Which sessions count as active, what each one
is doing, and which mood the duck is in are all computed in the daemon
(`src/fleet/active.ts`, `src/fleet/duck-mood.ts`) where CI covers them — so the
duck and Telegram can never tell you different stories.

Set `FLEET_HOOK_PORT` if the bridge is on another port.

## Why there is no build step

This is a small personal UI in plain JavaScript. A bundler between "edit the
duck" and "see the duck" would cost more than it returns, and everything worth
testing lives in the daemon instead. It is also why `desktop/` is a separate
package: `conductor-tg` is published to npm, and a CLI should not carry a GUI
framework as a dependency.

## Screenshots without permission

`DUCK_CAPTURE=/path/prefix npm start` makes the window photograph itself and
write `-collapsed.png` and `-expanded.png`, then quit. Useful because it needs
no Screen Recording permission, which a headless run will never have.
