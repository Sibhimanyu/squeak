# Duck states

Squeak's desktop duck shows one of six states. Right now only one drawing
exists (`duck.png`), so every state reuses it and the duck is wide awake while
it is supposedly asleep. Animation can convey tempo; it cannot close an eye.

This folder has one file per state, each a prompt you can paste straight into
ChatGPT.

## Read this before generating anything

**Upload `desktop/renderer/duck.png` first and ask for variations of *that*
duck.** Describing the duck again from scratch produces six ducks that do not
look related. Do the whole set in **one conversation**, each time saying "same
duck, same style, same colours, only change X".

Order matters: do `asleep` first. If that one comes back consistent with the
base, the rest will too. If it does not, fix the style before generating five
more.

## What to save

The app picks the sprite up automatically on restart. Filenames are exact —
note the underscore in `needs_you`.

| file | state | when it shows |
| --- | --- | --- |
| `duck.png` | idle | ✅ already exists — sessions open, nothing happening |
| `duck-asleep.png` | asleep | nothing running at all |
| `duck-working.png` | working | an agent is mid-turn |
| `duck-celebrating.png` | celebrating | a session finished in the last 45s |
| `duck-needs_you.png` | needs you | an agent is blocked waiting on you |
| `duck-offline.png` | offline | *optional* — Squeak is not running |

Save them into `desktop/renderer/`, then restart the duck. Any file you skip
falls back to `duck.png`, so you can add them one at a time.

## Technical requirements, every image

- **Transparent background.** ChatGPT often returns white even when asked; if
  so, reply "give me that as a PNG with a genuine transparent background".
- **Square**, duck centred, roughly 8% padding.
- **Same scale and position across all six** — the duck must not appear to
  jump when the state changes. This is the most common failure.
- Displayed at **96px**, so anything finer than ~3px of source detail vanishes.
- Flat vector style, solid fills, no gradients, no shadow, no ground, no text.
- Keep the dark keyline: it is what makes the duck readable on both a white
  editor and a dark terminal.

## What not to change

Body shape, colour, size, the wing, the direction it faces (right), and the
keyline weight. **Only the face and posture change between states.** Effects
that belong to the app — the badge, the alert ring, the sparkles, the sleeping
`z`s, the shadow — are drawn separately and must not be in the artwork.
