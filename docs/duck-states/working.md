# working → `duck-working.png`

**Save as:** `brand/mood-sprites/duck-working.png`

Shown while an agent is mid-turn. The duck is busy and focused. This state
also gets a faster bob from the app, so the drawing only needs to carry
_attention_, not motion.

## Prompt

> Same rubber duck, same style, same colours, same size and position — only
> the face and posture change.
>
> Make it **focused and busy**: the eye open and narrowed slightly in
> concentration, with a small dark brow line above it. The body leaning very
> slightly forward, as if intent on something just ahead. Beak closed and
> level.
>
> Do not add motion lines, sweat drops, laptops, tools, or sparkles. Just the
> duck, transparent background, same framing.
>
> A flat PNG image is all I need — **do not** give me SVG, vector source, a
> layered file, or code. Just the picture.

## Notes

- Keep it subtle. This shows for long stretches, so an exaggerated strained
  face gets annoying fast.
- The lean should be a few degrees at most — enough to read as intent, not
  enough to look like it is falling over.

## Where it goes

Save the image as `duck-working.png` in **`brand/mood-sprites/`** — the same
folder as the duck you uploaded. Then restart the duck:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
