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
explains the agents' problems to _you_.

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

| Squeak is                                         | Squeak is not                                           |
| ------------------------------------------------- | ------------------------------------------------------- |
| Calm. Silent until something needs you.           | A dashboard that wants attention for its own sake.      |
| Plain-spoken. Says what happened in a few words.  | Chatty, cute in its copy, or full of exclamation marks. |
| Trustworthy. Never cries wolf; "done" means done. | Optimistic about state it cannot verify.                |
| Warm, through the duck and only the duck.         | Playful everywhere. The UI itself is an instrument.     |

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

| Surface                                            | Role                                                                                 | Density                            | Theme                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------- |
| **Squeak for Mac, menu bar** (native, ships today) | Ambient status. The duck mark in the menu bar; a glass panel on click.               | Very low                           | System glass over any wallpaper |
| **Squeak for Mac, window** (native, ships today)   | The home of Squeak: see all work, read the full message, reply and decide, Settings. | Medium                             | Follows system, dark first      |
| **Squeak for iPhone / Android** (later)            | Guide agents away from the desk: answer decisions, reply, review diffs.              | Low per screen, deep by navigation | Follows system                  |
| **Telegram cards** (ships today)                   | Push notifications with one-tap answers.                                             | Three lines                        | Telegram's own                  |

The Mac window is the full picture; the menu-bar duck is its ambient face; the phone
and Telegram are remote hands. They share one visual language so that
"working", "needs you" and "done" look the same everywhere.

---

## 3. Colour

### 3.1 Brand colours — the duck

From the brand kit (`brand/tokens/`), taken from the approved logo, so the
logo, the app icon and the UI are the same yellow. RGB first; the kit's CMYK
values are an uncalibrated conversion, not print-certified.

| Token          | Brand name  | Hex       | Use                                                                                                            |
| -------------- | ----------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `duck`         | Duck Yellow | `#FFDA1A` | The duck. Primary action fill on dark. Highlights in brand material. A fill, never text on a light ground.     |
| `duck-wing`    | —           | `#FFC812` | The wing shade in the artwork. Pressed/hover state of a duck-filled control.                                   |
| `beak`         | Bill Orange | `#FF972E` | The bill, and rare warm accents in brand material. Never a UI colour (it would read as a warning), never text. |
| `duck-outline` | Ink         | `#18191B` | The duck's contour lines; text/icons placed _on_ duck yellow.                                                  |
| `duck-text`    | —           | `#8A5A00` | Yellow-family text or links on light backgrounds, where `duck` is unreadable.                                  |

**Brand neutrals** are for brand material only — the guidelines, the site,
slides, social cards, documents. The product keeps the zinc neutrals of §3.2.

| Brand name   | Hex       | Use                                             |
| ------------ | --------- | ----------------------------------------------- |
| Ink          | `#18191B` | Text, dark grounds, the logo's dark ground      |
| Paper        | `#F8F7F3` | The default warm ground for pages and documents |
| White        | `#FFFFFF` | Cards on Paper                                  |
| Slate        | `#62656D` | Secondary text on light (5.44:1 on Paper)       |
| Line         | `#DCDDD8` | Dividers on light, decorative only              |
| Dark Surface | `#242629` | Raised ground on dark                           |
| Dark Muted   | `#ACAFB5` | Secondary text on dark (6.90:1 on Dark Surface) |

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

| Token               | Dark                                   | Light                                     | Use                                                                |
| ------------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `bg`                | `#09090B`                              | `#F4F4F5`                                 | Window / screen canvas                                             |
| `surface`           | `#18181B`                              | `#FFFFFF`                                 | Panels, cards, list backgrounds                                    |
| `surface-raised`    | `#27272A`                              | `#FFFFFF` + border                        | Hovered row, popovers, sheets                                      |
| `panel-glass`       | `rgba(24,24,27,0.40)` over macOS glass | `rgba(255,255,255,0.45)` over macOS glass | The floating duck panel, over the system's own popover material    |
| `panel-translucent` | `rgba(24,24,27,0.92)`                  | `rgba(255,255,255,0.88)`                  | The duck panel where there is no system glass (captures, fallback) |
| `line`              | `rgba(255,255,255,0.08)`               | `rgba(0,0,0,0.08)`                        | Dividers, borders                                                  |
| `ink`               | `#F4F4F5`                              | `#18181B`                                 | Primary text                                                       |
| `muted`             | `#A1A1AA`                              | `#52525B`                                 | Secondary text: meta lines, counts                                 |
| `subtle`            | `#71717A`                              | `#71717A`                                 | Idle dots, disabled, placeholder                                   |

**Mac dark neutrals** (owner's decision, 2026-10-27): Squeak for Mac's dark neutrals follow Conductor's warm greys instead of the zinc values above (the iPhone app keeps the table): `bg` `#1A1514`, `sidebar` and `surface` `#24211E`, `surface-raised` `#2B2825`, `selected` (selected row, hover, selected tab) `#34312F`, strongest fill `#3A3735`; the menu-bar panel's base is `rgba(36,33,30,…)`. Light is unchanged.

Note that `muted` differs by theme: zinc-400 is only **2.56:1** on white and
fails as text, so light mode uses zinc-600.

### 3.3 State colours — the heart of the system

Every agent is in exactly one state, and each state has one colour, one
glyph, one word and one motion — the same on every surface. Colour is never
the only signal (see §10).

| State                          | Word          | Dark      | Light     | Dot motion       | Telegram glyph | Duck mood                      |
| ------------------------------ | ------------- | --------- | --------- | ---------------- | -------------- | ------------------------------ |
| Needs you (approval or answer) | **needs you** | `#F87171` | `#DC2626` | fast pulse, 1.0s | 🔴             | `needs_you` — alarm wobble     |
| Working                        | **working**   | `#22C55E` | `#15803D` | slow pulse, 1.6s | 🟢             | `working` — quick bob          |
| Done (finished, unreviewed)    | **done**      | `#38BDF8` | `#0369A1` | still            | ✅             | `celebrating` — hop, 45s       |
| Error                          | **error**     | `#A78BFA` | `#7C3AED` | still            | 🟣             | none (errors do not interrupt) |
| Idle / waiting                 | **idle**      | `#71717A` | `#71717A` | still            | ⚪             | `idle` / `asleep`              |
| Offline (Squeak unreachable)   | **offline**   | `#52525B` | `#A1A1AA` | none             | —              | `offline` — greyed duck        |

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

| Pair                                                      | Ratio                            | Passes                             |
| --------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `ink` on `surface` (dark)                                 | 16.12                            | AAA                                |
| `muted` on `surface` (dark)                               | 6.91                             | AA                                 |
| `muted` on `surface-raised` (dark)                        | 5.81                             | AA                                 |
| `subtle` on `surface` (dark)                              | 3.67                             | non-text / large only              |
| `ink` on `surface` (light)                                | 17.72                            | AAA                                |
| `muted` on `surface` (light)                              | 7.73                             | AAA                                |
| `muted` on `bg` (light)                                   | 7.03                             | AAA                                |
| `ink` (zinc-900) on `duck`                                | 12.90                            | AAA — text on a duck-yellow button |
| `duck-outline` on `duck`                                  | 12.81                            | AAA                                |
| `duck` on `surface` (dark)                                | 12.90                            | AAA                                |
| `duck` on white                                           | **1.37**                         | **fails — never do this**          |
| `duck-text` on white                                      | 5.93                             | AA                                 |
| State dots, dark (needs / working / done / error / idle)  | 6.40 / 7.78 / 8.27 / 6.51 / 3.67 | all ≥ 3:1                          |
| State dots, light (needs / working / done / error / idle) | 4.83 / 5.02 / 5.93 / 5.70 / 4.83 | all ≥ 4.5:1, usable as text        |

---

## 4. Typography

Two sets, one per layer. **Brand material** uses the brand typefaces, bundled
with their licences in `brand/fonts/`. **The product** uses system fonts:
Squeak sits beside the user's editor, terminal and Conductor, and a custom
typeface there would make it the odd one out.

### 4.1 Brand type

| Family             | Role                                  | Weights  | Fallback                    |
| ------------------ | ------------------------------------- | -------- | --------------------------- |
| **Figtree**        | Wordmark, headings, editorial display | 400–700  | Avenir Next, `system-ui`    |
| **Inter**          | Body copy                             | 400–700  | SF Pro Text, Helvetica Neue |
| **JetBrains Mono** | Labels, names and figures             | 400, 500 | SF Mono, Menlo              |

Roles are fixed: Figtree speaks, Inter explains, JetBrains Mono labels. All
three are SIL OFL 1.1.

| Style    | Spec (size / line, tracking)             | Sample                                                              |
| -------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Display  | Figtree 700 · 96 / 100 · −2%             | Your agents.                                                        |
| Headline | Figtree 700 · 56 / 60 · −1%              | Calm, clear, useful                                                 |
| Title    | Figtree 600 · 32 / 40 · 0%               | Which agent needs you                                               |
| Body     | Inter 400 · 22 / 32 · 0%                 | Squeak gathers every question from your agents into one calm inbox. |
| Label    | JetBrains Mono 500 · 16 / 20 · +8%, caps | EDITION 01 · OCTOBER 2026                                           |

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

| Role                         | Apple                    | Android / web fallback      |
| ---------------------------- | ------------------------ | --------------------------- |
| Interface                    | SF Pro (`-apple-system`) | Roboto, `system-ui`         |
| Code, paths, branches, diffs | SF Mono (`ui-monospace`) | JetBrains Mono, `monospace` |

Scale:

| Token     | Size / line | Weight   | Use                                      |
| --------- | ----------- | -------- | ---------------------------------------- |
| `display` | 28 / 34     | 700      | Mobile screen titles only                |
| `title`   | 20 / 26     | 600      | Window and sheet titles                  |
| `heading` | 15 / 20     | 600      | Section headers, card headings           |
| `body`    | 13 / 19     | 400      | Default text (desktop); 16/22 on mobile  |
| `reading` | 14 / 22     | 400      | Agent text in the Mac transcript (§8.10) |
| `label`   | 13 / 18     | 550      | Session names, button labels             |
| `meta`    | 11 / 15     | 400      | Meta lines: agent · state · age · ctx    |
| `code`    | 12 / 18     | 400 mono | Paths, branches, diff lines              |

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

| Token            | Value | Use                                                  |
| ---------------- | ----- | ---------------------------------------------------- |
| `radius-panel`   | 16    | Floating panel, sheets, desktop window content areas |
| `radius-card`    | 12    | Cards, decision cards, grouped lists                 |
| `radius-control` | 8     | Buttons, inputs, segmented controls                  |
| `radius-chip`    | 6     | Chips, small tags                                    |
| `radius-round`   | 999   | Dots, badges, avatar-like marks                      |

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

| Variant    | Size         | What changes                                   | File                           |
| ---------- | ------------ | ---------------------------------------------- | ------------------------------ |
| Full       | 48 px and up | Everything: eye, eyebrow, smile, wing contour  | `squeak-duck-full-color`       |
| Compact    | 24 to 47 px  | Wing simplified, catchlight removed            | `squeak-duck-compact`          |
| Silhouette | 16 to 23 px  | Head and bill only — a mark, not the full logo | `squeak-duck-silhouette`       |
| Mono       | any          | One flat colour: Ink on light, Paper on dark   | `squeak-duck-mono-{ink,paper}` |

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

- _App icon:_ the full duck, about 65% of the canvas width, centred on Ink,
  on a square 1024 px canvas with no baked mask. Platform masks (rounded
  square, Mac tile, circle) come from each platform's own template.
- _Avatar:_ circle crop on Ink; compact variant below 48 px.
- _Social card_ (1200 × 630) and _title slide_ (16:9): the tagline in
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

| Mood          | When (computed in `src/fleet/duck-mood.ts`) | Artwork                    | Motion             |
| ------------- | ------------------------------------------- | -------------------------- | ------------------ |
| `asleep`      | Nothing active at all                       | Eyes shut, drifting "z z"  | Slow bob, 5.0s     |
| `idle`        | Sessions open, none doing anything          | Neutral, eyes open         | Gentle bob, 3.4s   |
| `working`     | At least one agent mid-turn                 | Focused brow               | Quick bob, 1.1s    |
| `celebrating` | Something finished in the last 45s          | Happy, sparkles            | Hop, 0.55s springy |
| `needs_you`   | Something is blocked on you                 | Wide eyes, alert ring      | Alarm wobble, 0.6s |
| `offline`     | Squeak itself is unreachable                | Greyed (`grayscale` + dim) | Still              |

Rules:

- **One duck per screen.** It is a character, not a bullet point. Never use it
  as a list icon or repeat it in rows.
- The duck always faces **right**, toward the content it is reporting on.
- Mood priority is fixed: needs you > celebrating > working > idle > asleep.
- New moods need new artwork in the same style (outline weight, flat fills,
  single shade). Never recolour the duck to show state — state has its own
  colours (§3.3); the duck shows _mood_.
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
duck, whose motion _is_ its mood.

| Token             | Duration  | Easing                             | Use                                        |
| ----------------- | --------- | ---------------------------------- | ------------------------------------------ |
| `motion-quick`    | 120ms     | ease-out                           | Hover, press, toggles                      |
| `motion-standard` | 200ms     | ease-out                           | Panel open/close, row insert/remove, sheet |
| `motion-emphasis` | 320ms     | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` | A card arriving that needs you             |
| Pulse (working)   | 1.6s loop | ease-in-out                        | Working dot                                |
| Pulse (needs you) | 1.0s loop | ease-in-out                        | Needs-you dot                              |

Rules:

- Rows entering or leaving the list animate height and opacity together at
  `motion-standard`; a row changing state cross-fades its dot, it does not move.
- Panels open from the duck (scale from its corner), and must not make the
  duck jump — the window grows around a fixed duck (see `CLAUDE.md`).
- **Reduced motion:** pulses become static dots, the duck stops bobbing and
  switches sprite only, panels fade instead of scaling. All state must remain
  readable with zero motion.

The marketing website (`website/`) is a brand surface, not the app. There
motion may be expressive: scroll scenes, a WebGL backdrop, the duck pile.
It is still never the only carrier of meaning, and every scene has a
reduced-motion and no-JavaScript version that shows the same content still.

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

- **The phone's Home is the projects list** (owner's decision, 2026-11-08, after
  Happy; it began 2026-10-21 as group cards). The standalone app has no tab bar:
  one screen, the large title **Sessions**, the duck top left (§6.3) and, top
  right, one glass capsule holding **Usage** and **Settings** (Settings opens as
  a sheet; before iOS 26 the same two icons, flat). A host that embeds
  `SqueakRootView` keeps group cards and, with no bar of its own, a segmented switch to pick **Projects** (one card per
  repository) or **Status** (one card per state that has chats in it, in
  attention order: Needs you, Working, Done, Error, Idle), over the same
  snapshot, so nothing waits on the network. A card is one neutral surface
  (12pt, a hairline, no shadow, no state fill) and stays short:
  - A **project row** (owner's decision, 2026-11-08): Projects is one flat
    list, no cards, one row per repository. A 52pt round project icon; the
    name and the newest chat's age; the newest chat's title in `muted`; the
    counts in `subtle` ("3 sessions · 1 needs you · 1 working").
  - **The corner says what is new** (owner's decision, 2026-11-08, after Happy):
    the top-right corner of a project row and of a chat row is the time, or a
    10pt dot in its place: `needs-you` red when the agent waits on you, `done`
    blue when it answered and you have not looked. There is no "New replies"
    section; an unread chat stays on its project's row (even once it is older
    than the active window) until you open it. The row's words still say the
    state, and VoiceOver hears it. Hairlines start at the text. The
    row opens the project, and a chat is opened from the project's own page;
    Home never opens a chat from this list.
  - A **status card**: the state's word, a dot (not under Needs you, which has
    its left edge and badge) and a count, then its first chats. A group of six
    or fewer opens **in place** (the header and **Show all N / Show less** are
    disclosure buttons, the chevron turns, VoiceOver hears expanded or
    collapsed), so a tap never lands on a nearly empty page. A longer group, and
    Needs you, whose one-tap answers are the reason to go there, open their own
    list under a compact bar.
  - A chat row: the agent's own app icon (Claude, Codex; a neutral tile for any
    other) with a Conductor badge when Conductor holds it, title and age
    (VoiceOver: "last active 12 minutes ago"), the state in words with `agent`
    (`repo · agent` under Status), and, for a chat that needs you, failed, or
    (under Status) finished, the agent's own words. An approval that only the
    Mac can give says so; no button promises it. Each row is its own tap target.
  - One duck, in the header; never in a card. **Earlier** is a quiet card at the
    foot. Swipe actions live in the lists, not on Home.
  - **The dock** (owner's decision, 2026-11-08): at the foot, one 56pt glass
    capsule search field, "Search projects and chats…", with a 44pt round
    **New chat** beside it (only when the Mac can list workspaces). 16pt from
    each side, 8pt above the safe area, riding above the keyboard. A scrim from
    the screen's foot to the capsule's middle fades into the list so nothing
    reads through it, and the list scrolls clear of it. Typing replaces the list
    with every match, active chats then Earlier, each newest first. Focused and
    empty, a row of chips sits over the dock: **Needs you** (with its count; it
    opens the Needs you page, the decision cards), **Working**, **Done**,
    **Claude**, **Codex** and up to five projects, the newest first. A tapped
    chip becomes a removable token in that row (VoiceOver: "Working filter,
    removes this filter"), not text. The line is read as filters and words:
    state words and their synonyms (needs you, waiting, blocked, question;
    working, running; done, finished; error, failed; idle), `claude` or `codex`,
    `today`, `yesterday`, `this week` by last activity, `project:name` or
    `in:name` by prefix, and any other word, which must appear in the title,
    project, branch, repo, the agent's last words or its question. Words are
    all required, kinds of filter are all required, two states or two agents
    are either. Case and accents do not matter. A chat opened from a link or
    notification still opens straight away. The dock hides on every pushed page.
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
- **A chat screen has no dock.** Its composer sits at the bottom. It opens at the newest message and follows what arrives only while
  you are at the bottom; read further up and it lets go, with a "New" pill to come back.
  And it never goes blank while the Mac moves a chat
  between the active and recent lists (the two reach the phone separately): the
  phone keeps its last view of the chat for 90 s.

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
  (Telegram: `★` on the letter button). It is _not_ pre-selected or coloured —
  the choice stays the user's.
- On the phone's Needs you page the card carries no red edge or dot (the tab
  already says it): the header reads `project · branch · age`, and the status
  line (sending, `Sent · <what>`, or the failure, the only red) sits directly
  under it; a sent card collapses to header plus that line.
- After a tap the card collapses to a receipt: `✓ Sent B in Conductor` (or
  `in the background`, with the reason). A receipt is not tappable again.
- Options that could cause irreversible effects are not special-cased
  visually; the agent's own wording carries that. Squeak never adds urgency.

### 8.5 Reply composer

A single text field with the target named in its placeholder: _"Message for
orchard · irrigation"_. Send is the only primary button. The composer stays;
each sent message carries its delivery state. The three plain states are a
glyph beside the time, never words: a clock while it goes, one check once the
Mac has it, two checks (in `ink`) once the agent has it — its turn started
from it, the turn shows the steer, or it left Conductor's queue. VoiceOver
still reads the words (_Sent_, _Read by Claude_). Everything else keeps one
short muted line: _Queued_ (and the message text drawn in `muted` until the
agent reads it, as a mid-turn message waits), _Steered at 14:05_, and any
problem as a full sentence (_Not sent. …_, _Couldn't confirm it arrived. …_). If the
turn then ends with no answer after it (an error, a stop), the line becomes
**Turn ended**, the final state. A steer's line carries its time: _Steered at
14:05 · Read by Claude_. "Sent" only ever means the Mac has it. A sent bubble
never takes more than about 85% of the width.

An answer from before the one being worked on keeps full-contrast text (it is
never faded to say "old"): a small muted **Previous answer** caption sits above
it and a hairline (`line`) closes it before what follows. At the larger text
sizes (from XXL) the stack under the chat (notices, queue, background work,
setup line, composer) is capped at 40% of the screen and scrolls, and each
queued message's Steer now and ⋯ sit under its text. It never sends to a session the user did not explicitly pick.

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

| State               | Duck      | Copy                                                                       |
| ------------------- | --------- | -------------------------------------------------------------------------- |
| Nothing running     | `asleep`  | "Nothing's running. The duck is resting."                                  |
| Everything idle     | `idle`    | "All quiet. 4 sessions open, none working."                                |
| Squeak unreachable  | `offline` | "Can't reach Squeak on this Mac. Is it running?" + **Start Squeak** button |
| Mobile, Mac offline | `offline` | "Your Mac is offline. You'll see updates when it's back."                  |

An empty state always says what is true and, if there is one, the single
action that changes it. No "Oops".

### 8.8 Diff viewer

Mono `code` style. Added lines on a 12% tint of working-green, removed on a
12% tint of needs-you-red — the only place red appears without meaning "needs
you", and deliberately tinted, never saturated. File list first, one file's
patch second (as Telegram does today). Paths truncate from the start.

### 8.9 Buttons

| Kind        | Dark                                             | Light                                 | Use                                |
| ----------- | ------------------------------------------------ | ------------------------------------- | ---------------------------------- |
| Primary     | `duck` fill, `#18181B` text                      | `#18181B` fill, white text            | One per screen: Send, Start Squeak |
| Secondary   | `surface-raised` fill, `ink` text, `line` border | white fill, `ink` text, `line` border | Everything else                    |
| Quiet       | text only, `muted`                               | text only, `muted`                    | Tertiary: Read full message        |
| Destructive | `surface-raised` fill, needs-you-red text        | white fill, red text                  | Stop an agent, disconnect a device |

The duck-yellow primary is the brand's single loud control. On light
backgrounds the primary is ink-black instead, because yellow fails on white
(§3.4).

### 8.10 Workbench

The conversation window of Squeak for Mac. Mocks and renders: `.context/design/` (1440×900). Anything not covered by another section is defined here.

#### What it is

The conversation window becomes a **workbench**: where you work with agents, not only read them. Squeak's native chats and Conductor's chats live in one window.
Structure follows Conductor (sidebar → workspace sheet → inspector); transcript craft follows Happy (centred column, quiet tool previews, cards that stop you); colour, type, voice and the duck are Squeak's (§3–§6, §9). The principle is unchanged: **the duck carries the emotion, the interface carries the facts.**

#### Layout (design reference 1440×900; minimum 960×620)

```
┌ Sidebar 248 ┬ Centre (flex) ────────────────────────────┬ Inspector 320 ┐
│ lights/44   │ toolbar 44: crumb · branch · +/− · toggle │ tabs 44        │
│ New chat    │ chat tabs 36                              │ Changes        │
│ Search ⌘K   │ transcript, column ≤ 880 (bottom-anchored)│ Files          │
│ Needs you   │ dock: background, queue, composer         │ Activity       │
│ Projects    │                                           │                │
│ footer 56   │                                           │                │
└─────────────┴───────────────────────────────────────────┴────────────────┘
```

- Panes are resizable: sidebar 220–360, inspector 280–480 (hairline drag handle, 4pt hit area, no visible grip). Sidebar ⌘B, inspector ⌘⌥B; both collapse to zero. Positions are remembered per window. **The inspector is closed by default**, so the column is the full 880 on a 1440 window; it opens on demand and stays as the person left it.
- **Column:** `min(880, available − 32)`. With the inspector closed at 1440 it is 880; with both panes open it is ~840 and reaches 880 at ~1544. Transcript, background strip, queue and composer share one column. Diffs and terminal output fill the column's width, never wider.
- Grounds (Mac dark neutrals, §3.2): centre = `bg`; sidebar and inspector = `sidebar`; cards, composer, user bubbles = `surface`; popovers, sheets, approval cards = `surface-raised`; selected row/tab = `selected`. Light: centre `bg` (#F4F4F5), sidebar/inspector `sidebar` (#EBEBEC), cards `surface` (white). Separation is **`line` hairlines**, never shadow inside the window (§5). Only the sheet and ⌘K palette float and use `shadow-float`.
- The transcript is **bottom-anchored** when longer than the viewport (newest at the composer, a 28pt fade at the top) and top-anchored when short.
- Window chrome: traffic lights sit in the sidebar's 44pt top row; the toolbar has no hairline of its own; the tab strip's bottom hairline is the only line under it.

#### Regions

##### Sidebar

Order, top to bottom: row of **New chat** (secondary button, ⌘N) and **New workspace** (icon button, ⇧⌘N); **Search** field that opens ⌘K; **Needs you**; **Projects**; footer with the duck, one line of totals ("1 working · 1 needs you") and Settings.

- **Needs you** is a group, not a sort order. It lists every chat waiting on you, newest first, as shortcut rows (repo · workspace in the meta line). The same chat **also shows in its place in the tree**, so nothing moves when it needs you; the Needs you row is a link to it. Empty = the group is absent (a screen with nothing blocked has no red, §3.3).
- **Tree:** project → workspace → chat, **every level newest first by last activity**; ties by title. Projects collapse; a workspace shows its chats only when expanded; a collapsed workspace shows one dot, the highest-priority state inside it (Needs you > Working > Done > Error; idle shows none). Project tile = Conductor's own icon when present, else a neutral letter tile (never an invented mark, §8.2).
- **Chat row** is fixed at 40pt, two lines, in every state (nothing jumps): dot (9pt, §8.1) + title (`label`) + age (`meta`, tabular); meta line `agent · state · what it is doing`. The state word is always present, so colour is never the only signal.
- **Conductor chats** carry a `Conductor` chip (`meta`, `radius-chip`, `line-strong` border, `muted`) at the right of the meta line. Native chats carry nothing: native is the default, Conductor is the exception.
- Hover/selected = `selected` fill, `radius-control`; hover recolours only.
- The duck is the window's one mascot moment (§6.3): compact, mood from `/state` (working, needs_you, …), 28pt, in the footer. Never in a row.

##### Toolbar and chat tabs

- Toolbar: `project / workspace`, branch chip (mono), then the workspace's diffstat (`+142 −38 · 6 files`, tabular, working-green and needs-you-red as in §8.8), **Open in ▾** (quiet), inspector toggle.
- Tabs = the workspace's chats (⌘T new, ⌘W close, ⌃Tab next). Height 28 in a 36 strip, max 210 wide, dot 7pt + title + close (close space reserved, visible on the active tab and on hover). Selected tab = `selected`. Conductor chats show the same chip. Drag to reorder.

##### Transcript (reading size `reading`, 14/22; `body` 13/19 stays for lists)

| Element       | Spec                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User message  | right-aligned `surface` bubble, `line` border, `radius-card`, max 85% of the column, 14/21; under it `meta` right: time and delivery ("14:02 · Read by Claude", §8.5).                                                                                                                                                   |
| Agent text    | no bubble, `ink`, 14/22, markdown; inline code = `selected` chip, mono 12.                                                                                                                                                                                                                                               |
| Thinking      | one muted row: chevron, brain icon, "Thought for 8s". Open: the summary in `muted` italic 13/20 behind a 1pt `line-strong` rule. Live: "Thinking…" open, following the newest summary. Default closed once finished.                                                                                                     |
| Tool call     | one 28pt row: Lucide icon 14, verb (`muted`, 56pt column), target in mono (paths truncate from the **start**), right meta (`+18 −2`, `212 lines`, `6s`), chevron. Click expands; hover recolours. Running: a 7pt working dot before the time. Several steps between two messages fold to "Worked · 6 steps" (tap opens). |
| Expanded Edit | file header (path, `+/−`) then the **inline diff**: mono `code`, 12/18, line numbers `subtle`, added on a 12% tint of `working`, removed on 12% of `needs-you` (§8.8), hunk header `subtle`. Never shows more than 14 lines before "Show all" (inspector holds the whole thing).                                         |
| Expanded Run  | `$ command` in `ink`, output tail in `muted`, ✓ in `working`; tail only while running.                                                                                                                                                                                                                                   |
| Working row   | `working` dot (1.6s pulse) · **Claude is working** · elapsed · model · right: `⌘.` to stop. One row, always the last thing, height reserved.                                                                                                                                                                             |
| Turn end      | no banner; the working row simply goes away and the sidebar dot turns blue.                                                                                                                                                                                                                                              |

##### Cards that need you

One shared anatomy: `surface-raised`, `radius-card`, `line` border, **3pt `needs-you` left edge** (state colour only on the edge and dot, §3.3), header = dot + state word + kind chip + "Claude · age"; body; action row. They arrive at `motion-emphasis`, in place at the end of the transcript, **without scrolling the user away** if they are reading up (a pill "Needs you ↓" appears instead).

| Card              | State word      | Body                                                                                                                                                                     | Actions                                                                                                                                                                                                                               |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool approval** | needs approval  | heading in plain words ("Run a command that deletes a folder"), the command/path in a mono block, Claude's stated reason quoted                                          | **Allow once** `↵` (the one `duck` primary on screen), **Allow for this session** `⌘↵` (secondary), **Deny** `⌫` (destructive style, right-aligned, apart from Allow). Typing in the composer and pressing ↵ = deny with that reason. |
| **Plan**          | plan ready      | plan title (`heading`), numbered steps (13.5/20), files-touched chips, "Approving switches to Accept edits"                                                              | **Approve plan** `⌘⇧↵` (primary), **Keep planning** (secondary → focuses composer: "Adjust the plan…")                                                                                                                                |
| **Question**      | needs an answer | the question (`heading`), options as full rows: letter in a `radius-chip` square, title, `recommended` in `muted` (not pre-selected, §8.4), `1–9` shortcuts, `0` = Other | none; a choice sends. Multiple questions: ←/→.                                                                                                                                                                                        |

After an answer the card collapses to a receipt line (`✓ Allowed once · 14:06`, `✓ Plan approved`, `✓ Answered B`), not tappable again, and the left edge goes. A tool approval that Squeak cannot give (Conductor chat, Mac-only) says so and offers no button (§8.2).
Only one primary on screen at a time: while a card is up, **the duck primary moves to Allow once / Approve plan and Send is disabled**; it moves back when the card is answered.

##### Dock: background work, queue, composer

- **Background strip** (30pt, only while something runs): "Background" + one chip per subagent/shell (`working` dot, name, what, age) + chevron. Details live in the inspector's Activity tab.
- **Queue** (§8.5, unchanged rules): oldest first under "Queued · Claude reads it after this turn"; each card: text in two lines, **Steer now** (secondary), ⋯ (Edit, Delete). Keys on a focused card: `E` edit, `⌫` delete, `↵` steer.
- **Composer:** `surface`, `line-strong` border, `radius-card`, 14/22 field, then a control row: attach (paperclip), **mode chip**, **model**, **effort**, space, `ctx 62%` (tabular), **Send / Queue / Stop** (30pt round). Glass is allowed here on macOS 26 (§5); the mock shows the opaque fallback.
- **State-aware placeholder:**
  | State | Placeholder | Round button |
  |---|---|---|
  | idle | `Message Claude in mallard` | Send (duck) |
  | working | `Add a follow-up. Claude reads it after this turn` | Stop (needs-you-red square on `surface-raised`) when empty; **Queue** once typed; ⇧⌘↵ = Steer now |
  | needs approval | `Allow or deny above, or tell Claude what to do instead` | Send, disabled |
  | plan ready | `Adjust the plan, or approve it above` | disabled |
  | question | `Answer above, or write your own answer` | disabled |
  | Conductor chat, Conductor holds it | `Message goes into Conductor's window` (existing reply path, §CLAUDE) | Send |
  | host down | `Squeak's session host isn't running` | disabled, one action: Start |
  A one-line hint under the box lists the live keys for that state (fixed height, so nothing jumps).
- **Mode chip** (⇧Tab cycles Ask → Accept edits → Plan → Skip approvals): glyph + word, `radius-control`, a 12% tint of the colour with a 30% border, text in the colour. The colours are the state tokens reused, with no `mode-*` tokens; never colour alone, the word is always there. Skip approvals asks one sentence of confirmation the first time per workspace, no scare copy.
  | Mode | Word | Glyph | Colour (state token, reused) |
  |---|---|---|---|
  | ask | Ask | shield | `muted` (neutral) |
  | accept edits | Accept edits | pencil | `done` |
  | plan | Plan | list-checks | `working` |
  | skip approvals | Skip approvals | zap | `error` |
- **Model picker** (⌘/): Conductor's catalogue as the Mac lists it, favourites first, filter field, "More models". **Effort** (⌘⇧/ cycles): the levels the model takes. Changing either mid-turn applies next turn; the chip says so in its tooltip.
- **Attachments:** paperclip or drop or paste; a tray of thumbnails (x on each) above the field; same `.context/attachments/<id>/` rule as the phone (§8.5). Long pasted text becomes an attachment chip.
- `/` opens slash commands (`/clear`, `/compact`, `/restart`, plus skills), `@` mentions files.

##### Inspector (⌘⌥B)

Tabs: **Changes**, **Files**, **Activity**; the tab with something live shows a dot, counts are tabular.

- **Changes:** "6 files · +142 −38 · vs master"; file rows (status letter M/A/D, path truncated from the start, `+/−`); one file's diff open under its row; Squeak's rule stands: diff against the base branch **including untracked files** (§CLAUDE). No commit/PR buttons in v1.
- **Files:** the workspace tree (⌘P quick open); a file opens in a read-only mono viewer; "open in editor" is a quiet button.
- **Activity:** "What it's doing" (the current turn's steps, newest first, one line each, the live one with its state dot), then "Background · N": subagents and shells as small cards (state dot, name, age, one line); finished ones stay 10 min, `done` blue (matches `background-work.ts`). A blocked chat's first row says "Waiting for your approval" with the red dot.

##### New chat / New workspace sheet (mock d)

One sheet, `radius-panel`, `surface-raised`, `shadow-float`, 600 wide, over a scrim. Title "New chat"; segmented **In mallard | In a new workspace** (⌘N opens the first, ⇧⌘N the second). The new-workspace mode shows project, **workspace name** (a bird, suggested, editable), the branch it will get (`<prefix>/<name>`, from the project's base), and one honest line about what happens ("Creates a git worktree, copies 3 files from `.worktreeinclude`, runs the repo's setup script. The branch is renamed from your first message."). Then Agent (Claude/Codex), Permissions, Model, Effort, First message, Attach. Primary: **Create workspace and start** (⌘↵). One primary; Cancel is Esc.

##### ⌘K palette (mock f)

640 wide, 120 from the top, `radius-panel`. Groups in fixed order: **Needs you**, Chats, Workspaces, Actions (each result newest first; typing filters and ranks by match, then recency). Each row: dot or icon, title, muted context, shortcut keycaps. `↵` open, `⌘↵` open in a new tab, `>` actions only, `@`/`#` not used. Same search grammar as the phone's dock where it applies (state words, `claude`/`codex`, `project:`).

#### Keyboard map (Conductor's where it exists; ⌘. is stop, as macOS means it)

| Area      | Action                             | Keys            |
| --------- | ---------------------------------- | --------------- |
| General   | Palette · Settings · Shortcut list | ⌘K · ⌘, · ⌘⌥/   |
| Panes     | Sidebar · Inspector                | ⌘B · ⌘⌥B        |
| Workspace | New chat · New workspace           | ⌘N · ⇧⌘N        |
| Workspace | Switch 1–9 · previous/next         | ⌘1–9 · ⌘⌥↑/↓    |
| Chat tabs | New · close · reopen               | ⌘T · ⌘W · ⇧⌘T   |
| Chat tabs | Next/previous                      | ⌃Tab / ⌃⇧Tab    |
| Chat      | Focus composer                     | ⌘L              |
| Chat      | Next chat that needs you           | ⌘⌥L             |
| Composer  | Send / queue · newline             | ↵ · ⇧↵          |
| Composer  | Steer now                          | ⇧⌘↵             |
| Composer  | Cycle permission mode              | ⇧Tab            |
| Composer  | Model picker · cycle effort        | ⌘/ · ⌘⇧/        |
| Composer  | Attach                             | ⌘U              |
| Chat      | Stop the turn                      | ⌘. (also ⌘⇧⌫)   |
| Cards     | Allow once · for session · deny    | ↵ · ⌘↵ · ⌫      |
| Cards     | Approve plan                       | ⌘⇧↵             |
| Cards     | Answer a question · other          | 1–9 · 0         |
| Chat      | Find in chat                       | ⌘F              |
| Inspector | Changes · Files · Activity         | ⌘⌥1 · ⌘⌥2 · ⌘⌥3 |
| Files     | Quick open                         | ⌘P              |

Keys on a card work only when no text field has focus. ⌘, and ⌘Q keep their meaning (§CLAUDE). Existing global shortcuts (peek, show/hide, double-tap Quick message) are untouched.

#### Motion

Uses the §7 tokens and nothing else. `motion-quick` hover/press/toggle; `motion-standard` pane open/close, row insert/remove, sheet, tool expand (height + opacity together); `motion-emphasis` a card that needs you arriving. Pulses: working 1.6s, needs-you 1.0s.
**Nothing jumps:** a row changing state cross-fades its dot and never changes height (chat rows are 2 lines in every state); reserved boxes for the working row, background strip, hint line and tab close buttons; hover and focus recolour, never move or resize; a streaming message grows only below its own start; the transcript follows new output only while you are at the bottom, otherwise it lets go and shows a "New" pill; a collapsing receipt does not shift what is above it. Reduced motion: dots static, expands and sheets fade, everything readable with zero motion (§7, §10).

#### Tokens used

Brand: `duck` (the single primary: Send, or Allow/Approve while a card waits; Create), `duck-outline` (text on it), `duck-text` (unused on dark). Neutrals (Mac dark set, §3.2): `bg`, `sidebar`, `surface`, `surface-raised`, `selected`, `line`, `line-strong`, `ink`, `muted`, `subtle`. State: `needs-you`, `working`, `done`, `error`, `idle`. Shape: `radius-panel` (sheet, palette), `radius-card` (cards, composer, bubbles), `radius-control` (rows, buttons, inputs, chips that act), `radius-chip` (tags), `radius-round` (dots, Send/Stop). Depth: `shadow-float` only on the sheet and palette. Motion: quick/standard/emphasis, both pulses. Type: the system UI font (Figtree and Inter stay brand material, never in the app) and the new `reading` size for agent text; mono (JetBrains Mono in the mock, as the web fallback of `font-mono`; SF Mono in the app) for paths, commands, diffs, branch names; tabular numbers on every count and time. Icons: Lucide, 1.5 stroke, 14–16.

#### Borrowed, and deliberately different

| From         | Borrowed                                                                                                                                                               | Different here                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conductor    | Sidebar tree of projects/workspaces/chats; chat tabs; right inspector (Changes/Files); ⌘K; its shortcut set; queue + steer; plan toggle on ⇧Tab; city-named workspaces | Birds, not cities; Squeak palette (not stone/rose); status = Squeak's five states and words; a **Needs you** group and the duck footer; urgency is never sort order; chip marks Conductor chats, not native ones |
| Happy        | 880 column; one-line tool previews; collapsible thinking; approval/plan/question cards as transcript entries; single hover shape; "nothing jumps"                      | Cards use a red left edge and put the one duck primary on Allow/Approve; state words everywhere; no grey/teal; user bubbles right-aligned at ≤85% as on the phone; no monochrome black primary on dark           |
| Squeak today | Reply composer rules, queue cards, receipts, diff tints, state rows, copy voice                                                                                        | Window becomes three panes; Home/needs-you list is the group in the sidebar; copy still says agent/chat/needs you/working/done/idle                                                                              |

Voice: sentence case, no exclamation marks, no emoji, "Claude is working" not "Thinking…" in the status row, honest receipts ("Allowed once"), the duck never speaks.

No zen mode in v1, so ⌘. is Stop. A Conductor chat that blocks inside Conductor shows its card read-only ("Answer in Conductor"), because Squeak cannot give that approval. The sheet and palette scrim is 45% black in dark and 28% ink in light.

---

## 9. Voice and copy

### Vocabulary

Use these words, consistently, everywhere:

| Say           | Means                                     | Don't say                         |
| ------------- | ----------------------------------------- | --------------------------------- |
| **agent**     | Claude, Codex or another model doing work | bot, AI, assistant                |
| **session**   | One agent conversation, wherever it runs  | thread, job, task                 |
| **chat**      | A session that lives in Conductor         | conversation                      |
| **needs you** | Blocked on approval or an answer          | action required, attention needed |
| **working**   | Mid-turn right now                        | running, processing, busy         |
| **done**      | Finished a turn, not yet looked at        | completed, succeeded              |
| **idle**      | Open, doing nothing                       | inactive, paused                  |

### Rules

- **Lead with the fact.** "orchard · irrigation needs approval" — not "Heads up!
  An agent is waiting for you."
- **Say it once, short.** Three lines on a card. One sentence in an empty
  state. Buttons are verbs: _Reply_, _View diff_, _Start Squeak_.
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

| Situation  | Yes                                                                                          | No                                                           |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Blocked    | `🔴 orchard · irrigation — needs approval`                                                   | `⚠️ ACTION REQUIRED: Agent awaiting permission!`             |
| Finished   | `✅ squeak · session-hub — done` / `Fixed the stale finish detection.` / `_3 files changed_` | `🎉 Great news! Your agent completed its task successfully!` |
| Reply sent | `Sent B to orchard · irrigation in Conductor.`                                               | `Your response has been submitted.`                          |
| Failure    | `The reply did not go through: claude exited (1).`                                           | `Oops, something went wrong. Please try again.`              |

### Brand copy

Outside the product — the site, the App Store, announcements, bios — the same
voice holds: calm, clear, lightly witty, useful. Charm lives in the mascot;
the words stay plain. Say what Squeak does for the reader, in their words.
One duck joke at most, and never in a headline. Platforms keep their own
capitalisation: Mac, iPhone, Telegram, Cliq.

| Kind         | Yes                                                                                                       | No                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Tagline      | Your agents. In view.                                                                                     | The ultimate AI agent command center!                  |
| Description  | An attention inbox for the coding agents you already use.                                                 | Revolutionary AI-powered productivity for developers.  |
| Announcement | Squeak tells you which coding agent needs you, and carries your answer back. On Mac, iPhone and Telegram. | Squeak is here to supercharge your workflow!!          |
| Bio          | Squeak. A pager for your coding agents.                                                                   | Quack quack! The quackiest way to herd your AI agents. |

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

  /* workbench layout (Mac, §8.10) */
  --sq-sidebar-width: 248px;
  --sq-inspector-width: 320px;
  --sq-column-max: 880px;
  --sq-chat-row-height: 40px;
  --sq-type-reading: 14px / 22px;

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
  "brand": {
    "duck": "#FFDA1A",
    "duckWing": "#FFC812",
    "beak": "#FF972E",
    "duckOutline": "#18191B",
    "duckText": "#8A5A00"
  },
  "dark": {
    "bg": "#09090B",
    "surface": "#18181B",
    "surfaceRaised": "#27272A",
    "line": "rgba(255,255,255,0.08)",
    "ink": "#F4F4F5",
    "muted": "#A1A1AA",
    "subtle": "#71717A",
    "needsYou": "#F87171",
    "working": "#22C55E",
    "done": "#38BDF8",
    "error": "#A78BFA",
    "idle": "#71717A",
    "offline": "#52525B"
  },
  "light": {
    "bg": "#F4F4F5",
    "surface": "#FFFFFF",
    "surfaceRaised": "#FFFFFF",
    "line": "rgba(0,0,0,0.08)",
    "ink": "#18181B",
    "muted": "#52525B",
    "subtle": "#71717A",
    "needsYou": "#DC2626",
    "working": "#15803D",
    "done": "#0369A1",
    "error": "#7C3AED",
    "idle": "#71717A",
    "offline": "#A1A1AA"
  },
  "workbench": { "sidebar": 248, "inspector": 320, "column": 880, "chatRow": 40 },
  "radius": { "panel": 16, "card": 12, "control": 8, "chip": 6 },
  "space": [2, 4, 8, 12, 16, 24, 32, 48],
  "type": {
    "display": [28, 34, 700],
    "title": [20, 26, 600],
    "heading": [15, 20, 600],
    "body": [13, 19, 400],
    "reading": [14, 22, 400],
    "bodyMobile": [16, 22, 400],
    "label": [13, 18, 550],
    "meta": [11, 15, 400],
    "code": [12, 18, 400]
  },
  "motion": { "quick": 120, "standard": 200, "emphasis": 320, "pulseWorking": 1600, "pulseNeedsYou": 1000 }
}
```

---

## 12. Changes from what ships today

This guide deliberately changed a few things in the duck and cards. All of
them are applied (step 3): the duck's panel reads `tokens.css`, and the
Telegram glyphs follow §3.3.

| Where                      | Today                    | This guide       | Why                                                       |
| -------------------------- | ------------------------ | ---------------- | --------------------------------------------------------- |
| `duck.css` `--duck`        | `#ffd23f`                | `#FCD02C`        | Match the sprite's actual yellow                          |
| `duck.css` `--beak`        | `#f97316`                | `#FC8830`        | Match the sprite                                          |
| Error dot                  | `#f59e0b` amber          | violet `#A78BFA` | Amber is duck-family; errors must not read as brand       |
| Needs-you dot              | `#ef4444`                | `#F87171` (dark) | Higher contrast on the dark panel (6.40 vs 4.71)          |
| Telegram "needs an answer" | 🟡                       | 🔴               | Both blocked states are "needs you"; yellow is the duck's |
| Telegram error             | ❗                       | 🟣               | Matches the violet error colour                           |
| Panel text colours         | hard-coded in `duck.css` | `--sq-*` tokens  | One source for every surface                              |

**Brand Edition 01 (version 2).** Adopting the brand kit changes these. They
are written into §3.1 and §11 but **not yet applied in code**:

| Where                                                                                                                   | Today                                    | Now                                   | Why                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `--sq-duck` (the old Electron `tokens.css`, `Theme.swift` in `ios/` and `macos/`, `macos/scripts/dmg-background.swift`) | `#FCD02C`                                | `#FFDA1A`                             | The approved logo's yellow                                       |
| `--sq-duck-wing`                                                                                                        | `#FCC010`                                | `#FFC812`                             | The logo's wing shade                                            |
| `--sq-beak`                                                                                                             | `#FC8830`                                | `#FF972E`                             | Bill Orange                                                      |
| `--sq-duck-outline`                                                                                                     | `#3C1804` brown                          | `#18191B` Ink                         | The logo's contour is Ink                                        |
| Mood sprites (`brand/mood-sprites/duck-*.png`, the iPhone's `Media.xcassets`)                                           | The older round-eyed duck, brown outline | Redraw from the approved duck, in Ink | One duck everywhere; the sleepy eye is the logo's own expression |
| Menu-bar mark                                                                                                           | Generated from the old sprite            | Regenerate from the new artwork       | `make-tray-icon.py` follows the sprite                           |

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
   channel can make agents on your Mac _do things_, so it needs real
   authentication, device pairing, and an allow-list of actions — decided in
   that step, before any code.
5. **Squeak for iPhone** ✅ (Android later). Home = the attention-ordered list;
   decision cards; reply composer; diff review; push notifications that match
   the Telegram cards. Same tokens, system type, 44pt targets.
6. **Telegram becomes one channel among several**, fed by the same state and
   the same card rules.
