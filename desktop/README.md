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

## Replacing the artwork

The hand-drawn duck is a fallback. Drop a PNG at `renderer/duck.png` and the
app uses that instead — no code change, just restart it. Optionally add
`renderer/duck-asleep.png` (same duck, eye closed) and it will be swapped in
when nothing is running.

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
