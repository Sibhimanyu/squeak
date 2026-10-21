# idle → `duck.png` *(already exists)*

**Lives at:** `brand/mood-sprites/duck.png`

The base duck, and the one every other state is a variation of. Shown when
sessions are open but nothing is happening.

This is the file you should **upload to ChatGPT first** so the other states
match it. There is nothing to generate unless you want to redraw the whole
set.

## The base, for reference

Side profile facing right, flat vector, solid fills, bright yellow body with a
deeper yellow wing, orange bill, one small black eye with a white glint, short
upswept tail, thick dark-brown keyline.

## If you do redraw it

Regenerate **all six** states in the same conversation afterwards. A base that
does not match its variations is worse than the current single-sprite
situation, because the duck will appear to change species when it wakes up.

## Where it goes

It already sits at `brand/mood-sprites/duck.png`. That is the file to upload to
ChatGPT, and the file to overwrite if you redraw the base. After any change:

```bash
cd desktop && npm start
```

PNG only. The app loads a raster image; there is nothing to convert and no
SVG anywhere in this pipeline.
