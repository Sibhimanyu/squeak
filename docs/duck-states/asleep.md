# asleep → `duck-asleep.png`

**Save as:** `brand/mood-sprites/duck-asleep.png`

Shown when nothing is running. The calmest state — this is the duck you see
most of the day, so it should be restful, not comatose.

**Generate this one first.** It is the biggest change from the base, so if the
style survives here the rest will be easy.

## Prompt

> Same rubber duck, same style, same colours, same size and position — only
> the face and posture change.
>
> Make it **asleep**: the eye closed, drawn as a single short downward-curving
> line in the same dark brown as the outline. The head settled down slightly
> towards the body, as though resting. A faint, content curve to the beak.
> Everything relaxed and soft.
>
> Do not add any Z's, stars, bubbles, a nightcap, a pillow, or a bed — those
> are drawn by the app. Just the duck, transparent background, same framing.
>
> A flat PNG image is all I need — **do not** give me SVG, vector source, a
> layered file, or code. Just the picture.

## Notes

- The closed eye is the whole point. If it comes back with an open eye or a
  drawn-on "sleepy" eyelid over a visible pupil, regenerate.
- A sunk head is nice but optional. **Consistent scale matters more** — if the
  duck shrinks or shifts, it will visibly jump when it wakes up.

## Where it goes

Save the image as `duck-asleep.png` in **`brand/mood-sprites/`** — the same
folder as the duck you uploaded. Then restart the duck:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
