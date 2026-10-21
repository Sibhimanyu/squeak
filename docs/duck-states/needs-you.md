# needs you → `duck-needs_you.png`

**Save as:** `brand/mood-sprites/duck-needs_you.png`

**Note the underscore in the filename.** It matches the internal state name.

Shown when an agent is blocked waiting on you — a permission prompt or a
question. This is the state that has to catch your eye across a room. The app
also draws a red ring and a count badge around it.

## Prompt

> Same rubber duck, same style, same colours, same size and position — only
> the face and posture change.
>
> Make it **asking for your attention**: the eye wide open and larger than
> usual, looking directly out at the viewer rather than ahead. A raised brow
> line above it. The head tilted very slightly, the way an animal tilts its
> head when it wants something. Beak slightly open, as if mid-squeak.
>
> Keep it expectant and appealing, not frightened or distressed. Do not add
> exclamation marks, question marks, speech bubbles, sweat drops, or a red
> ring — the app draws the ring and the badge. Just the duck, transparent
> background, same framing.
>
> A flat PNG image is all I need — **do not** give me SVG, vector source, a
> layered file, or code. Just the picture.

## Notes

- Eye contact is what makes this work. Every other state looks to the right;
  this one looks at you.
- Do not make it alarmed. This fires often, and a panicking duck is stressful
  rather than useful.

## Where it goes

Save the image as `duck-needs_you.png` in **`brand/mood-sprites/`** — the same
folder as the duck you uploaded. Then restart the duck:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
