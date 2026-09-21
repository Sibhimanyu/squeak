# offline → `duck-offline.png` *(optional)*

**Save as:** `desktop/renderer/duck-offline.png`

Shown when the duck cannot reach Squeak — the daemon is not running, or the
port is wrong. Without this file the app just desaturates whichever sprite is
showing, which works fine. Generate it only if you want the nicer version.

## Prompt

> Same rubber duck, same style, same size and position — only the colours,
> face and posture change.
>
> Make it **switched off**: the whole duck in flat greys instead of yellow and
> orange, keeping the same dark outline. The eye a short flat horizontal dash.
> The body slumped slightly, a little deflated. Beak closed and angled down
> very slightly.
>
> Do not add plugs, cables, power symbols, error marks, or text. Just the
> duck, transparent background, same framing.
>
> A flat PNG image is all I need — **do not** give me SVG, vector source, a
> layered file, or code. Just the picture.

## Notes

- Greyscale is the signal. Do not keep a yellow duck with a sad face — it will
  read as a mood rather than as "not connected".
- If this looks worse than the automatic desaturation, delete the file; the
  app falls straight back.

## Where it goes

Save the image as `duck-offline.png` in **`desktop/renderer/`** — the same
folder as the duck you uploaded. Then restart the duck:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
