# SqueakIcons

Lucide icons as vector shapes for Squeak's native Mac and iPhone apps
(DESIGN.md 6.4: 1.5pt stroke, 16pt in lists, 20pt in toolbars, muted by default).
No images, no SF Symbols. Lucide is ISC licensed, see `LICENSE-lucide.txt`
(lucide-static 1.59.0).

```swift
import SqueakIcons

Lucide(.search, size: 16)                          // decorative, .secondary
Lucide(.settings, size: 20, color: Theme.muted)    // exact token
Lucide(.x, size: 20, label: "Close")               // icon alone: give it a label
LucideIcon(.gitBranch).stroke(.red, lineWidth: 2)  // raw Shape, 24 grid fitted to the frame
```

The line is 1.5pt at every size (not scaled with the 24 grid). `color` takes any
ShapeStyle; without it the icon is hierarchical `.secondary`.

## Adding an icon

Add the Lucide name to `CURATED` in `scripts/make-lucide-icons.ts`, then
`npx tsx scripts/make-lucide-icons.ts [path/to/lucide/icons]` and commit the
regenerated `Sources/SqueakIcons/LucideData.swift`. `swift test` checks every
icon stays inside the 24 grid and renders. `swift run lucide-sheet out.png`
draws a contact sheet of all icons.

## SF Symbol to Lucide

Case names are camelCase of the Lucide name (`square-pen` is `.squarePen`).

| SF Symbol | Lucide | `LucideName` |
| --- | --- | --- |
| `gearshape` | settings | `.settings` |
| `pin.fill` | pin | `.pin` |
| `arrow.up` | arrow-up | `.arrowUp` |
| `xmark.circle`, `xmark.circle.fill` | circle-x | `.circleX` |
| `xmark` | x | `.x` |
| `square.and.pencil` | square-pen | `.squarePen` |
| `magnifyingglass` | search | `.search` |
| `list.bullet.clipboard` | clipboard-list | `.clipboardList` |
| `list.bullet` | list | `.list` |
| `link` | link | `.link` |
| `info.circle` | info | `.info` |
| `hand.raised` | hand | `.hand` |
| `exclamationmark.triangle` | triangle-alert | `.triangleAlert` |
| `exclamationmark.circle` | circle-alert | `.circleAlert` |
| `doc.text` | file-text | `.fileText` |
| `chevron.down` / `chevron.up` | chevron-down / chevron-up | `.chevronDown` / `.chevronUp` |
| `checkmark` | check | `.check` |
| `checkmark.circle` | circle-check | `.circleCheck` |
| `arrow.up.forward.square` | external-link | `.externalLink` |
| `arrow.triangle.branch` | git-branch | `.gitBranch` |
| `bolt.slash` | zap-off | `.zapOff` |
| `bubble.left` | message-square | `.messageSquare` |
| `text.bubble` | message-square-text | `.messageSquareText` |
| `chevron.left.forwardslash.chevron.right` | code | `.code` |
| `clock.arrow.circlepath` | history | `.history` |
| `ellipsis.circle` | ellipsis | `.ellipsis` |
| `eye.slash` | eye-off | `.eyeOff` |
| `moon.zzz` | moon | `.moon` |
| `person.2` | users | `.users` |
| `text.alignleft` | align-left | `.alignLeft` |
| `wrench.and.screwdriver` | wrench | `.wrench` |

Also included: bell, play, clock, terminal, square-terminal, monitor,
arrow-left, chevron-right, chevron-left, file-pen, paperclip, refresh-cw, copy,
trash-2, shield, keyboard, send, eye, brain, sparkles, loader-circle, plus,
minus, circle. Lucide's `more-horizontal` is now `ellipsis`.
