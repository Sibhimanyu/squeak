# Squeak — Design & Brand Guidelines

> Version 2 · 2026-10-19 · brand Edition 01 adopted (see §12).
>
> This is the single reference for how every Squeak surface looks, moves and
> speaks: Squeak for Mac (the native menu-bar app), the mobile app, and the
> Telegram cards. It was written from what existed then — the duck's artwork,
> the old Electron panel (`desktop/renderer/duck.css`, since deleted), the card rules in
> `CLAUDE.md` — so it codifies rather than reinvents. Where it changes
> something that ships today, §12 lists the change.
>
> It has two layers. The **brand** — logo, brand colours, brand type, voice,
> mascot — comes from the brand kit in [`brand/`](brand/README.md), whose
> guidelines are `brand/guidelines/squeak-brand-guidelines.pdf`. The
> **product** — state colours, surfaces, components, motion — is defined
> here alone. Where the two meet (the duck yellow, the app icon), the brand
> value wins.

---

## 1. The brand

### Name and idea

**Squeak** watches every coding agent on your Mac and tells you, at a glance,
which ones need you. Its mascot is a **rubber duck** — the programmer's oldest
debugging companion, the thing you explain your problem to. Here the duck
explains the agents' problems to *you*.

One line: **Squeak is a pager for your coding agents, with a duck.**

The tagline is **Your agents. In view.** — two sentences, both full stops.

- **Audience:** people who run coding agents on their own machines and want
  to step away without losing the thread.
- **Job:** show which agent needs you, give enough context to decide, and
  carry the reply back to the right session.
- **The name:** a rubber duck sits beside the work and says nothing until it
  matters. Then it squeaks: one short, friendly sound that tells you
  something needs you.

The brand's three principles are **Calm** (quiet by default; interrupt only
when a person is needed, and never twice for the same thing), **Precise** (say
exactly what happened, what is waiting and where a reply will go) and
**Warm** (the mascot carries the charm, the words carry the clarity).

### Personality

| Squeak is | Squeak is not |
| --- | --- |
| Calm. Silent until something needs you. | A dashboard that wants attention for its own sake. |
| Plain-spoken. Says what happened in a few words. | Chatty, cute in its copy, or full of exclamation marks. |
| Trustworthy. Never cries wolf; "done" means done. | Optimistic about state it cannot verify. |
| Warm, through the duck and only the duck. | Playful everywhere. The UI itself is an instrument. |

The division of labour is the core of the brand: **the duck carries the
emotion, the interface carries the facts.** The duck can hop, sleep and panic.
The list under it never does.

### Design principles

1. **Quiet until it matters.** Colour means state. Anything that is not
   telling you about state is neutral grey. If everything is fine, the screen
   should be nearly monochrome with one sleeping or bobbing duck.
2. **"Needs you" outranks everything.** A blocked agent is the reason Squeak
   exists. It gets the only red, the only badge, the only interruption.
3. **Two seconds to understand.** Every surface is designed for a glance: a
   lock-screen notification, a menu-bar peek, a phone pulled from a pocket.
   Which agent, what it did, what it needs — in that order, then stop.
4. **The agent's own words.** What an agent said it did is more useful than
   any label we invent. Show it, stripped of markdown, cut at a sentence.
5. **Every surface agrees.** The duck, the app, the phone and Telegram read
   the same state from the same place (`/state`, computed server-side). No
   surface decides anything on its own, so no two can disagree.
6. **Never claim what you cannot prove.** If a reply may or may not have been
   sent, say so. If a session is unpriced, show no price. An honest "unknown"
   beats a confident guess.

---

## 2. Surfaces

| Surface | Role | Density | Theme |
| --- | --- | --- | --- |
| **Squeak for Mac, menu bar** (native, ships today) | Ambient status. The duck mark in the menu bar; a glass panel on click. | Very low | System glass over any wallpaper |
| **Squeak for Mac, window** (native, ships today) | The home of Squeak: see all work, read the full message, reply and decide, Settings. | Medium | Follows system, dark first |
| **Squeak for iPhone / Android** (later) | Guide agents away from the desk: answer decisions, reply, review diffs. | Low per screen, deep by navigation | Follows system |
| **Telegram cards** (ships today) | Push notifications with one-tap answers. | Three lines | Telegram's own |

The Mac window is the full picture; the menu-bar duck is its ambient face; the phone
and Telegram are remote hands. They share one visual language so that
"working", "needs you" and "done" look the same everywhere.

---

## 3. Colour

### 3.1 Brand colours — the duck

From the brand kit (`brand/tokens/`), taken from the approved logo, so the
logo, the app icon and the UI are the same yellow. RGB first; the kit's CMYK
values are an uncalibrated conversion, not print-certified.

| Token | Brand name | Hex | Use |
| --- | --- | --- | --- |
| `duck` | Duck Yellow | `#FFDA1A` | The duck. Primary action fill on dark. Highlights in brand material. A fill, never text on a light ground. |
| `duck-wing` | — | `#FFC812` | The wing shade in the artwork. Pressed/hover state of a duck-filled control. |
| `beak` | Bill Orange | `#FF972E` | The bill, and rare warm accents in brand material. Never a UI colour (it would read as a warning), never text. |
| `duck-outline` | Ink | `#18191B` | The duck's contour lines; text/icons placed *on* duck yellow. |
| `duck-text` | — | `#8A5A00` | Yellow-family text or links on light backgrounds, where `duck` is unreadable. |

**Brand neutrals** are for brand material only — the guidelines, the site,
slides, social cards, documents. The product keeps the zinc neutrals of §3.2.

| Brand name | Hex | Use |
| --- | --- | --- |
| Ink | `#18191B` | Text, dark grounds, the logo's dark ground |
| Paper | `#F8F7F3` | The default warm ground for pages and documents |
| White | `#FFFFFF` | Cards on Paper |
| Slate | `#62656D` | Secondary text on light (5.44:1 on Paper) |
| Line | `#DCDDD8` | Dividers on light, decorative only |
| Dark Surface | `#242629` | Raised ground on dark |
| Dark Muted | `#ACAFB5` | Secondary text on dark (6.90:1 on Dark Surface) |

Balance in a brand composition: Paper and White 45%, Ink 30%, Duck Yellow
12%, Slate and Line 10%, Bill Orange 3%.

**Yellow and orange belong to the duck.** No state, warning or error may use
them: next to a yellow duck, a yellow "error" reads as brand decoration, not
as a problem.

**One exception: the duck's light** (owner's decision, 2026-10-20). The Mac's
Quick message pill has a soft warm glow spilling from under its bottom edge,
`duck` at the centre shading to `beak` at the sides, heavily blurred and gone
within ~120pt (about 40% strength at rest). It is brand light, never a state:
it brightens and breathes only while a message sends, is still under Reduce
Motion, and absent under Reduce Transparency.

### 3.2 Neutrals

Zinc, as today. Dark is the primary theme — the panel floats over arbitrary
wallpaper and the menu bar is dark on most setups — with a full light theme
for the apps.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `bg` | `#09090B` | `#F4F4F5` | Window / screen canvas |
| `surface` | `#18181B` | `#FFFFFF` | Panels, cards, list backgrounds |
| `surface-raised` | `#27272A` | `#FFFFFF` + border | Hovered row, popovers, sheets |
| `panel-glass` | `rgba(24,24,27,0.40)` over macOS glass | `rgba(255,255,255,0.45)` over macOS glass | The floating duck panel, over the system's own popover material |
| `panel-translucent` | `rgba(24,24,27,0.92)` | `rgba(255,255,255,0.88)` | The duck panel where there is no system glass (captures, fallback) |
| `line` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` | Dividers, borders |
| `ink` | `#F4F4F5` | `#18181B` | Primary text |
| `muted` | `#A1A1AA` | `#52525B` | Secondary text: meta lines, counts |
| `subtle` | `#71717A` | `#71717A` | Idle dots, disabled, placeholder |

Note that `muted` differs by theme: zinc-400 is only **2.56:1** on white and
fails as text, so light mode uses zinc-600.

### 3.3 State colours — the heart of the system

Every agent is in exactly one state, and each state has one colour, one
glyph, one word and one motion — the same on every surface. Colour is never
the only signal (see §10).

| State | Word | Dark | Light | Dot motion | Telegram glyph | Duck mood |
| --- | --- | --- | --- | --- | --- | --- |
| Needs you (approval or answer) | **needs you** | `#F87171` | `#DC2626` | fast pulse, 1.0s | 🔴 | `needs_you` — alarm wobble |
| Working | **working** | `#22C55E` | `#15803D` | slow pulse, 1.6s | 🟢 | `working` — quick bob |
| Done (finished, unreviewed) | **done** | `#38BDF8` | `#0369A1` | still | ✅ | `celebrating` — hop, 45s |
| Error | **error** | `#A78BFA` | `#7C3AED` | still | 🟣 | none (errors do not interrupt) |
| Idle / waiting | **idle** | `#71717A` | `#71717A` | still | ⚪ | `idle` / `asleep` |
| Offline (Squeak unreachable) | **offline** | `#52525B` | `#A1A1AA` | none | — | `offline` — greyed duck |

Why these:

- **Red is reserved for "needs you".** Both blocked states (approval and
  question) are the same thing from the user's point of view — an agent is
  stopped until you act — so they share one colour. The distinction lives in
  the word ("needs approval" / "needs an answer"), not the hue.
- **Error is violet**, because red is taken and yellow/orange belong to the
  duck. Errors are real but not urgent (they are not pushed), so they must not
  borrow the alarm colour.
- **Done is blue, not green.** Green already means "busy right now"; a
  finished agent is at rest, and blue reads as calm and informational.

Rules:

- A state colour appears on the **dot, badge or left edge** of the thing it
  describes — never as a large fill, never on body text.
- A screen with nothing blocked contains **no red at all**.
- Only one badge colour at a time on the duck: red count if anything needs
  you, otherwise blue count of finishes, otherwise none.

### 3.4 Measured contrast

All values are WCAG 2 contrast ratios, computed, not estimated. Text needs
4.5:1, large text and non-text indicators 3:1.

| Pair | Ratio | Passes |
| --- | --- | --- |
| `ink` on `surface` (dark) | 16.12 | AAA |
| `muted` on `surface` (dark) | 6.91 | AA |
| `muted` on `surface-raised` (dark) | 5.81 | AA |
| `subtle` on `surface` (dark) | 3.67 | non-text / large only |
| `ink` on `surface` (light) | 17.72 | AAA |
| `muted` on `surface` (light) | 7.73 | AAA |
| `muted` on `bg` (light) | 7.03 | AAA |
| `ink` (zinc-900) on `duck` | 12.90 | AAA — text on a duck-yellow button |
| `duck-outline` on `duck` | 12.81 | AAA |
| `duck` on `surface` (dark) | 12.90 | AAA |
| `duck` on white | **1.37** | **fails — never do this** |
| `duck-text` on white | 5.93 | AA |
| State dots, dark (needs / working / done / error / idle) | 6.40 / 7.78 / 8.27 / 6.51 / 3.67 | all ≥ 3:1 |
| State dots, light (needs / working / done / error / idle) | 4.83 / 5.02 / 5.93 / 5.70 / 4.83 | all ≥ 4.5:1, usable as text |

---

## 4. Typography

Two sets, one per layer. **Brand material** uses the brand typefaces, bundled
with their licences in `brand/fonts/`. **The product** uses system fonts:
Squeak sits beside the user's editor, terminal and Conductor, and a custom
typeface there would make it the odd one out.

### 4.1 Brand type

| Family | Role | Weights | Fallback |
| --- | --- | --- | --- |
| **Figtree** | Wordmark, headings, editorial display | 400–700 | Avenir Next, `system-ui` |
| **Inter** | Body copy | 400–700 | SF Pro Text, Helvetica Neue |
| **JetBrains Mono** | Labels, names and figures | 400, 500 | SF Mono, Menlo |

Roles are fixed: Figtree speaks, Inter explains, JetBrains Mono labels. All
three are SIL OFL 1.1.

| Style | Spec (size / line, tracking) | Sample |
| --- | --- | --- |
| Display | Figtree 700 · 96 / 100 · −2% | Your agents. |
| Headline | Figtree 700 · 56 / 60 · −1% | Calm, clear, useful |
| Title | Figtree 600 · 32 / 40 · 0% | Which agent needs you |
| Body | Inter 400 · 22 / 32 · 0% | Squeak gathers every question from your agents into one calm inbox. |
| Label | JetBrains Mono 500 · 16 / 20 · +8%, caps | EDITION 01 · OCTOBER 2026 |

Setting type:

- **Sentence case** for headlines and titles. Capitals only in the mono label
  style.
- **Tight display, open labels.** Track display sizes in, never out; mono
  labels open up to +8%.
- **Comfortable measure.** Body copy runs 45 to 75 characters a line, left
  aligned, never justified.
- **One weight step.** Contrast comes from size first; pair 700 headings with
  400 body, nothing between.
- **Mono means data** — labels, names and figures, never sentences.
- **The wordmark is not a text style.** "Squeak" in the logo is a fixed asset
  (Figtree Bold, −1% tracking). Do not restyle it or set headings in it; in
  running copy, write Squeak in sentence case.

### 4.2 Product type

| Role | Apple | Android / web fallback |
| --- | --- | --- |
| Interface | SF Pro (`-apple-system`) | Roboto, `system-ui` |
| Code, paths, branches, diffs | SF Mono (`ui-monospace`) | JetBrains Mono, `monospace` |

Scale:

| Token | Size / line | Weight | Use |
| --- | --- | --- | --- |
| `display` | 28 / 34 | 700 | Mobile screen titles only |
| `title` | 20 / 26 | 600 | Window and sheet titles |
| `heading` | 15 / 20 | 600 | Section headers, card headings |
| `body` | 13 / 19 | 400 | Default text (desktop); 16/22 on mobile |
| `label` | 13 / 18 | 550 | Session names, button labels |
| `meta` | 11 / 15 | 400 | Meta lines: agent · state · age · ctx |
| `code` | 12 / 18 | 400 mono | Paths, branches, diff lines |

Rules:

- **Numbers that change use tabular figures** (`font-variant-numeric:
  tabular-nums`): counts, diffstats, percentages, ages. A ticking count must
  not make the row shimmer.
- Session names are `repo · branch`, the branch in the same face (not mono) —
  it is a name here, not code. Paths and diffs are mono.
- Truncate from the **start** for paths (`…/renderer/duck.css`), from the
  **end** for prose. Never truncate a message that is the point of the screen;
  split it (Telegram's 4096-character cap included).
- Sentence case everywhere. No all-caps labels in the product (the mono
  label style of §4.1 is for brand material).
- Mobile respects Dynamic Type / font scale; layouts must survive 200%.

---

## 5. Space, shape and depth

### Spacing

A 4pt grid: `2, 4, 8, 12, 16, 24, 32, 48`. Rows breathe at 8–10pt vertical;
panels pad at 14–16pt. Density is desktop-first: a 13pt list with 9pt row
padding, as today.

### Radius

| Token | Value | Use |
| --- | --- | --- |
| `radius-panel` | 16 | Floating panel, sheets, desktop window content areas |
| `radius-card` | 12 | Cards, decision cards, grouped lists |
| `radius-control` | 8 | Buttons, inputs, segmented controls |
| `radius-chip` | 6 | Chips, small tags |
| `radius-round` | 999 | Dots, badges, avatar-like marks |

### Depth

Dark UIs show depth with **borders and blur**, not heavy shadows. One `line`
border on every surface; one shadow token, used only by things that float over
other apps:

- `shadow-float`: `0 18px 50px rgba(0,0,0,0.45)` — the duck panel, popovers.
- The duck itself: `drop-shadow(0 6px 10px rgba(0,0,0,0.35))`.

Nothing inside a window gets a shadow.

**Glass in the native apps** (owner's decision, 2026-10-19). On macOS 26 and
iOS 26 the reply composer, the decision card's option rows and the Send
button sit on Liquid Glass (`.glassEffect`, regular variant; Send is the
prominent glass button filled with `duck`, per §8.9). Sidebars, toolbars,
navigation bars and popovers use the system's own glass. On earlier systems
they fall back to the system's regular material; with Reduce Transparency on,
to the opaque `surface` / `surface-raised` tokens. Glass never carries state
colour and never sits behind the duck.

---

## 6. The duck and iconography

### 6.1 The logo

The logo is the **sleepy-eyed duck**: facing right, a Duck Yellow body with
an Ink contour, a single wing shade, a Bill Orange bill, a half-lidded eye
and a tiny eyebrow. The approved artwork is
`brand/logo/source/squeak-duck-approved-source.png`, kept unmodified; the
vectors in `brand/logo/svg/` are traced from it. It has one expression and is
never redrawn — crop the master instead.

| Variant | Size | What changes | File |
| --- | --- | --- | --- |
| Full | 48 px and up | Everything: eye, eyebrow, smile, wing contour | `squeak-duck-full-color` |
| Compact | 24 to 47 px | Wing simplified, catchlight removed | `squeak-duck-compact` |
| Silhouette | 16 to 23 px | Head and bill only — a mark, not the full logo | `squeak-duck-silhouette` |
| Mono | any | One flat colour: Ink on light, Paper on dark | `squeak-duck-mono-{ink,paper}` |

Minimum print sizes, as a starting point to proof: full 12 mm, compact 8 mm,
silhouette 5 mm. The symbol's width : height is 1.16056.

**Lockups.** Horizontal (headers, documents, toolbars): gap 0.18 × symbol
height, wordmark size 0.60 × symbol height, baseline 0.74 × symbol height
below the symbol's top. Stacked (square or narrow spaces): gap 0.14 × symbol
height, wordmark size 0.62 × symbol width, centred. Symbol only for avatars,
app icons and favicons where the name is nearby. Files:
`squeak-lockup-{horizontal,stacked}-{ink,paper}`; `ink` files go on light
grounds, `paper` files on dark.

**Clear space** is x = ¼ of the mark's total height on all four sides,
measured from the outermost contour. Keep text, edges and other graphics out.

**Grounds.** On Paper or White by default; on Ink for dark; mono Ink on Duck
Yellow. A monochrome mark needs at least 3:1 against its ground, and every
ground is flat — never a photo or pattern.

**Never:** stretch, rotate, recolour, lower the contrast (yellow on yellow),
crowd the clear space, or add effects (shadow, glow, outline). Never place a
PNG on a baked-in square.

**Applications.**

- *App icon:* the full duck, about 65% of the canvas width, centred on Ink,
  on a square 1024 px canvas with no baked mask. Platform masks (rounded
  square, Mac tile, circle) come from each platform's own template.
- *Avatar:* circle crop on Ink; compact variant below 48 px.
- *Social card* (1200 × 630) and *title slide* (16:9): the tagline in
  Figtree, the duck large on one side, the wordmark once.

### 6.2 Mascot and imagery

- One mascot moment per page, screen or layout. Flat brand colours on Paper,
  White, Ink or Dark Surface.
- No new emotions, props or costumes on the logo; no off-model redesigns or
  alternate poses. The in-app moods below are the one sanctioned set.
- Never use the duck as a pattern, bullet or decoration. One exception: the
  website hero's interactive duck pile (`website/ducks.js`), a heap of the
  unaltered logo duck you can push around. It stays inside the hero stage and
  appears nowhere else.
- Imagery is flat colour, the duck and plenty of space. Honest work over
  staged scenes; no stock photos of people at laptops.

### 6.3 The duck in the app

In the product the duck is a character with moods: the same rubber duck, a
round body, an outline (`duck-outline`), flat yellow with a single wing
shade, an orange beak, facing right. It is the only illustrated element in
Squeak.

| Mood | When (computed in `src/fleet/duck-mood.ts`) | Artwork | Motion |
| --- | --- | --- | --- |
| `asleep` | Nothing active at all | Eyes shut, drifting "z z" | Slow bob, 5.0s |
| `idle` | Sessions open, none doing anything | Neutral, eyes open | Gentle bob, 3.4s |
| `working` | At least one agent mid-turn | Focused brow | Quick bob, 1.1s |
| `celebrating` | Something finished in the last 45s | Happy, sparkles | Hop, 0.55s springy |
| `needs_you` | Something is blocked on you | Wide eyes, alert ring | Alarm wobble, 0.6s |
| `offline` | Squeak itself is unreachable | Greyed (`grayscale` + dim) | Still |

Rules:

- **One duck per screen.** It is a character, not a bullet point. Never use it
  as a list icon or repeat it in rows.
- The duck always faces **right**, toward the content it is reporting on.
- Mood priority is fixed: needs you > celebrating > working > idle > asleep.
- New moods need new artwork in the same style (outline weight, flat fills,
  single shade). Never recolour the duck to show state — state has its own
  colours (§3.3); the duck shows *mood*.
- The app icon is the logo (§6.1) on Ink. No text, no gradients.
- The menu-bar mark is the monochrome outline in
  `brand/logo/png/duckTemplate.png` (a template image, so macOS tints it),
  generated from the duck artwork by `brand/logo/make-tray-icon.py` — its
  silhouette with the eye, wing and beak lines cut out — so it is always the
  same duck. Never hand-draw it.

### 6.4 Icons

[Lucide](https://lucide.dev), 1.5px stroke, 16px in lists and 20px in
toolbars, `muted` colour by default — the same set Conductor uses, so the two
apps feel related. Icons accompany words; an icon alone is only acceptable for
universal actions (close, back, more) and must carry an accessible label.
The native Mac and iPhone apps use Lucide too, not SF Symbols (owner's
decision, 2026-10-19): the same SVGs, drawn as vector shapes at the same
1.5px stroke from the shared `icons/` package.

---

## 7. Motion

Motion tells you something changed. It is never decoration — except for the
duck, whose motion *is* its mood.

| Token | Duration | Easing | Use |
| --- | --- | --- | --- |
| `motion-quick` | 120ms | ease-out | Hover, press, toggles |
| `motion-standard` | 200ms | ease-out | Panel open/close, row insert/remove, sheet |
| `motion-emphasis` | 320ms | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` | A card arriving that needs you |
| Pulse (working) | 1.6s loop | ease-in-out | Working dot |
| Pulse (needs you) | 1.0s loop | ease-in-out | Needs-you dot |

Rules:

- Rows entering or leaving the list animate height and opacity together at
  `motion-standard`; a row changing state cross-fades its dot, it does not move.
- Panels open from the duck (scale from its corner), and must not make the
  duck jump — the window grows around a fixed duck (see `CLAUDE.md`).
- **Reduced motion:** pulses become static dots, the duck stops bobbing and
  switches sprite only, panels fade instead of scaling. All state must remain
  readable with zero motion.

---

## 8. Components

### 8.1 Status dot

9px circle, state colour, `margin-top` aligned to the first text line. Working
and needs-you pulse (opacity 1 → 0.35). Always paired with the state word in
the meta line, so it is never the only carrier of meaning.

### 8.2 Session row

The atom of every list: the duck panel, the app's main list, the phone's home.

```
●  Payment retry logic                 2m   ← the chat's title, one line, ellipsis; age
   storefront · claude                      ← repo · agent
   running tests                            ← what it is doing now (working), or the state word
```

- The headline is the chat's own title (owner's decision, 2026-10-19). A chat
  with no title (Conductor's "Untitled", a terminal session) falls back to
  `repo · branch`.
- The third line is the session's state in words (§9). While it works, it is
  instead the agent's newest step, shortened ("running tests", "editing 2
  files"), from the same activity feed as the detail; never invented.
- Three lines maximum. The git line (`+2017/−1824 · 39 files`) moves to the
  detail header. On the phone the title may wrap to a second line (a one-line
  cut lost the part that told chats apart), and an errored row adds the
  agent's own failure reason ("You've hit your session limit · resets 7:20pm")
  in muted footnote type, two lines at most, with the error colour on its left
  edge as well as its dot.
- **Every list is newest first by last activity; urgency lives in Needs you,
  not in sort order** (owner's rule, 2026-10-23). Home by project puts the
  project with the newest chat on top, and a project's chats are newest first
  (an older chat that needs you does not outrank a newer one; it is marked and
  waits in Needs you). Status groups keep their order (Needs you, Working,
  Done, Error, Idle) with rows newest first inside each; so do previews, View
  all, Earlier, search results (active before earlier), the Needs you page
  and the Telegram radar's sections. Ties are stable by title.
- A row is a button: it opens the session's detail (app) or offers its actions
  (phone). Hover: `surface-raised`.

- **The phone's Home is group cards** (owner's decision, 2026-10-21; evolved
  2026-10-22 from short group rows). A large title and, in an embedded layout
  with no tab bar, a segmented switch pick **Projects** (one card per
  repository) or **Status** (one card per state that has chats in it, in
  attention order: Needs you, Working, Done, Error, Idle), over the same
  snapshot, so nothing waits on the network. A card is one neutral surface
  (12pt, a hairline, no shadow, no state fill) and stays short:
  - A **project card**: a neutral Lucide folder tile, the name, and one line of
    counts that add up to the whole ("3 sessions · 1 needs
    you · 1 working", idle included); then its one or two newest chats; then
    **View all N sessions**, a real row with a chevron, not a caption. Its only
    needs-you mark is the left edge: no badge, because the line says it.
  - A **status card**: the state's word, a dot (not under Needs you, which has
    its left edge and badge) and a count, then its first chats. A group of six
    or fewer opens **in place** (the header and **Show all N / Show less** are
    disclosure buttons, the chevron turns, VoiceOver hears expanded or
    collapsed), so a tap never lands on a nearly empty page. A longer group, and
    Needs you, whose one-tap answers are the reason to go there, open their own
    list under a compact bar and the same tab.
  - A chat row: the agent's own app icon (Claude, Codex; a neutral tile for any
    other) with a Conductor badge when Conductor holds it, title and age
    (VoiceOver: "last active 12 minutes ago"), the state in words with `agent`
    (`repo · agent` under Status), and, for a chat that needs you, failed, or
    (under Status) finished, the agent's own words. An approval that only the
    Mac can give says so; no button promises it. Each row is its own tap target.
  - One duck, in the header; never in a card. **Earlier** is a quiet card at the
    foot. Searching skips the cards and lists every match. The last card scrolls
    clear of the floating tab bar. Swipe actions live in the lists, not on Home.
- **Each project wears Conductor's own icon** (2026-10-23). The Mac reads the
  icon Conductor shows for each repository (`repos.icon`), shrinks it to 96 px
  and sends it with the recent chats; the phone puts it on the project's card
  and before a chat's title wherever the project is not already the heading.
  A project with none keeps the neutral folder tile on its card and nothing on
  a row: the phone never invents a mark. The icons are the person's own, so a
  duck among them is theirs; the mascot rule is about the app's own artwork.
- **Motion means working.** A chat that is working has a small green dot that
  pulses before its state words, and the Working card's header too: the render
  server draws it, Reduce Motion stills it, and a Mac that has stopped
  answering gets a still grey one, because then "working" is only the last
  thing it said. Nothing else on Home moves.
- **A chat can be renamed** from its header, or by pressing and holding its row
  (Rename). It is a signed command: the Mac sets the chat's title in Conductor's
  own database, so it is renamed there too, and the new name shows with the
  Mac's next view. Only a chat Conductor holds open can be renamed.
- **Between two messages, the work is counted**: "Worked · 5 steps" stands
  where the agent worked, from the number of tool calls the Mac counts between
  messages. Never what they were: a command never leaves the Mac this way.
- **Earlier is a page with controls** (2026-10-23). The chats that went quiet,
  newest first, each tagged **Open** or **Closed** (whether its tab is open in
  Conductor; the Mac says so per chat, and an older Mac sends nothing, so the
  tags and the switch are simply absent). A segmented switch picks **All** or
  **Open in Conductor** (each with its count); chips narrow by **Project**,
  **Agent** and **Outcome** (done, error, idle) and order by **Newest first** or
  **By project** (sections). A line says how many of the loaded chats show
  ("3 of 6 chats") with **Clear filters**; searching works beside them, and
  **Show more** loads older chats from the Mac, which the filters then apply to.
  Every chat whose tab is open is always on the list, however quiet. A chat
  closed in Conductor can be read but not answered from the phone: a reply
  would run in the background where Conductor shows nothing.
- **New chat is one sheet of cards** (2026-10-23): **Where** (the workspace, with its project's icon),
  **Agent** (Claude or Codex, as their own icons), **Model** (Conductor's own model picker, as the Mac
  lists it: its favourites first, "More models" for the rest), **Thinking** (the levels the chosen
  model takes, from Low up to Max; a model with none, like Haiku 4.5, shows no row) and **First message**.
  A line over Start chat says what will start ("Opus 5.5 · 1M · medium thinking · storefront"), so
  the choice is on screen before it is made. The Mac checks the model and level against Conductor's
  list again, and starts the chat through Conductor's own `sessions/register` so the chat is created
  with them. An older Mac sends no list, and the sheet then offers no model or thinking choice.
- **A photo can go with a message** (2026-10-23), in a chat's composer and in New chat's first message:
  a paperclip opens the system photo picker (up to four, nothing asked of the person), small pictures
  wait in a tray with an x on each, and Send uploads them first ("Sending photo 1 of 2…") and then the
  message. Conductor's relay refuses attachments, so the phone does what Conductor does itself: the Mac
  saves each photo (shrunk to 1600 px on the phone, JPEG or PNG only, checked by its bytes) under the
  chat's or workspace's own `.context/attachments/<id>/` and the message names the path on a
  `[Image: …]` line the agent reads. In the chat those lines are a "Photo" or "2 photos" pill, never
  text. Where a photo is written is the Mac's own record of the folder, never anything the phone says.
- **A chat screen hides the tab bar.** It opens at the newest message and follows what arrives only while
  you are at the bottom; read further up and it lets go, with a "New" pill to come back.
- **A chat screen hides the tab bar.** Its composer sits at the bottom, and the
  bar floats over it. And it never goes blank while the Mac moves a chat
  between the active and recent lists (the two reach the phone separately): the
  phone keeps its last view of the chat for 90 s.
- **The phone's own bottom bar** (standalone app only): **Home** (the cards by
  project), **Sessions** (the same cards by status) and, as before, **Needs you**
  (the decision cards; the one red badge, counting only chats blocked on you)
  and **Settings**. In the bar the Projects/Status switch is gone: the two tabs
  are the two groupings. Icons are Lucide. A host app that embeds
  `SqueakRootView` gets the default `.embedded` layout with no bar of its own,
  so bars never nest, and keeps the switch; the app opts in with
  `navigation: .tabs`. A link to a chat opens it from Home, whichever tab is in
  front.

### 8.3 Badge

Red pill with a white count for things that need you; blue for unreviewed
finishes; otherwise absent. 20px tall, `radius-round`, 11pt bold, tabular.

### 8.4 Decision card

For an agent that ended its turn on a lettered choice — the flagship
interaction on the phone and in Telegram.

```
┌─────────────────────────────────────────┐
│ ● farm-dashboard · light-control        │  heading + state dot
│   needs a decision                      │  meta
│                                         │
│ Arm device control on the farm?         │  the question, heading
│                                         │
│ ┌───┐ Arm it now            recommended │  option: letter chip + title
│ │ A │                                   │
│ └───┘                                   │
│ ┌───┐ Arm it later, near the hardware   │
│ │ B │                                   │
│ └───┘                                   │
│ ┌───┐ Leave it off                      │
│ │ C │                                   │
│ └───┘                                   │
│                                         │
│ Read full message   ·   Reply…          │  secondary actions
└─────────────────────────────────────────┘
```

- Options are full-width tappable rows (≥ 44pt tall on mobile), letter in a
  `radius-chip` square, title in `label`.
- The recommended option is marked with the word **recommended** in `muted`
  (Telegram: `★` on the letter button). It is *not* pre-selected or coloured —
  the choice stays the user's.
- After a tap the card collapses to a receipt: `✓ Sent B in Conductor` (or
  `in the background`, with the reason). A receipt is not tappable again.
- Options that could cause irreversible effects are not special-cased
  visually; the agent's own wording carries that. Squeak never adds urgency.

### 8.5 Reply composer

A single text field with the target named in its placeholder: *"Message for
orchard · irrigation"*. Send is the only primary button. The composer stays;
each sent message carries one delivery line (sent / queued / steered / not
sent), which becomes **Read by Claude** once the agent has it: its turn
started from it, the turn shows the steer, or it left Conductor's queue.
"Sent" only ever means the Mac has it. It never sends to a session the user did not explicitly pick.

While the agent works and nothing is typed, the button is **Stop** (a
needs-you-red square on `surface-raised`, Conductor's own Stop; the working
row says "Stopping…" until it has). Once you type, it is Send again.

While the agent works, Send becomes **Queue** and is still the only control:
a tap queues, and holding it (on the Mac, its chevron or ⇧⌘↩) offers
**Steer now**. No picker or second button: steering is the rarer, deliberate
act, so it is never sticky and every message starts queued. The explanation
is one line, shown until the first message sent mid-turn.

**Queued messages are not in the chat** (owner's decision, 2026-10-19,
after Cursor's and Codex's queues). They stack as cards above the composer,
oldest first, under one muted line ("Queued · Claude reads them after this
turn"): the text in two lines, **Steer now** (secondary), and a ⋯ menu with
Edit and Delete. Edit takes the text back into the field. A card moves into
the chat as your message only when the agent picks it up. The cards are
Conductor's own queue, so one typed on the Mac shows too; a card the Mac has
not listed yet says "Queuing…" and has no actions.

**A steer lands inside the turn.** The steps before it fold to one quiet line
("Worked · 6 steps", a tap opens them), your message sits under it with
"Steered into the current turn", and the turn carries on below it ("Reading
your message…" until the agent's next step). A finished turn's steps fold the
same way above its answer.

A working chat has no Activity tab: the "Claude · Running tests…" row is
folded by default, with a small live box under it (`surface-raised`,
`radius-card`, `line` border) showing the newest three steps one line each,
the newest in `ink`; it follows the turn without moving the chat. A tap
opens every step, one line each, a tap on a step opens its whole text.
"Show thinking live" (on by default) streams the whole turn of the chat
on screen.

The session header is two lines (in the iPhone's navigation bar): the title,
then state, age and as much of repo, agent and diff as fits. The transcript
gets the room.

An image the agent put in its answer (`![alt](path)` on its own line) is a
`surface-raised` card with its description and "Image · tap to show": the
file is on the Mac, and nothing leaves it until you tap. Loaded, it shows
inline (at most 360pt tall, `radius-card`, `line` border); a tap opens it
full screen on black, pinch to zoom, with Share.

### 8.6 Push card (Telegram and mobile notifications)

Three short lines at most, as specified in `CLAUDE.md`:

1. `🔴 repo · branch — needs approval` (glyph, name, what it needs)
2. What the agent said, markdown stripped, cut at a sentence boundary.
3. Only on a finish: what changed on disk, in italics, no commit counts.

Buttons are per-session actions only (letters, Reply, Full message, View
Diff). Nothing on a card duplicates a command.

### 8.7 Empty, offline and error states

| State | Duck | Copy |
| --- | --- | --- |
| Nothing running | `asleep` | "Nothing's running. The duck is resting." |
| Everything idle | `idle` | "All quiet. 4 sessions open, none working." |
| Squeak unreachable | `offline` | "Can't reach Squeak on this Mac. Is it running?" + **Start Squeak** button |
| Mobile, Mac offline | `offline` | "Your Mac is offline. You'll see updates when it's back." |

An empty state always says what is true and, if there is one, the single
action that changes it. No "Oops".

### 8.8 Diff viewer

Mono `code` style. Added lines on a 12% tint of working-green, removed on a
12% tint of needs-you-red — the only place red appears without meaning "needs
you", and deliberately tinted, never saturated. File list first, one file's
patch second (as Telegram does today). Paths truncate from the start.

### 8.9 Buttons

| Kind | Dark | Light | Use |
| --- | --- | --- | --- |
| Primary | `duck` fill, `#18181B` text | `#18181B` fill, white text | One per screen: Send, Start Squeak |
| Secondary | `surface-raised` fill, `ink` text, `line` border | white fill, `ink` text, `line` border | Everything else |
| Quiet | text only, `muted` | text only, `muted` | Tertiary: Read full message |
| Destructive | `surface-raised` fill, needs-you-red text | white fill, red text | Stop an agent, disconnect a device |

The duck-yellow primary is the brand's single loud control. On light
backgrounds the primary is ink-black instead, because yellow fails on white
(§3.4).

---

## 9. Voice and copy

### Vocabulary

Use these words, consistently, everywhere:

| Say | Means | Don't say |
| --- | --- | --- |
| **agent** | Claude, Codex or another model doing work | bot, AI, assistant |
| **session** | One agent conversation, wherever it runs | thread, job, task |
| **chat** | A session that lives in Conductor | conversation |
| **needs you** | Blocked on approval or an answer | action required, attention needed |
| **working** | Mid-turn right now | running, processing, busy |
| **done** | Finished a turn, not yet looked at | completed, succeeded |
| **idle** | Open, doing nothing | inactive, paused |

### Rules

- **Lead with the fact.** "orchard · irrigation needs approval" — not "Heads up!
  An agent is waiting for you."
- **Say it once, short.** Three lines on a card. One sentence in an empty
  state. Buttons are verbs: *Reply*, *View diff*, *Start Squeak*.
- **Quote the agent, don't paraphrase it.** Strip markdown; keep its words.
  Drop filler openers ("Done!", "Sure,", "Here's what I did").
- **Numbers over adjectives.** "39 files changed", "idle 16h", "ctx 62%".
- **Honest about uncertainty.** "I typed it into Conductor but couldn't
  confirm it was sent." Never "Something went wrong."
- **No exclamation marks, no emoji in prose.** Emoji are state glyphs in
  Telegram (§3.3) and nothing else.
- **The duck doesn't talk.** Copy is Squeak's voice, first person only where a
  sentence needs a subject ("I'll message you when it answers"). The duck is
  never quoted and has no catchphrases.

### Examples

| Situation | Yes | No |
| --- | --- | --- |
| Blocked | `🔴 orchard · irrigation — needs approval` | `⚠️ ACTION REQUIRED: Agent awaiting permission!` |
| Finished | `✅ squeak · session-hub — done` / `Fixed the stale finish detection.` / `_3 files changed_` | `🎉 Great news! Your agent completed its task successfully!` |
| Reply sent | `Sent B to orchard · irrigation in Conductor.` | `Your response has been submitted.` |
| Failure | `The reply did not go through: claude exited (1).` | `Oops, something went wrong. Please try again.` |

### Brand copy

Outside the product — the site, the App Store, announcements, bios — the same
voice holds: calm, clear, lightly witty, useful. Charm lives in the mascot;
the words stay plain. Say what Squeak does for the reader, in their words.
One duck joke at most, and never in a headline. Platforms keep their own
capitalisation: Mac, iPhone, Telegram, Cliq.

| Kind | Yes | No |
| --- | --- | --- |
| Tagline | Your agents. In view. | The ultimate AI agent command center! |
| Description | An attention inbox for the coding agents you already use. | Revolutionary AI-powered productivity for developers. |
| Announcement | Squeak tells you which coding agent needs you, and carries your answer back. On Mac, iPhone and Telegram. | Squeak is here to supercharge your workflow!! |
| Bio | Squeak. A pager for your coding agents. | Quack quack! The quackiest way to herd your AI agents. |

---

## 10. Accessibility

- **Contrast:** every text/background pair in §3.4 meets WCAG AA; keep it that
  way when adding colours, and measure, don't eyeball.
- **Never colour alone.** Each state has a word, and a distinct motion. With
  red/green colour blindness, "needs you" and "working" differ by word and by
  pulse speed (1.0s vs 1.6s), and needs you also raises the badge.
- **Targets:** 44×44pt minimum on mobile; 24×24px minimum on desktop.
- **Reduced motion** is fully supported (§7).
- **Screen readers:** every row reads as "orchard, irrigation-pull-to-refresh,
  Claude, working, 2 minutes ago". The duck is decorative (`aria-hidden`); its
  mood is announced as text ("3 agents working, 1 needs you").
- **Dynamic type** on mobile up to 200% without truncating the state word.
- **Keyboard:** the desktop app is fully usable without a mouse; the duck's
  two global shortcuts (peek, show/hide) stay separate (see `CLAUDE.md`).

---

## 11. Design tokens

Canonical values, for every surface to import instead of copying. The
desktop app and the Electron duck consume the CSS; the mobile app consumes the
JSON. Brand-material tokens (Paper, Slate, the brand type scale, logo
geometry) are separate, in `brand/tokens/squeak-brand.{css,json,ase}`.

```css
:root {
  /* brand */
  --sq-duck: #ffda1a;
  --sq-duck-wing: #ffc812;
  --sq-beak: #ff972e;
  --sq-duck-outline: #18191b;
  --sq-duck-text: #8a5a00;

  /* neutrals — dark (default) */
  --sq-bg: #09090b;
  --sq-sidebar: #0e0e11;
  --sq-surface: #18181b;
  --sq-surface-raised: #27272a;
  --sq-panel-translucent: rgba(24, 24, 27, 0.92);
  --sq-panel-glass: rgba(24, 24, 27, 0.4);
  --sq-line: rgba(255, 255, 255, 0.08);
  --sq-line-strong: rgba(255, 255, 255, 0.14);
  --sq-ink: #f4f4f5;
  --sq-muted: #a1a1aa;
  --sq-subtle: #71717a;

  /* state — dark */
  --sq-needs-you: #f87171;
  --sq-working: #22c55e;
  --sq-done: #38bdf8;
  --sq-error: #a78bfa;
  --sq-idle: #71717a;
  --sq-offline: #52525b;

  /* type */
  --sq-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  --sq-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;

  /* shape */
  --sq-radius-panel: 16px;
  --sq-radius-card: 12px;
  --sq-radius-control: 8px;
  --sq-radius-chip: 6px;
  --sq-shadow-float: 0 18px 50px rgba(0, 0, 0, 0.45);
  --sq-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.22);

  /* motion */
  --sq-motion-quick: 120ms ease-out;
  --sq-motion-standard: 200ms ease-out;
  --sq-motion-emphasis: 320ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

@media (prefers-color-scheme: light) {
  :root {
    --sq-bg: #f4f4f5;
    --sq-sidebar: #ebebec;
    --sq-surface: #ffffff;
    --sq-surface-raised: #ffffff;
    --sq-panel-translucent: rgba(255, 255, 255, 0.88);
    --sq-panel-glass: rgba(255, 255, 255, 0.45);
    --sq-line: rgba(0, 0, 0, 0.08);
    --sq-line-strong: rgba(0, 0, 0, 0.16);
    --sq-ink: #18181b;
    --sq-muted: #52525b;
    --sq-subtle: #71717a;
    --sq-needs-you: #dc2626;
    --sq-working: #15803d;
    --sq-done: #0369a1;
    --sq-error: #7c3aed;
    --sq-offline: #a1a1aa;
  }
}
```

```json
{
  "brand": { "duck": "#FFDA1A", "duckWing": "#FFC812", "beak": "#FF972E", "duckOutline": "#18191B", "duckText": "#8A5A00" },
  "dark": {
    "bg": "#09090B", "surface": "#18181B", "surfaceRaised": "#27272A", "line": "rgba(255,255,255,0.08)",
    "ink": "#F4F4F5", "muted": "#A1A1AA", "subtle": "#71717A",
    "needsYou": "#F87171", "working": "#22C55E", "done": "#38BDF8", "error": "#A78BFA", "idle": "#71717A", "offline": "#52525B"
  },
  "light": {
    "bg": "#F4F4F5", "surface": "#FFFFFF", "surfaceRaised": "#FFFFFF", "line": "rgba(0,0,0,0.08)",
    "ink": "#18181B", "muted": "#52525B", "subtle": "#71717A",
    "needsYou": "#DC2626", "working": "#15803D", "done": "#0369A1", "error": "#7C3AED", "idle": "#71717A", "offline": "#A1A1AA"
  },
  "radius": { "panel": 16, "card": 12, "control": 8, "chip": 6 },
  "space": [2, 4, 8, 12, 16, 24, 32, 48],
  "type": {
    "display": [28, 34, 700], "title": [20, 26, 600], "heading": [15, 20, 600],
    "body": [13, 19, 400], "bodyMobile": [16, 22, 400], "label": [13, 18, 550], "meta": [11, 15, 400], "code": [12, 18, 400]
  },
  "motion": { "quick": 120, "standard": 200, "emphasis": 320, "pulseWorking": 1600, "pulseNeedsYou": 1000 }
}
```

---

## 12. Changes from what ships today

This guide deliberately changed a few things in the duck and cards. All of
them are applied (step 3): the duck's panel reads `tokens.css`, and the
Telegram glyphs follow §3.3.

| Where | Today | This guide | Why |
| --- | --- | --- | --- |
| `duck.css` `--duck` | `#ffd23f` | `#FCD02C` | Match the sprite's actual yellow |
| `duck.css` `--beak` | `#f97316` | `#FC8830` | Match the sprite |
| Error dot | `#f59e0b` amber | violet `#A78BFA` | Amber is duck-family; errors must not read as brand |
| Needs-you dot | `#ef4444` | `#F87171` (dark) | Higher contrast on the dark panel (6.40 vs 4.71) |
| Telegram "needs an answer" | 🟡 | 🔴 | Both blocked states are "needs you"; yellow is the duck's |
| Telegram error | ❗ | 🟣 | Matches the violet error colour |
| Panel text colours | hard-coded in `duck.css` | `--sq-*` tokens | One source for every surface |

**Brand Edition 01 (version 2).** Adopting the brand kit changes these. They
are written into §3.1 and §11 but **not yet applied in code**:

| Where | Today | Now | Why |
| --- | --- | --- | --- |
| `--sq-duck` (the old Electron `tokens.css`, `Theme.swift` in `ios/` and `macos/`, `macos/scripts/dmg-background.swift`) | `#FCD02C` | `#FFDA1A` | The approved logo's yellow |
| `--sq-duck-wing` | `#FCC010` | `#FFC812` | The logo's wing shade |
| `--sq-beak` | `#FC8830` | `#FF972E` | Bill Orange |
| `--sq-duck-outline` | `#3C1804` brown | `#18191B` Ink | The logo's contour is Ink |
| Mood sprites (`brand/mood-sprites/duck-*.png`, the iPhone's `Media.xcassets`) | The older round-eyed duck, brown outline | Redraw from the approved duck, in Ink | One duck everywhere; the sleepy eye is the logo's own expression |
| Menu-bar mark | Generated from the old sprite | Regenerate from the new artwork | `make-tray-icon.py` follows the sprite |

---

## 13. Roadmap — where this guide is heading

Step by step, each step shippable on its own:

1. **Brand & design guidelines** — this document. ✅
2. **Squeak for Mac.** ✅ A native SwiftUI `.app` (`macos/`, `/Applications`) with a
   menu-bar presence, a main window (every session grouped by state, the agent's
   last message, reply and decisions), a quick composer and Settings. It began as
   an Electron app on the same `/state`; the native app replaced it and the
   Electron one is retired.
3. **Tokens as code.** ✅ Extract §11 into a shared package consumed by the Mac
   app; apply the §12 changes.
4. **Remote channel.** ✅ Built on Firebase — see `docs/remote-channel.md`. A way for a phone to see state and send replies
   without the Mac being reachable directly. Firebase (Firestore + FCM push +
   Auth) is the default candidate; the key design constraint is that this
   channel can make agents on your Mac *do things*, so it needs real
   authentication, device pairing, and an allow-list of actions — decided in
   that step, before any code.
5. **Squeak for iPhone** ✅ (Android later). Home = the attention-ordered list;
   decision cards; reply composer; diff review; push notifications that match
   the Telegram cards. Same tokens, system type, 44pt targets.
6. **Telegram becomes one channel among several**, fed by the same state and
   the same card rules.
