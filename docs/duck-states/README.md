# Duck states

Squeak's duck shows one of six states. (Written for the old Electron duck; the sprites now live in `brand/mood-sprites/`, the native Mac app's menu-bar duck uses the brand template, and this is still the reference for new artwork.) Right now only one drawing
exists (`duck.png`), so every state reuses it and the duck is wide awake while
it is supposedly asleep. Animation can convey tempo; it cannot close an eye.

This folder has one file per state, each a prompt you can paste straight into
ChatGPT.

## Read this before generating anything

**Upload `brand/mood-sprites/duck.png` first and ask for variations of _that_
duck.** Describing the duck again from scratch produces six ducks that do not
look related. Do the whole set in **one conversation**, each time saying "same
duck, same style, same colours, only change X".

Order matters: do `asleep` first. If that one comes back consistent with the
base, the rest will too. If it does not, fix the style before generating five
more.

## What to save, and where

**Every image goes in `brand/mood-sprites/`.** The app picks them up on restart.
Filenames are exact — note the underscore in `needs_you`.

| file                   | state       | when it shows                                        |
| ---------------------- | ----------- | ---------------------------------------------------- |
| `duck.png`             | idle        | ✅ already exists — sessions open, nothing happening |
| `duck-asleep.png`      | asleep      | nothing running at all                               |
| `duck-working.png`     | working     | an agent is mid-turn                                 |
| `duck-celebrating.png` | celebrating | a session finished in the last 45s                   |
| `duck-needs_you.png`   | needs you   | an agent is blocked waiting on you                   |
| `duck-offline.png`     | offline     | _optional_ — Squeak is not running                   |

Save them into **`brand/mood-sprites/`**, then rebuild whatever uses them:

```bash
cd desktop && npm start
```

Any file you skip falls back to `duck.png`, so you can add them one at a time.

### PNG only — no SVG

Ask for **flat PNG images and nothing else**. Generators like to offer SVG,
vector source, or code, and none of it is usable here: the app loads a raster
image with `<img src="duck-asleep.png">`. There is no SVG anywhere in this
pipeline and nothing to convert. Every prompt in this folder says so, but it
is worth repeating if the model starts producing markup instead of pictures.

## Technical requirements, every image

- **A PNG image, not SVG or vector source.**
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
