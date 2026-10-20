# celebrating → `duck-celebrating.png`

**Save as:** `desktop/renderer/duck-celebrating.png`

Shown for 45 seconds after a session finishes. The one state that is allowed
to be loud — it is a small reward, and it is on screen briefly.

## Prompt

> Same rubber duck, same style, same colours, same size and position — only
> the face and posture change.
>
> Make it **delighted**: the eye closed in a happy upward arc (like a `^`),
> drawn in the same dark brown as the outline. The beak open in a cheerful
> squeak. The wing lifted slightly away from the body, as if raised in
> celebration. Chest up, pleased with itself.
>
> Do not add confetti, sparkles, stars, party hats, or motion lines — the app
> draws its own sparkles. Just the duck, transparent background, same framing.
>
> A flat PNG image is all I need — **do not** give me SVG, vector source, a
> layered file, or code. Just the picture.

## Notes

- An open beak is what sells this. A closed-beak "happy" duck reads the same
  as idle at 96px.
- The raised wing must not change the silhouette much — if the duck suddenly
  gets wider, it will jump when the celebration ends.

## Where it goes

Save the image as `duck-celebrating.png` in **`desktop/renderer/`** — the same
folder as the duck you uploaded. Then restart the duck:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
