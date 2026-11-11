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
   exists. It gets the amber glyph and card edge, the only badge, the only interruption.
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

**One exception: `warning` amber** (owner's decision, 2026-11-09). A single
token, `warning` (`#E0A030` dark, `#A16207` light, 38° hue, darker and less
saturated than `duck`'s 49°), marks a decision waiting on the person: the
`triangle-alert` glyph of an approval or a plan, a card's 3pt left edge, and the
duck's attention count (the menu-bar count too, where the platform lets it take colour; the Mac's template mark cannot). It is a **thin glyph stroke, an
edge or a count's digits only: never a dot, a fill or body text.** It stays
apart from the duck by shape (a triangle, an edge), never a dot. `duck` `#FFDA1A`
and `beak` `#FF972E` stay brand-only.

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

**Mac neutrals: one warm, opaque scale** (owner's decision 2026-11-09, from `.context/UI-SPEC.md` §1.1: Squeak for Mac follows the app it should resemble in colour, proportions and arrangement, and keeps its own name, duck, Lucide icons and marks). The workbench window is **opaque**: no behind-window material, no tint, no navy wash (Settings › Window appearance is gone; `panel-glass` and `panel-translucent` belong to the menu-bar panel only). Every step keeps a hue near 20° and a saturation under 10%.

| Mac token                 | Dark      | Light              | Use                                                                       |
| ------------------------- | --------- | ------------------ | ------------------------------------------------------------------------- |
| `bg`                      | `#141110` | `#FFFFFF`          | The centre canvas, opaque                                                 |
| `sidebar`                 | `#211E1C` | `#FAFAF9`          | Sidebar, inspector, composer                                              |
| `surface`                 | `#211E1C` | `#FAFAF9`          | Composer, the person's bubble, muted fills, code                          |
| `surface-raised`          | `#2C2826` | `#FFFFFF` + `line` | Cards, popovers, sheets, approval cards                                   |
| `selected`                | `#2C2826` | `#F0EEED`          | Selected row (a filled rounded pill), hover, an inline-code chip          |
| `selected-strong`         | `#37322F` | `#E7E4E2`          | The strongest fill (pressed, a drag target)                               |
| `ink`                     | `#EAE8E6` | `#2C2826`          | Primary text                                                              |
| `muted`                   | `#A5A09C` | `#8E8885`          | Secondary text                                                            |
| `subtle`                  | `#766F6B` | `#A5A09C`          | Meta, placeholders, idle (the target's faint level; decorative text only) |
| `line`                    | white 10% | `#EAE8E6`          | Hairlines and 1pt borders                                                 |
| `line-strong`             | white 20% | `#14100F` 10%      | Input borders, a hovered handle                                           |
| `working` (diff add)      | `#4ADE80` | `#16A249`          | Diff additions                                                            |
| `negative` (diff removed) | `#F87272` | `#DC2828`          | Failure, Stop, diff removals                                              |

Three levels of text (`ink`, `muted`, `subtle`) are the whole scale: a fourth would only be a quieter grey that fails contrast. The menu-bar panel's base is `rgba(36,33,30,…)` over glass, unchanged.

Note that `muted` differs by theme: zinc-400 is only **2.56:1** on white and
fails as text, so light mode uses zinc-600.

### 3.3 State colours — the heart of the system

Every agent is in one of a few states, and each has one mark, the same on every surface (Conductor's own glyphs: a grey loader, an alert triangle, a question bubble). A list never writes the state; it shows the mark, and the words live in the tooltip and VoiceOver. Colour is never the only signal: the marks differ in shape.

| State                       | Mark (Lucide where it is an icon)         | Dark                                              | Light      | Motion                     | Telegram glyph | Duck mood         |
| --------------------------- | ----------------------------------------- | ------------------------------------------------- | ---------- | -------------------------- | -------------- | ----------------- |
| Working                     | the matrix glyph (`MatrixActivity`, §8.1) | `ink` (running line, sidebar row), `muted` (slot) | same       | flowing matrix, 15 fps     | 🟢             | `working`         |
| Waiting on background tasks | the same glyph, quiet variant             | `muted`                                           | `muted`    | same frames, a 3 s cycle   | 🟢             | `working`         |
| Waiting for your approval   | `triangle-alert`                          | `warning`                                         | `warning`  | none in lists; duck wobble | 🔴             | `needs_you`       |
| Plan ready for your review  | `triangle-alert`                          | `warning`                                         | `warning`  | none in lists; duck wobble | 🔴             | `needs_you`       |
| Waiting for your answer     | `message-circle-question-mark`            | `muted`                                           | `muted`    | none in lists; duck wobble | 🔴             | `needs_you`       |
| Failed                      | `circle-x`                                | `negative`                                        | `negative` | none                       | 🟣             | none              |
| Finished, not opened        | an 8pt dot, the only dot left in a list   | `done`                                            | `done`     | none                       | ✅             | `celebrating` 45s |
| Finished and read, idle     | none (the age)                            | n/a                                               | n/a        | none                       | ⚪             | `idle` / `asleep` |
| Offline                     | none on rows                              | `offline`                                         | `offline`  | none                       | n/a            | `offline`         |

| Token      | Dark      | Light     | Use                                                                                                                        |
| ---------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `warning`  | `#E0A030` | `#A16207` | An approval's or a plan's triangle, a card's left edge, the duck's attention count. Never a dot, fill or body text (§3.1). |
| `negative` | `#F87171` | `#DC2626` | A failed chat's circle-x, error text, the Stop button, a destructive Deny, a diff removal. (Was `needs-you`.)              |
| `done`     | `#38BDF8` | `#0369A1` | The unread dot, the duck's unread count.                                                                                   |
| `working`  | `#22C55E` | `#15803D` | A diff addition only. Green no longer marks a state.                                                                       |
| `idle`     | `#71717A` | `#71717A` | Idle, disabled.                                                                                                            |
| `offline`  | `#52525B` | `#A1A1AA` | The duck and the footer when Squeak is not running.                                                                        |

- The violet `error` token is retired (the duck's own `needs_you` pulse stays); failures are red (`negative`) and are not pushed. Red marks failure and the destructive, never "waiting": a screen with nothing failed has none.
- Finished is blue, not green. Owner decision (2026-11-09): the single blue unread dot, the dot-grid loader and every mark here stay Squeak's own on the Mac workbench; a reference app's copper unread or coloured workspace status is not adopted. The unread dot is the only coloured dot left in a list; every other mark is a glyph or the grey loader.
- A state colour appears on the mark, the badge, or a card's left edge, never as a fill and never on body text. Cards: 3pt `warning` edge for an approval or a plan, `subtle` for a question; a failed chat has no card.
- Order is never state: lists are newest first by last activity, and a chat does not move because its state changes.
- Only one badge colour at a time on the duck: `warning` count if an approval or a plan waits on you, else `muted` for a question alone, else `done` count of unread finishes, else none. The menu-bar mark is a template (black, tinted by macOS), so on the Mac its count stays monochrome; the floating duck's sprite carries no badge.
- **Priority** where a row stands for several chats (a folded project or workspace): waiting, failed, finished-unread, working.
- **Unread** is the person's own record on this Mac: a chat is unread from a finished turn until it is opened, keyed by the turn's end, so a new finish makes it unread again. An offline Squeak is not a row mark; it stays on the duck and the footer ("Squeak is not running").
- Colour-blind check (Machado matrices, full severity): a red and an amber triangle become the same yellow-brown under deuteranopia, which is why failed is a `circle-x`, not a triangle.

### 3.4 Measured contrast

All values are WCAG 2 contrast ratios, computed, not estimated. Text needs
4.5:1, large text and non-text indicators 3:1.

| Pair                                                      | Ratio                               | Passes                               |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| `ink` on `surface` (dark)                                 | 16.12                               | AAA                                  |
| `muted` on `surface` (dark)                               | 6.91                                | AA                                   |
| `muted` on `surface-raised` (dark)                        | 5.81                                | AA                                   |
| `subtle` on `surface` (dark)                              | 3.67                                | non-text / large only                |
| `ink` on `surface` (light)                                | 17.72                               | AAA                                  |
| `muted` on `surface` (light)                              | 7.73                                | AAA                                  |
| `muted` on `bg` (light)                                   | 7.03                                | AAA                                  |
| `ink` (zinc-900) on `duck`                                | 12.90                               | AAA — text on a duck-yellow button   |
| `duck-outline` on `duck`                                  | 12.81                               | AAA                                  |
| `duck` on `surface` (dark)                                | 12.90                               | AAA                                  |
| `duck` on white                                           | **1.37**                            | **fails — never do this**            |
| `duck-text` on white                                      | 5.93                                | AA                                   |
| `negative` / `done` / `idle` on `surface`, dark           | 5.79 / 8.27 / 3.67                  | all ≥ 3:1                            |
| `negative` / `done` / `idle` on `surface`, light          | 4.83 / 5.93 / 4.83                  | all ≥ 4.5:1                          |
| `warning` on Mac `surface` `#24211E` / `selected`, dark   | 7.05 / 5.68                         | non-text ≥ 3:1                       |
| `warning` on white / `bg` / `sidebar` / `selected`, light | 4.92 / 4.48 / 4.13 / 3.73           | non-text ≥ 3:1 (a glyph, never text) |
| `muted` loader on Mac `surface` / `selected`, dark        | 6.25 / 5.04                         | AA                                   |
| Mac `ink` / `muted` / `subtle` on `bg`, dark              | 15.67 / 7.26 / 4.84                 | AAA / AAA / AA                       |
| Mac `muted` / `subtle` on `surface`, dark                 | 6.43 / 4.29                         | AA / large and non-text only         |
| Mac `ink` / `muted` / `subtle` on `bg`, light             | 15.85 / 6.94 / 5.11                 | AAA / AAA / AA                       |
| Mac `muted` / `subtle` on `surface` (white), light        | 7.55 / 5.56                         | AAA / AA                             |
| Mac `muted` / `subtle` on `sidebar` / `selected`, light   | 6.41 / 4.73 and 5.75 / 4.24         | AA / AA and large (selected)         |
| quiet loader (`muted` at 70%) on `surface` / `selected`   | about 3.8 / 3.1 (dark), 3.7 (light) | non-text ≥ 3:1                       |

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

| Token      | Size / line | Weight   | Use                                                                                                                                                                             |
| ---------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display`  | 28 / 34     | 700      | Mobile screen titles only                                                                                                                                                       |
| `title`    | 20 / 26     | 600      | Window and sheet titles                                                                                                                                                         |
| `heading`  | 15 / 20     | 600      | Section headers, card headings                                                                                                                                                  |
| `body`     | 13 / 19     | 400      | Default text (desktop); 16/22 on mobile                                                                                                                                         |
| `reading`  | 15 / 24     | 400      | Agent text in the Mac transcript (§8.10). Job: the thing read for hours. 15 over 14 because a 880 column at 14pt set ~110 characters a line; 15/24 keeps the 1.6 rhythm and ~95 |
| `label`    | 13 / 18     | 550      | Session names, button labels                                                                                                                                                    |
| `meta`     | 11 / 15     | 400      | Meta lines: agent · state · age · ctx                                                                                                                                           |
| `footnote` | 12 / 16     | 400      | The transcript's own small line: a turn's footer, the running time (12 reads at arm's length where 11 does not; lists keep `meta`)                                              |
| `code`     | 12 / 18     | 400 mono | Paths, branches, diff lines                                                                                                                                                     |

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

| Token             | Duration  | Easing                             | Use                                                   |
| ----------------- | --------- | ---------------------------------- | ----------------------------------------------------- |
| `motion-quick`    | 120ms     | ease-out                           | Hover, press, toggles                                 |
| `motion-standard` | 200ms     | ease-out                           | Panel open/close, row insert/remove, sheet            |
| `motion-emphasis` | 320ms     | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` | A card arriving that needs you                        |
| Loader (working)  | 9 × 110ms | stepped, no easing                 | The dot-grid loader; frame 5 held under Reduce Motion |
| Loader (quiet)    | 3s loop   | stepped, 70% opacity               | A chat waiting on background tasks                    |
| Pulse (needs you) | 1.0s loop | ease-in-out                        | Duck only, never a list                               |

Rules:

- Rows entering or leaving the list animate height and opacity together at
  `motion-standard`; a row changing state cross-fades its dot, it does not move.
- Panels open from the duck (scale from its corner), and must not make the
  duck jump — the window grows around a fixed duck (see `CLAUDE.md`).
- **Pane toggles (workbench, §8.10):** the sidebar and the inspector open and close at `motion-standard` (200ms ease-out):
  the pane slides on its own edge at a fixed width (the window clips it, so its content never reflows mid-slide) and
  its toggle travels with that edge. Under Reduce Motion the pane crossfades and the toggle jumps.
- **Reduced motion:** the loader holds frame 5 and the pulses become still marks, the duck stops bobbing and
  switches sprite only, panels fade instead of scaling. All state must remain
  readable with zero motion.

The marketing website (`website/`) is a brand surface, not the app. There
motion may be expressive: scroll scenes, a WebGL backdrop, the duck pile.
It is still never the only carrier of meaning, and every scene has a
reduced-motion and no-JavaScript version that shows the same content still.

---

## 8. Components

### 8.1 Status mark

The mark occupies a fixed 28×16pt slot at the row's trailing edge, the age's place: the age shows when there is no mark. Marks are glyphs, after Conductor's own: **Working** is the matrix glyph (`MatrixActivity`, style `indicator`, `muted`, 24×12pt inside the slot; owner's decision, 2026-11-09, replacing the 3×3 dot-grid loader on rows). **The matrix glyph is the working mark on the running line, on chat tabs and on a working workspace row in the sidebar** (owner's correction 2026-11-09: the row's glyph was nearly invisible): the sidebar row and the running line use `WorkingGlyph`, the coarse `mark` style (cells about 5pt, 72% fill, full strength) in `ink`, 20×15pt in the row's 20pt icon column and 26×15pt on the line, so it holds non-text contrast ≥ 3:1 (§3.4) on `sidebar`, `selected` and `bg` in light and dark; a tab uses the finer `indicator` beside the title. The 3×3 dot-grid loader stays for busy buttons, tool rows, the background strip, Git and setup progress. Each chat tab also leads with its agent's own mark (`AgentMark`, 14pt) before the title, a still frame under Reduce Motion and while the window is inactive; the glyph is the Working mark only, never a field behind rows. A chat waiting only on background tasks shows the same glyph in its quiet variant. Sidebar rows are dense, after Conductor's (owner's decision, 2026-11-09): project header 28pt (10pt chevron in a 12pt column, 18pt artwork, 13pt semibold title, worktree count in `subtle` tabular `meta` in the slot), worktree and chat rows 28pt (38pt with a branch line), 16pt indent per level, 8pt side padding, `selected` at 75% and hover at 40%. **Approval and plan:** a 14pt `triangle-alert` in `warning`. **Question:** a 14pt `message-circle-question-mark` in `muted`. **Failed:** a 14pt `circle-x` in `negative`. **Unread:** an 8pt `done` dot, the only dot left. Never two marks in a slot, and a state change cross-fades in the same slot. Every mark has a tooltip and a VoiceOver label:

| Mark                                                        | Meaning                     | Tooltip / VoiceOver (exact)                                |
| ----------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| the matrix glyph (a still frame under Reduce Motion)        | a turn is running           | "Working"                                                  |
| the same glyph, quiet variant                               | only background tasks run   | "Waiting for background tasks"                             |
| amber `triangle-alert`                                      | an approval or a plan waits | "Waiting for your approval" / "Plan ready for your review" |
| grey `message-circle-question-mark`                         | a question waits on you     | "Waiting for your answer"                                  |
| red `circle-x`                                              | the turn failed             | "Failed"                                                   |
| blue dot, in the age's place, until opened                  | finished, not opened since  | "Finished, not opened yet"                                 |
| none (the age shows)                                        | finished and read, or idle  | VoiceOver reads "last active 12 minutes ago"               |
| folded project or workspace shows the highest-priority mark | same words, plus the count  | "Waiting for your approval, 2 chats"                       |

The words a person can still read are: Waiting for your approval, Waiting for your answer, Plan ready for your review, Working, Finished, not opened yet, Failed, and Offline (duck, footer, banner only). Search and notifications also use **Waiting**, **Unread**, **Working**, **Failed**. Old synonyms keep parsing in the search line (`needs you`, `blocked`, `question`, `done`, `finished`, `error`, `idle`) so nobody's habit breaks; they are not offered. "Idle", "done" and "needs you" are retired as shown words.

### 8.2 Session row

The atom of every list: the menu-bar panel, the workbench sidebar, the phone's home.

```
Payment retry logic              C   ●      ← title, one line; Conductor marker; mark or age
```

- The headline is the chat's own title; a chat with no title falls back to `repo · branch`. No state word, no agent, no repo on a Mac sidebar row (the tree already says the project and workspace).
- A row waiting on you, or finished and unread, has its title in `ink` semibold; every other title is regular `muted`; the selected row is `ink`.
- Mac rows are one line, 28pt; the chat's step lives in the live row inside the chat. The menu-bar panel's rows keep `repo · agent` and one line of the agent's words, with the same marks. **Phone** rows have one more line in muted footnote type: the ask for a chat waiting on you (the tool heading or the question), the failure reason for a failed one, and otherwise the agent's last words, one line. No state word, no agent name.
- **Conductor marker:** a chat Conductor holds carries Conductor's own app icon (the bundled `agent-conductor.png`, the one the iPhone uses), 14pt, after the title, tooltip "Conductor chat". Native chats carry none.
- **Every list is newest first by last activity** (a chat never moves because of its state). Folded rows (project, workspace) show the highest-priority mark inside instead of their age; expanded ones show their age. Ties are stable by title. The menu-bar panel is one such list, with no strip or section for what waits: a chat waiting on you opens as its answer card in its place. The Telegram radar keeps its section headings (Needs you, Working, Done, Error, Idle) with their glyphs; Telegram has no tooltip, so words are its only second signal.
- A row is a button: it opens the session's detail (app) or offers its actions (phone). Hover: `surface-raised`.
- **Search** (the dock): chips **Waiting**, **Unread**, **Working**, **Failed**, **Claude**, **Codex** and up to five projects; the line is read as filters (the four state words, `claude`, `codex`, `today`, `yesterday`, `this week`, `project:` / `in:`) and free words; legacy synonyms are accepted but not offered. **Waiting** opens the decision cards page, titled "Waiting for you", whose cards carry no state header either (§8.10).
- The chat header on the phone is title, then `project · workspace · +142 −38` in `muted`; no state word and no age. The live step shows above the composer, as on the Mac.
- **Motion means working**: the loader is the only thing in a list that moves.

- **Project chat list and matrix activity** (owner-approved, 2026-11-09):
  This direction supersedes the earlier glyph corrections below. The phone's
  project page uses a flat list with a project icon, large name, actual chat/workspace
  counts and project-scoped search. Each compact row retains its agent icon, title,
  preview/action and timestamp. Running activity sits at the trailing end of the
  secondary line, below the age; it never replaces agent identity or paints over text.
  Unread is title weight, with no separate attention section or status dots. Activity
  uses abstract square pixels in one shared Canvas renderer on iOS and macOS. Every
  glyph, small or large, has a vignette opacity fade to transparent on every edge;
  there is no visible inactive-cell lattice, enclosing tile or hard clipping boundary.
  Pixels remain crisp, and Reduce Motion holds a static frame. The phone's compact
  activity is monochrome (pure white in dark mode, pure black in light mode),
  independent of state colours. The trailing glyph is 104×26pt before Dynamic Type
  scaling (capped at 120×38pt), adding rows and columns rather than stretching pixels.
  Each project/chat identity seeds its own pixel pattern, speed, phase offset and
  4.2–6s rhythm, so stacked rows never share a global beat. Within one row, the
  heading, preview and matrix share that rhythm: a brighter white/black light
  crosses the letters, then blooms in the trailing pixels. A 4pt halo makes the
  text sweep visible; the base text remains at 84% opacity. It stops moving
  under Reduce Motion or when the Mac is unavailable.
  The main projects page uses the same trailing glyph and title lighting. Running
  projects and projects with unopened finished chats lead read, quiet projects;
  each group stays newest first and updates live. Finished chats remain bold until
  the chat is opened, including chats never opened on this phone. Opening only
  the project does not clear unread state. Projects slide into their new positions
  with a gentle spring (0.45s response, 0.9 damping); new rows also fade in with an
  8pt offset. Reduce Motion disables reordering movement.
  Mac workspace chat tabs use a separate 64×20pt monochrome matrix beside the
  title and provider marker while running, with the same vignette fade. The tab's
  activity never covers the title or replaces the provider identity.
  Workspace chat tabs never follow activity sorting: existing positions persist
  through refreshes, workspace switches and app relaunches. New chats append on the
  right, closed chats leave the strip, and dragging a chat onto another moves it
  before that tab. This ordering is independent of the live main projects inbox.
  Project-row vertical padding is 10pt; project chat rows use 8pt, keeping the
  richer activity treatment in a slightly more compact preview.

- **The phone's Home is the projects list** (owner's decision, 2026-11-08, after
  Happy; it began 2026-10-21 as group cards). The standalone app has no tab bar:
  one screen, the large title **Sessions**, the duck top left (§6.3) and, top
  right, one glass capsule holding **Usage** and **Settings** (Settings opens as
  a sheet; before iOS 26 the same two icons, flat). A host that embeds
  `SqueakRootView` keeps group cards and, with no bar of its own, a segmented switch to pick **Projects** (one card per
  repository) or **Status** (one card per mark that has chats in it, in
  priority order: Waiting for you, Failed, Unread, Working), over the same
  snapshot, so nothing waits on the network. A card is one neutral surface
  (12pt, a hairline, no shadow, no state fill) and stays short:
  - A **project row** (owner's decision, 2026-11-08): Projects is one flat
    list, no cards, one row per repository. A 52pt round project icon; the
    name and the newest chat's age; the newest chat's title in `muted`; the
    count in `subtle` ("3 chats", the active ones; it no longer counts states). The trailing slot is the project's mark by priority, else the age.
  - **The corner says what is new** (owner's decision, 2026-11-08, after Happy):
    the top-right corner of a project row and of a chat row is the time, or a
    mark in its place: the amber triangle or grey question bubble when the agent
    waits on you, a `done` blue dot when it answered and you have not looked. There is no "New replies"
    section; an unread chat stays on its project's row (even once it is older
    than the active window) until you open it. The mark's words are its tooltip,
    and VoiceOver hears them. Hairlines start at the text. The
    row opens the project, and a chat is opened from the project's own page;
    Home never opens a chat from this list.
  - A **status card**: the mark's heading, its mark (not under Waiting for you, which has
    its left edge and badge) and a count, then its first chats. A group of six
    or fewer opens **in place** (the header and **Show all N / Show less** are
    disclosure buttons, the chevron turns, VoiceOver hears expanded or
    collapsed), so a tap never lands on a nearly empty page. A longer group, and
    Waiting for you, whose one-tap answers are the reason to go there, open their own
    list under a compact bar.
  - A chat row: the agent's own app icon (Claude, Codex; a neutral tile for any
    other) with a Conductor badge when Conductor holds it, title and, in the trailing slot, the age or its mark
    (VoiceOver: "last active 12 minutes ago"), and one muted line: the ask for a chat waiting on you, the
    failure reason for a failed one, otherwise the agent's last words. No state word, no agent name.
    An approval that only the Mac can give says so; no button promises it. Each row is its own tap target.
  - One duck, in the header; never in a card. **Earlier** is a quiet card at the
    foot. Swipe actions live in the lists, not on Home.
  - **The dock** (owner's decision, 2026-11-08): at the foot, one 56pt glass
    capsule search field, "Search projects and chats…", with a 44pt round
    **New chat** beside it (only when the Mac can list workspaces). 16pt from
    each side, 8pt above the safe area, riding above the keyboard. A scrim from
    the screen's foot to the capsule's middle fades into the list so nothing
    reads through it, and the list scrolls clear of it. Typing replaces the list
    with every match, active chats then Earlier, each newest first. Focused and
    empty, a row of chips sits over the dock: **Waiting** (with its count; it
    opens the decision cards page, titled "Waiting for you"), **Unread**, **Working**, **Failed**,
    **Claude**, **Codex** and up to five projects, the newest first. A tapped
    chip becomes a removable token in that row (VoiceOver: "Working filter,
    removes this filter"), not text. The line is read as filters and words:
    the four state words (waiting, unread, working, failed) and their old synonyms (needs you, blocked, question; running; done, finished; error; idle), `claude` or `codex`,
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
- **Motion means working.** A chat that is working has the grey dot-grid loader
  in its trailing slot: Reduce Motion holds frame 5, and
  a Mac that has stopped answering gets a still one, because then "working"
  is only the last thing it said. Nothing else on Home moves.
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
- **New chat sheet: replaced (2026-11-11).** The sheet of cards is gone; starting work is three pages (§ "Create: New pond, New branch, New thread"): the sidebar's Create opens New pond, a pond's "+" opens New branch, a branch's "+" opens New thread. The model, thinking and first-message choices live on New thread.
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
- On the phone's Waiting for you page the card carries no edge or dot (the tab
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
`negative` square on `surface-raised`, Conductor's own Stop; the working
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

1. `🔴 repo · branch — waiting for your approval` (glyph, name, what it waits on)
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
12% tint of `negative` (with the Stop button and a destructive Deny, the only red besides failure), deliberately tinted, never saturated. File list first, one file's
patch second (as Telegram does today). Paths truncate from the start.

### 8.9 Buttons

| Kind        | Dark                                             | Light                                 | Use                                |
| ----------- | ------------------------------------------------ | ------------------------------------- | ---------------------------------- |
| Primary     | `duck` fill, `#18181B` text                      | `#18181B` fill, white text            | One per screen: Send, Start Squeak |
| Secondary   | `surface-raised` fill, `ink` text, `line` border | white fill, `ink` text, `line` border | Everything else                    |
| Quiet       | text only, `muted`                               | text only, `muted`                    | Tertiary: Read full message        |
| Destructive | `surface-raised` fill, `negative` text           | white fill, red text                  | Stop an agent, disconnect a device |

The duck-yellow primary is the brand's single loud control. On light
backgrounds the primary is ink-black instead, because yellow fails on white
(§3.4).

### 8.10 Workbench

The conversation window of Squeak for Mac. Mocks and renders: `.context/design/` (1440×900). Anything not covered by another section is defined here.

#### What it is

The conversation window becomes a **workbench**: where you work with agents, not only read them. Squeak's native chats and Conductor's chats live in one window.
Structure follows Conductor (sidebar → workspace sheet → inspector); transcript craft follows Happy (centred column, quiet tool previews, cards that stop you); colour, type, voice and the duck are Squeak's (§3–§6, §9). The principle is unchanged: **the duck carries the emotion, the interface carries the facts.**

#### Pane toggles

Each side pane owns its toggle (`PaneToggle` in SqueakMacCore). Open, the sidebar's toggle sits at the trailing edge of its 44pt top bar; Back and Forward form a pair just after the traffic lights. The inspector's toggle stays at its leading edge. Closed, the sidebar toggle sits after the traffic lights in the centre header and the inspector toggle at the far right. The left toggle follows the remembered sidebar width; the right follows the inspector edge. Both stay vertically centred in the same 44pt bar, with 28pt hit targets. One overlay draws them, using the same panel-left / panel-right glyphs, hover fill, tooltips, accessible labels and existing shortcuts. No shortcut is added.

#### Layout (design reference 1440×900; minimum 960×620)

```
┌ Sidebar 256 ┬ Centre (flex) ────────────────────────────┬ Inspector 320 ┐
│ lights/44   │ toolbar 44: crumb · branch · +/− · toggle │ tabs 44        │
│ New chat    │ chat tabs 36                              │ Changes        │
│ Search ⌘K   │ transcript, column ≤ 880 (bottom-anchored)│ Files          │
│ Tree        │ live row, background, queue, composer     │ Review …       │
│             │                                           │                │
│ footer 56   │                                           │                │
└─────────────┴───────────────────────────────────────────┴────────────────┘
```

- Panes are resizable: sidebar 200–360 (default 248), inspector 280–520 (default 320) (hairline drag handle, 4pt hit area, no visible grip: the hairline goes `line-strong` under the pointer or a drag, the cursor says resize, a double click restores the default; the width follows the drag from where it started, so nothing jumps). A wide pane yields so the centre keeps 420. Sidebar ⌘B, inspector ⌘⌥B; both collapse to zero. Widths are remembered across launches. **The inspector is closed by default**, so the column is the full 880 on a 1440 window; it opens on demand and stays as the person left it.
- **Reading column (workspace chat, owner 2026-11-09):** the transcript (messages, Thinking and tool rows, turn footers, the running line), the background strip and the composer share one centred column of at most **760pt** with a side inset of at least **32pt** (`Tokens.Workbench.readingColumnMax`/`readingInsetMin`): column = `min(760, available − 64)`, and a window wider than 824 grows the inset instead. The composer's edges are the transcript's. (Supersedes the 880/16 column below for the chat; diffs and terminal output are unchanged.)
- **Column:** `min(880, available − 32)`. With the inspector closed at 1440 it is 880; with both panes open it is ~840 and reaches 880 at ~1544. Transcript, background strip, queue and composer share one column. Diffs and terminal output fill the column's width, never wider.
- Grounds (Mac dark neutrals, §3.2): centre = `bg`; sidebar and inspector = `sidebar`; cards, composer, user bubbles = `surface`; popovers, sheets, approval cards = `surface-raised`; selected row/tab = `selected`. Light: centre `bg` (#FFFFFF), sidebar/inspector `sidebar` (#FAFAF9), cards `surface-raised` (white). Separation is **`line` hairlines**, never shadow inside the window (§5). Only the sheet and ⌘K palette float and use `shadow-float`.
- The transcript is **bottom-anchored** when longer than the viewport (newest at the composer, a 28pt fade at the top) and top-anchored when short.
- Window chrome: traffic lights sit in the sidebar's 44pt top row; the toolbar has no hairline of its own; the tab strip's bottom hairline is the only line under it.

#### Regions

##### Sidebar

Owner correction (2026-11-09): improve the current UI, ignoring the generated redesign concepts. Navigation has **projects → worktrees only**. Chats appear exclusively as workspace tabs after opening a worktree; worktrees never expand. Projects may collapse, newest first as before. The sidebar's search filters project/worktree names without inserting chat results.

- **Top:** native traffic lights and collapse control, then the duck and Squeak wordmark, **Home** (⇧⌘H) and **Create** (New pond; ⇧⌘N is New branch), Search projects, and Open project. **Job:** the two things you do from nowhere, go back to the overview and start work, sit above everything, one 28pt row each with its key quietly at the end. New workspace makes one in the only project at once, or asks which in a menu when there are several. Open project chooses a git repository through the native folder picker and registers it with the existing host; failures are shown plainly. Creating chats stays in the workspace's tab strip.
- **Projects:** Conductor's actual repository artwork (`repos.icon`, read-only), 24pt; a neutral letter tile when no supported artwork exists. Names are system 15pt semibold, 38pt rows. The project-row + creates a worktree using the existing flow; project settings remain in its context menu.
- **Worktrees:** a 15pt branch glyph, system 14pt name, optional 11pt branch on its own line. Rows are 34pt, or 44pt with a branch line. Selection uses the existing neutral selected surface. Clicking opens its chat (keeps the current chat if it already belongs to that worktree, otherwise newest); an empty native worktree opens the New chat form scoped to it. Setup/run/archive context menus remain available.
- **Pins, read and diff stat:** **Job:** keep the few workspaces you live in on top and see which have work on disk without opening them. A pinned workspace sits first in its project (a `pin` glyph, `subtle`); otherwise rows stay newest first, and pinning is the person's choice, never a state. A workspace row shows `+n −n` (`working` green, `negative` red, tabular 11pt) once its diff has been read, which is when its chat has been opened; rows nobody looked at are not polled. **P** pins and **R** marks read or unread on a focused row (click it to focus), also in its context menu; "unread" puts back the single blue dot of a finished turn. Squeak's own marks stay: no coloured status per workspace.
- **Activity in navigation:** no colored state dots or waiting badges. Running uses the small glyph field; finished unread uses semibold text. Setup failure retains its actionable failure glyph. Existing approval/question handling stays inside the conversation, with its existing semantics.
- **Footer:** connection control (This Mac while connected), Usage and Settings. Brand is no longer duplicated here.

##### Dashboard (⇧⌘H)

The single overview replaces the separate Home row. The sidebar offers Dashboard, Create and Search.
Dashboard combines resuming work with a kanban board of observed workspaces across projects:
**Needs you**, **In progress**, **Done**, **Idle**. Waiting or recently failed chats place a workspace in
Needs you; otherwise running work takes precedence over finished work, then idle. A card opens the chat
responsible for its column. Dead agents are not shown as running or waiting. Columns are driven by actual
agent state; there is no manual state-changing drag operation.

The header's **Continue last workspace** returns to the last visited chat, or the newest available one.
A local filter searches project, workspace, branch and chat title. All observed workspaces are included;
the old fourteen-item cutoff is gone. Pins come first within a column, then newest activity. Cards show
project, chat title, available agent preview, branch, chat count and the shared status mark. Every column
has its own vertical scroll and empty state. At narrow window sizes the board scrolls horizontally,
keeping cards at least 220pt wide and headings readable. Light and dark use the workbench tokens.

##### Toolbar and chat tabs

- Toolbar: `project / workspace`, branch chip (mono), then the workspace's diffstat (`+142 −38 · 6 files`, tabular, `working` green and `negative` red as in §8.8), **Open in ▾** (quiet), inspector toggle.
- Running tabs carry a clipped, faint blurred field of moving monospaced glyphs behind the sharp title, with no spinner. Only running tabs instantiate the animation timeline (12 fps); Reduce Motion holds a static frame. Finished unread titles are semibold. No navigation state marks are added beside tab titles.
- Tabs = the workspace's chats (⌘T new, ⌃Tab next). **Close and reopen:** **Job:** a workspace with many chats should not be a wall of tabs, and a closed one should not be lost. A tab's context menu has **Close tab**, which only hides it from the strip (the chat is untouched and stays in Conductor or the host), and **⇧⌘T** brings the last closed one back, newest first. The last tab cannot be closed; a chat opened from the sidebar or a notification shows again. ⌘W stays the window's, as macOS means it. **Split view (⌘D) is not built:** two live chats need a chat model per pane, and the window holds one open chat's messages, activity and draft; see §13. 28pt tabs in a 36 strip, max 260 wide: title, Conductor marker, trailing slot. The active tab keeps its existing selection surface. No sidebar chat list duplicates these tabs. Selected tab = `selected`.

##### Transcript (reading size `reading`, 15/24; `body` 13/19 stays for lists)

| Element       | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User message  | **Job:** show what you said, apart from what the agent said, without avatars. Right-aligned `surface` bubble, `line` border, radius 16 with the corner on your side (bottom trailing) tightened to 6 so it points at the speaker, max 80% of the column, `reading` 15/24 in `ink` (sized by the centered row's proposed width, never the ScrollView viewport); under it `meta` right: time and delivery ("14:02 · Read by Claude", §8.5). 16, not `radius-card` 12: a bubble is a speech shape, a card is a container, and the two should not look alike. |
| Agent text    | no bubble, `ink`, 15/24, markdown; inline code = `selected` chip, mono 12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Thinking      | **Job:** let you see the model's reasoning without it competing with the answer. One muted row: chevron, brain icon, "Thought for 8s" (the time says more than the bare word "Thinking"). Open: the summary in `muted`, upright 14/21 (italic is hard to read at length), behind a 1pt `line-strong` rule. Live: "Thinking…" open, following the newest summary. Default closed once finished.                                                                                                                                                            |
| Tool call     | **Job:** one glance says what the agent touched, and a click shows it. One 28pt row: Lucide icon 14, verb (`muted`, 56pt column so the targets line up), the target in mono inside a `selected` chip, the same chip as inline code (paths truncate from the **start**), right meta (`+18 −2`, `212 lines`, `6s`), chevron. A started subagent says "Agent". Click expands; hover recolours. Running: the loader before the time. Several steps between two messages fold to "Worked · 6 steps" (tap opens).                                               |
| Expanded Edit | file header (path, `+/−`) then the **inline diff**: mono `code`, 12/18, line numbers `subtle`, added on a 12% tint of `working`, removed on 12% of `negative` (§8.8), hunk header `subtle`. Never shows more than 14 lines before "Show all" (inspector holds the whole thing).                                                                                                                                                                                                                                                                           |
| Expanded Run  | `$ command` in `ink`, output tail in `muted`, ✓ in `working`; tail only while running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Live row      | in the dock, not the transcript: `<loader> <step> · <elapsed>` ("Editing store.test.ts · 1m 12s", "Thinking · 40s", "Running tests · 6s", "Waiting on 2 workers · 2m"), 32pt, the elapsed time in mono `footnote`, right: `⌘.` to stop. Always reserved while a turn runs, above the background strip, so the transcript and composer can never clip it. The same string the phone shows; no model name, no "Claude is working".                                                                                                                          |
| Turn footer   | **Job:** how long it took and when, and Copy, without a banner. Under the last agent message of every finished turn (not the one still running): `footnote` `subtle` "1m 19s · 4:03 PM" (elapsed from your message to its last, then the time of day; either is left out when unknown), a Copy button (this message) and a ⋯ menu (Copy whole turn), both `muted` 14pt icons in 24pt targets. Always shown, quiet, 24pt reserved, so nothing jumps. Plain "1m 19s", not "1m, 19s": Squeak's elapsed words never take a comma (§9).                        |
| Turn end      | no banner; the live row goes away and the chat's mark in the sidebar becomes the blue dot (unless it is the open chat).                                                                                                                                                                                                                                                                                                                                                                                                                                   |

##### Cards that need you

One anatomy, no state header: `surface-raised`, `radius-card`, `line` border, a 3pt left edge, `warning` for an approval or a plan and `subtle` for a question (no dot, no pulse; the edge is the only thing that marks "this one is waiting for you" in a long transcript); a failed chat has no card. First row: the card's own title (`heading`) and, at the right, the kind chip when there is one (the tool name in mono); then body, reason, action row. They arrive at `motion-emphasis`, in place at the end of the transcript, **without scrolling the user away** if they are reading up (a pill "Waiting for you ↓" appears instead).

| Card              | Title                                                                                        | Body                                                                                                                                                                                          | Actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool approval** | the plain-words sentence ("Run a command that deletes a folder"), the tool chip at the right | the command/path in a mono block, Claude's stated reason quoted                                                                                                                               | **Allow once** `↵` (the one `duck` primary on screen), **Allow for this chat** `⌘↵` (secondary; a Squeak chat's tool approval only, never on a plan or a question or a Conductor chat; the host keeps an allow rule, listed and removable under Rules in the inspector; an older host answers "Update Squeak's service to allow for the whole chat"), **Deny** `⌫` (destructive style, right-aligned, apart from Allow). The bare keys work only while the composer is empty or focus is outside a text field; with words in the composer ↵ = deny with that reason, and the ⌘ forms (`⌘↵`, `⌘⌫`) still work. |
| **Plan**          | "Claude's plan", then the plan's title in `muted`                                            | numbered steps (13.5/20), files-touched chips, "Approving switches to Accept edits"                                                                                                           | **Approve plan** `↵` (primary; `⌘↵` and `⌘⇧↵` too), **Keep planning** `⌫` (secondary; with words typed it sends them as the note)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Question**      | the question                                                                                 | options as full rows: letter in a `radius-chip` square, title, `recommended` in `muted` (not pre-selected, §8.4), bare `1–9` shortcuts (`⌘1–9` too) under the same composer rule, `0` = Other | none; a choice sends. Multiple questions: ←/→.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

After an answer the card collapses to a receipt line (`✓ Allowed once · 14:06`, `✓ Plan approved`, `✓ Answered B`), not tappable again, and the left edge goes. A tool approval that Squeak cannot give (Conductor chat, Mac-only) says so and offers no button (§8.2); its title is "Waiting for your approval".
Only one primary on screen at a time: while a card is up, **the duck primary moves to Allow once / Approve plan and Send is disabled**; it moves back when the card is answered.

##### Dock: background work, queue, composer

- **Live row** (32pt, only while a turn runs; see Transcript), then the **background strip** (30pt, only while something runs): "Background" + one chip per subagent/shell (its mark: the loader, `circle-x`, or a `subtle` `circle-check` once finished; name, what, age) + chevron. Details open under the strip.
- **Queue** (§8.5, unchanged rules): oldest first under "Queued · Claude reads it after this turn"; each card: text in two lines, **Steer** (secondary: Codex takes it into the turn; Claude's turn is interrupted and it starts next), ⋯ (Edit, Delete). Keys on a focused card: `E` edit, `⌫` delete, `↵` steer.
- **Composer:** `surface`, `line-strong` border, `radius-card`, 14/22 field, then a control row in the order the work goes: attach (paperclip), **model**, **effort**, **mode chip** (Ask, Accept edits, Plan, Skip approvals: the plan toggle is one of its four, ⇧Tab), space, `ctx 62%` (tabular), dictate, **Send / Queue / Stop** (30pt round). **Job:** left to right is what you choose before you send, ending at the one button that sends. A Fast toggle is not shown: Squeak's hosts have no such mode to switch. The queue sits above the composer as before (below). Glass is allowed here on macOS 26 (§5); the mock shows the opaque fallback.
- **State-aware placeholder:**
  | State | Placeholder | Round button |
  |---|---|---|
  | idle | `Message Claude in mallard` | Send (duck) |
  | working | `Add a follow-up. Claude reads it after this turn` | Stop (`negative` square on `surface-raised`) when empty; **Queue** once typed; ↵ queues, ⌘↵ = Steer (hint `↵ queue · ⌘↵ steer`) |
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
- **Model picker** (⌘/): Conductor's catalogue as the Mac lists it, favourites first, filter field, "More models". **Effort** (⇧⌘E cycles): the levels the model takes. Changing either mid-turn applies next turn; the chip says so in its tooltip.
- **Attachments:** paperclip or drop or paste; a tray of thumbnails (x on each) above the field; same `.context/attachments/<id>/` rule as the phone (§8.5). Long pasted text becomes an attachment chip.
- `/` opens slash commands (`/clear`, `/compact`, `/restart`, plus skills), `@` mentions files.

##### Terminal panel (⌘J)

A built-in terminal like Conductor's, at the **bottom of the centre column** (under the chat, full column width); the toolbar's terminal icon and ⌘J toggle it, closed by default and remembered.

- **Size:** a hairline drag handle on the top edge (same rules as the pane handles, resize up/down cursor, double click restores 240); height 120pt to 60% of the column, remembered. Panes and chat keep their place above it.
- **Tabs:** a 32pt strip (the chat tabs' look, 24pt tabs, `selected` fill): the shell's own title (else the shell's name, `zsh 2` for later ones), a × on the selected or hovered tab, **+** and a hide ×. ⌘T while the terminal has focus adds one, ⌘K clears it (screen and scrollback); both keep their other meaning (new chat, search) anywhere else. Closing a tab ends its shell; only when a process other than the shell holds the terminal does it ask ("Stop what is running here?", names the process).
- **One terminal per workspace** (its folder), kept alive while the app runs: switching chats of the same workspace keeps it, another workspace gets its own, and hiding the panel hides it only. A shell that exits takes its tab. Shells end with the app (their process groups get SIGHUP on quit); Cmd-Q, which only closes windows, leaves them running.
- **Unavailable:** a chat with no local folder (or whose folder is gone) shows the panel with one line saying why.
- **Shell:** the login shell (`$SHELL`, else `/bin/zsh`, `-l`) in the chat's folder, `TERM=xterm-256color`; SwiftTerm (MIT, credited in `THIRD-PARTY-NOTICES.md`), 10,000 lines of scrollback, copy/paste and selection as macOS does them, links open with ⌘-click, the system cursor and blink.
- **One colour for the right panel (owner 2026-11-09):** the inspector's upper part (tab row, filter field, All files / Changes / Review lists, the review tray) and its lower part (terminal tab row and the terminal) are all `bg`, the terminal's own ground (`terminal` background = `bg` in dark and light); the old `sidebar` tint is gone from the panel. Dividers stay one 1pt `line`.
- **Look:** ground = `bg`, a 8pt inset; JetBrains Mono 12pt (bundled; `mono` falls back to the system face); colours are the `terminal-*` tokens (§11), the warm neutrals with Conductor's hue order. Dark and light follow the window.

##### Right panel: the Pond panel and the Code view (owner 2026-11-10)

Squeak is a place to see who is working and what needs you, not a code editor, so the right panel opens on the **Pond panel** and the code tools sit behind a **Code** button. The top bar's two words, **Pond** and **Code** (14pt, `selected` fill on the current one), switch between them; ⌥⌘C does the same from anywhere (it also opens a closed panel on Code). The choice is remembered by the window. Opening a diff tab, a tab shortcut (⌥⌘1–3) or "What changed" switches to Code by itself; closing the panel and reopening it keeps the last view.

The Pond panel, top to bottom, is soft cards on `surface` with no borders and no mono chips; a section with nothing to show is left out, never an empty heading:

- **Who's here.** The Flock in this pond: you (a coloured initial) and the open thread's agent (its own mark and model). Only people the Mac knows are shown; nobody is invented. When the project is in a pond (the host's pond routes answer) it lists the real Flock instead: online dot, "Typing" or "Viewing <thread>", role and Nest, then the open thread's agent.
- **This thread.** Who started it, the nest it runs on ("This Mac"), agent and model, how long it has worked or when it finished, and its state mark.
- **Needs you.** Every question or approval waiting in this pond, newest first. The open thread's own card answers inline with the same decision, question and approval cards as the chat; another thread's waiting shows as a row that opens it. An owner's join requests head the list, each with Approve and Deny.
- **Other threads in this pond.** The pond's other threads, newest first, with their marks; a click opens one in the centre.
- **Ripples.** Recent activity as short sentences with a relative time, newest first, at most 20: a thread started, finished, failed or needs you, a pull request opened or merged, files changed, and the pond's own Ripples (who started, joined, finished). Only what Squeak already knows, and nothing without a time.
- **What changed.** One plain line ("Changed 4 files, +120 −30"); it opens the Code view on Changes.

The Code view is the inspector as before: the upper All files, Changes and Review tabs and the lower Setup, Run and Terminal part (⌘J).

##### Pond home, the sheets and a member's thread (2026-11-10)

On for everyone (`docs/ponds.md`; `SQUEAK_FLOTILLA=off` is the off switch). Every project is a pond from the moment it exists; one only this Mac can see is a local pond and shows the same page with one quiet line, "Only this Mac can see this pond until you invite someone." **Invite** is the only step to share it (signed out of the Squeak account it signs in first; with no cloud it says so in a sentence). With the routes absent (the switch off, an older host) a project row folds its threads as before.

**Pond home.** Clicking a project row in the sidebar opens its home in the centre, not a chat; a small chevron at the row's right (beside "+") folds and unfolds its threads. A project's home works whether or not it is in a pond. Top to bottom, soft `surface` cards on `bg`, no borders, a 820pt column:

- **Header.** The pond's tile (its first letter), its name (20 semibold), "3 in the flock · 5 threads" or "Only on this Mac". Buttons: **Invite** (owner, secondary), **Share a thread** (a menu of this Mac's threads not yet in the pond, secondary), **Share this pond** (a project not yet in a pond, secondary), **Start a thread** (primary, opens the New chat sheet).
- **Workspaces.** One soft card per workspace (worktree) of this project on this Mac: its name, its branch in mono and `muted` (left out when it only repeats the name), and the highest-priority state mark of its chats (§3 marks). Inside, its chats as rows, newest activity first (ties by title), the cards too (§"Recent on top"): the title, a `users` glyph on a shared one (a thread of the pond), the provider mark, the state mark (the sidebar's own: matrix glyph working, amber `triangle-alert` waiting, red `circle-x` failed, none when finished), the relative last activity, and at the right an **avatar stack** of who is in the chat: you alone on an unshared chat; on a shared thread its participants (you first, then the others by last activity, at most four and "+N"). An avatar of someone viewing or typing in the chat right now carries the duck ring (2pt, the accent; nothing else rings here). A row opens that chat, as the sidebar does. Threads other Macs run, which this Mac does not host, sit in the card whose branch (else workspace name) they name, with their state mark and no local mark; those that name none go in a card titled **From the flock**. A failed thread is Done, never Needs you. The "No threads yet" line shows only when there are no workspaces and no flock threads either.
- **Flock.** One card per person in an adaptive grid: a coloured initial, a green online dot, name ("(you)" on yours), and one line: "Typing", "Viewing <thread>", "Online" or "Away", then role (not "Member"), Nest and "N chats" (how many chats they are in). An owner gets a `…` menu on others with **Remove from pond…**, which asks first: "The pond's key changes, so they can't read anything new."
- **Join requests** (an owner's) head the page above Workspaces as a Needs you group, each a card: "<name> wants to join", the role, **Deny** and **Approve**.
- **Ripples.** The pond's activity, one short sentence and a relative time per line, newest first.

**Sheets** (440pt, `surface`): **Share this pond** (the project becomes a pond; you are its owner), **Invite** (a Member or Viewer picker with what each can do, then a code in mono with a visible **Copy** that turns to "Copied", and "Expires in 59 min · joins as member"), **Join a pond** (from Create: paste the code, your name, **Ask to join**, then "Waiting for the owner to approve" with the matrix glyph, and "You're in <pond>" with **Open** once approved).

**A thread from someone else** opens in the centre as the normal transcript (messages, thinking and tool rows, "Changed 4 files, +120 −30"), driven by the host's events: read again from the last `seq` whenever the pond's stream says it changed, plus a minute's safety read. Each message of the Flock carries the sender's name above it. The composer is the chat's: ↵ queues, ⌘↵ steers, hinted under the box while the agent works; a Viewer's is disabled ("Viewers can watch, not message"); a line above it says who is typing. A question's card shows options and an Answer field; typing holds the question and everyone else sees "Aarav is answering" and cannot answer until it lapses (30 s, renewed while typing). **An approval is shown, never answerable**: an amber `triangle-alert`, the action, and "Waiting for Aarav to approve" (the starter approves on their own Mac). **There is no stop control**, and no Stop shortcut works here. The thread's starter has a **Private** switch in the header; others see who else is looking (small avatars).

**Colour on Pond surfaces (a separate pass, 2026-11-10; drop it and the surfaces fall back to the neutrals above).** Duck yellow is the accent and only that: the **selected pond** (a 3pt bar at its sidebar row's edge), the **primary buttons** on Pond surfaces (duck fill, ink label, 12.90:1, in light and dark; elsewhere §8.9's primary is unchanged) and **your avatar's ring** (2pt). The accent is `duck` on dark and `duck-text` on light, because `duck` on a light ground is 1.37:1 and a bar or ring has to be seen (§3.4); duck is never a state, a warning or a count. Each pond has a **soft tint** derived from its id (FNV-1a hue, saturation .28 and brightness .96 in light, .40 and .30 in dark, never in the duck's hue band 25 to 75), on its sidebar icon and on its home's header card; `ink` on every tint is at least 4.5:1 (tested for 400 ids). People are **avatars**, not mono icons: a soft disc of one of six hues (none a state colour), the initial in `ink`. Pond surfaces use soft `surface` cards and no borders.

##### Inspector (⌘⌥B)

Tabs, in order: **All files**, **Changes**, **Checks**, **Review**, **Setup**, **Run** (a scrolling strip when the pane is narrow). **Job:** a workspace's tools sit beside the chat, one tab each, so nothing needs a sheet. Checks, Setup and Run are for a chat Squeak runs (a Conductor chat has the other three). The inspector opens at 30% of the room beside the sidebar (the centre keeps 70%, minimum 420), 280–560 once dragged. Shortcuts ⌘⌥1…6 follow the order. There is no Activity tab (removed in phase 2): the steps are the transcript's own tool rows and the live row, background work is the strip above the composer, a waiting chat says so in its card, and Rules moved to the chat's header (below). Squeak's marks stay.

- **Checks:** the old PR tab, renamed for what you look at: "Pull request #9", its chip, the checks mark, the mergeable line, branch line and actions.
- **Review:** the diff comments waiting to go to the chat (each with its file and line, removable), **Send to chat** and Clear; empty, it says where comments come from.
- **Setup:** the workspace's setup log inline (mono, selectable), following a setup in progress; replaces opening a sheet for the common look.
- **Run:** Running / Not running, its port, **Run / Stop**, **Open localhost** and the tail of the run script's output.
- Not yet (no content in Squeak): **Artifacts**, **Browser**.

- **Background strip:** one chevron. Collapsed: one 32pt line, the `layers` icon, "Background", a summary ("1 subagent · ended", "2 subagents, 1 shell · 1 running") and, with one or two tasks, a chip each. Expanded: that header, then one list, a row per task: kind icon, title, status mark (loader, `circle-check` `subtle`, `circle-x` `negative`), time, and a chevron that opens a subagent's steps; no chips and no second header.
- **Changes:** "6 files · +142 −38 · vs master"; file rows (status letter M/A/D, path truncated from the start, `+/−`); one file's diff open under its row; Squeak's rule stands: diff against the base branch **including untracked files** (§CLAUDE). No commit/PR buttons here (they are the header's and the PR tab's). **Review comments:** in an open diff the line-number gutter shows a `plus` on hover; a click opens a comment box under the line (shift-click another line extends it to a range; Return adds it, Esc cancels). A saved comment sits under its last line in a `surface-raised` card with a remove `x`, and the gutter shows `message-square` there. Comments collect in a **tray** pinned under the file list (`N review comments`, chevron to list them, Clear, **Send to chat**, the one primary in the tab). Send makes one message, `Review comments on your changes:` then for each `path:line` (a range `12-14`, a removed line `12 (removed)`), the quoted code as `> ` lines (8 lines and 200 characters at most) and the comment, and sends it through the chat's normal reply path (a Squeak chat or a Conductor chat alike; queued behind a working turn, the composer's own draft untouched). The tray clears only when the send was accepted; a refusal is shown in its own sentence and the comments stay.
- **Rules** (the chat's header, a Squeak chat only): **Job:** see and take back what "Allow for this chat" keeps, where the chat is, not in a side tab. A `shield` button (with the count when there are any) opens a popover "Rules": each rule (a tool by name, an exact command, a command prefix) with a remove button; hidden when the host has no rules route.
- **PR** (a Squeak chat only; Conductor's "PR status"): "Pull request #9" and a chip with the PR's own word (Draft, Open, Merged, Closed, nothing else), the checks as a mark (`circle-check` `subtle`, `circle-x` `negative`, the loader; words in the tooltip, none when there are no checks), the mergeable line as a sentence ("No conflicts with master."), the branch line (`ahead/behind · uncommitted · vs base`), then the primary action (secondary button), the other enabled actions as quiet buttons and "Open PR in browser". Without a PR: "This branch has no pull request." and Create PR. Refreshes like Changes (10 s while visible).
- **Files:** for a chat with a local folder, a file browser: a filter field (with a ⋯ menu: Show ignored, Refresh) over the workspace tree, read lazily (a folder is listed when first opened). Folders first, then names (case-insensitive); `.git` is never listed and `.gitignore`d entries only with Show ignored (then in `subtle`). Rows are 24pt: chevron, `folder`/`file-text` icon, name (`body`), and at the right a changed file's status letter (M/A/D/R, as in Changes) or a small `muted` dot on a folder that holds one. Typing in the filter replaces the tree with a flat list of matching paths (every word, anywhere in the path, name matches first); Return opens the first. A chat with no folder on this Mac keeps the changed-files list. **Viewer:** a click opens the file in the centre as a tab in the chat tab strip, after the chats and a hairline: `file-text`, the name in mono, a `muted` dot while edited, a close `x`. It replaces the transcript until a chat tab (or another chat) is chosen; the open files stay. Header: the path (mono, truncated from the start), **Edit**/**Done**, **Save** (⌘S, primary while there are edits), open in the default app. Read-only: JetBrains Mono 12 on `bg`, line numbers in `subtle`, no wrapping, no syntax colour (a grammar per language is not worth it); Edit makes the same view editable. A save is **refused if the file changed on disk since it was opened** (a banner: "This file changed on disk since you opened it." with **Reload**, and **Overwrite** while there are edits); a file nobody edited here follows the disk by itself, an edited one is flagged. Closing a tab with edits asks "Save changes to X?" (Save / Don't save / Cancel). Images (up to 25 MB) are shown; a file over 2 MB or a binary one opens in its default app instead, with a line under the tree saying why. Paths never leave the workspace folder (no `..`, no symlink out). **Managing files:** a `plus` menu in the filter row, the tree background's and every row's context menu give New file / New folder (an inline name field in the tree), Rename (also Return on the selected row), Move to Trash (also ⌘⌫; never a permanent delete, a confirm names the item and, for a folder, how many items it holds; the workspace folder and `.git` are refused), Copy path / Copy full path and Reveal in Finder; a row drags into a folder to move it, and files dragged from Finder are copied in (a name clash adds " copy"). Names may not be empty, hold a slash, be `.`/`..`/`.git` or already exist, and no operation leaves the workspace (symlinks included); open tabs follow a rename or move, and an item with unsaved edits asks to save or discard first. A refusal is one calm `negative` line under the tree. The filter field's **Names / Contents** toggle switches to a search of the files' text (`git grep`, first 200 hits as file, line and snippet; a click opens the file at that line).
- **Background work** (formerly the Activity tab): subagents and shells are the chips of the strip above the composer (the same marks as a chat's, name, age, one line), opening their own steps beneath; finished ones stay 10 min with a `subtle` `circle-check` and the word "Finished", never "done" (matches `background-work.ts`).

##### Git and workspace lifecycle (a Squeak chat; the host does the work, `src/native/git-actions.ts`)

- **Header cluster**, in place of the branch chip: branch (mono), `↑2 ↓1` against the base (zeros left out), **one action that follows the state** and a ⋯ menu with all of them. No PR: **Create PR** (once there is something to put in one). PR open: **Resolve conflicts**, else **Fix errors** (failing checks), else **Commit & push** (uncommitted work), else **Merge**; a draft, running checks or a merge GitHub has not worked out have no button, the checks mark says it. Merged and closed are a quiet `muted` word. The action is a _secondary_ button: the composer's Send keeps the one duck primary. The menu lists Commit & push, Create PR, Fix errors, Resolve conflicts, Review, Merge (each disabled unless the state allows it) and Open PR in browser.
- An action sends its prompt (the project's own wording, else the default) to the chat as an ordinary message, so it shows as the person's message and queues behind a working turn. **Merge** asks first: a sheet "Merge #9?" naming the method (the project's: Squash and merge / Create a merge commit / Rebase and merge) and the base; the host refuses a draft, conflicts, failing checks, and the refusal is shown in the sheet in its own sentence.
- **Workspace row** (sidebar): a workspace still setting up shows the quiet loader in the age's slot, one whose setup failed the `circle-x` mark in `negative`, tooltips "Setting up" / "Setup failed"; a running run script adds its port (`:3010`, mono `subtle`). **Context menu:** Run / Stop run script, "Open localhost:<port>" while it runs, View setup log… (a sheet: the log in mono, a Copy button; follows a setup in progress), Archive workspace… A refusal is shown as a sentence; a workspace with uncommitted work is explained ("Archiving removes the folder and those changes with it") and offers **Archive anyway** only in a second dialog.
- **Pond settings** are a page in the workbench centre (project row's context menu → Pond settings…, or the gear beside Invite in the pond page's header), not a dialog. Top bar: a back button "← <pond name>" (Esc too) to the pond page, then the title "Pond settings". One column, 680 wide, saved as you change (no Save button; text fields save after a short pause and when you leave). Sections in soft `surface` cards: **Look** (icon, colour, labels), **Branches** (the base branch new branches start from, where branch folders go, branch prefix, merge method; each field shows where its value comes from, "from conductor.json" or "default", as the host reports it), **Scripts** (setup, run, archive), **Flock** (the pond page's member cards, with Invite), **Agents** (review model, the prompt for each action, routines, backlog) and **This Mac** (Show in Finder, Hide pond as a switch, and "Remove from Squeak…" with a confirmation that says its folder and files stay where they are; the host refuses with a plain sentence while a chat of the pond is working or waiting).

##### Create: New pond, New branch, New thread (replaces the New chat / New workspace sheet and the Create page, 2026-11-11)

Three separate, very simple pages in the workbench's centre, each one job. Nothing else sits on them: no project or branch pickers on New thread, no Conductor form (a Conductor chat is reached through its ticked workspace). Squeak's own are **threads**; "chat" is only Conductor's. Every field and button is one the host already answers: create project, clone, join a pond, make a branch from a base, a branch, a pull request or an issue, start a thread.

- **New pond** (the sidebar's top "Create"): title "New pond"; a name field; three large choices: "A folder on this Mac" (folder picker, the name fills from the folder), "Clone from GitHub" (URL field), "Join with an invite" (code field); one primary button "Create pond" (or "Join pond" for the invite choice). Nothing else.
- **New branch** (the "+" next to a pond): the pond shown as plain text at top; a "Branch name" field prefilled with a bird name (the host's duck-theme order, the first one the pond does not use); "Start from" showing the default branch, with a "Start from…" link opening a small menu: another branch / a pull request / an issue; one button "Create branch". On success the branch opens on New thread with the message box focused (an issue's suggested first message fills it). The pond's menu opens the same page with the choice already made, and the title says it: "New branch", "Open branch", "Open pull request", "New branch for issue"; where the name comes from the source (an opened branch, a pull request) the name field is hidden; everywhere else the typed name is the branch's exact name. The source is picked from a list, never typed blind: Open branch and "another branch" show a searchable list of the pond's branches (newest first; ones already open in a worktree are disabled and say "already open"; a small "Fetch" button refreshes from origin), a pull request or an issue a searchable list of "#number title · author · age". When GitHub is out of reach the list gives way to the host's one quiet reason line and a field to type a number. Loading and empty states are one quiet line each. A pond made from a folder or a clone takes the typed name as its display name.
- **New thread** (the "+" on a branch, ⌘N): just the message box, with the breadcrumb "pond › branch" above it; one chip row below: the agent and model chip (Claude or Codex, and the model), an "Options" chip folding presets, thinking, plan first, "Split the work" (Claude only, hidden for Codex: this model plans, a Code and a Run commands worker, each Same model or Sonnet/Haiku/Opus/Fable, write code and run commands) and attach image; ↵ starts (⇧↵ newline). Button and hint say "Start thread". It is ONE component (`NewThreadComposer`): the quick panel (QuickNewThread) and the menu-bar popup use it with a compact "pond › branch" picker replacing the breadcrumb, defaulting to the most recently active branch.

Tokens: the page title is `title` 26pt semibold, the column 560pt (720pt for New thread), fields and chips are `radius-control` on `surface-raised`, one `primary` button at the trailing edge of the last row; errors are one `negative` line with Report problem.

##### ⌘K palette (mock f)

640 wide, 120 from the top, `radius-panel`. Groups in fixed order: Chats, Workspaces, Actions (no "Needs you" group; chats newest first with the same marks; `waiting` etc. filter; each result newest first; typing filters and ranks by match, then recency). Each row: mark or icon, title, muted context, shortcut keycaps. `↵` open, `⌘↵` open in a new tab, `>` actions only, `@`/`#` not used. Same search grammar as the phone's dock where it applies (state words, `claude`/`codex`, `project:`).

#### Keyboard map (Conductor's where it exists; ⌘. is stop, as macOS means it)

| Area      | Action                                                | Keys                |
| --------- | ----------------------------------------------------- | ------------------- |
| General   | Palette · Settings · Shortcut list                    | ⌘K · ⌘, · ⌘⌥/       |
| Panes     | Sidebar · Inspector · Terminal                        | ⌘B · ⌥⌘B · ⌘J       |
| Panes     | Sidebar (alternate)                                   | ⌘\                  |
| Panes     | Code view or Pond panel (right panel)                 | ⌥⌘C                 |
| Panes     | Enter or leave full screen (the green light too)      | ⌃⌘F                 |
| Panes     | Zen mode (both side panes away; again restores)       | ⇧⌘.                 |
| Branch    | New chat · New branch                              | ⌘N · ⇧⌘N            |
| Branch    | Open session 1–9                                      | ⌘1–9                |
| Branch    | Dashboard                                             | ⇧⌘H                 |
| Branch    | Previous · next branch                             | ⌥⌘↑ · ⌥⌘↓           |
| Branch    | Pin · mark read or unread (focused sidebar row)       | P · R               |
| Chat tabs | New chat tab · reopen closed tab                      | ⌘T · ⇧⌘T            |
| Chat tabs | Close tab (⌘W closes the window)                      | ⇧⌘W                 |
| Chat tabs | Next · previous tab                                   | ⌃Tab · ⌃⇧Tab        |
| Chat tabs | View all changes (diff tab)                           | ⇧⌘G                 |
| Composer  | Send (idle) · queue (working) · newline               | ↵ · ↵ · ⇧↵          |
| Composer  | Steer into the running turn                           | ⌘↵                  |
| Composer  | Model picker · next thinking level · attach · dictate | ⌘/ · ⇧⌘E · ⌘U · ⇧⌘D |
| Composer  | Cycle permission mode                                 | ⇧Tab                |
| Chat      | Stop the turn                                         | ⌘.                  |
| Chat      | Next chat that needs you                              | ⌥⌘L                 |
| Chat      | Expand or fold every step                             | ⌃O                  |
| Composer  | Focus the message field                               | ⌘L                  |
| Chat      | Fork this chat at its latest message                  | ⌘⌥↵                 |
| Cards     | Allow once · allow for this chat · deny               | ↵ · ⌘↵ · ⌫ (⌘⌫)     |
| Cards     | Approve plan · keep planning                          | ↵ (⌘↵, ⌘⇧↵) · ⌫     |
| Cards     | Answer a question · other                             | 1–9 · 0             |
| Inspector | Tabs in order (All files … Run)                       | ⌘⌥1 … ⌘⌥6           |
| Git       | Create PR · commit & push                             | ⌘⇧P · ⌘⇧Y           |
| Git       | Merge · fix errors · review                           | ⌘⇧M · ⌘⇧X · ⌘⇧R     |
| Git       | Pull latest (a Squeak chat)                           | ⇧⌘L                 |
| Terminal  | New tab · clear (terminal focused)                    | ⌘T · ⌘K             |

⌘K is the palette (it no longer focuses the sidebar search: the palette's "Search chats" item does that); ⌘⌥/ opens the shortcut sheet, which lists every row of this table from one registry (only keys that are actually bound: the ones the window does not take yet, such as quick open and find in chat, are left out until they exist; a test fails if a chord is bound twice in one scope or is missing from this table). ⇧⌘D stays dictation and ⇧⌘/ is macOS's own Help search, so the diff tab is ⇧⌘G and the thinking level ⇧⌘E; ⌘N stays New chat and ⇧⌘N New branch (`ShortcutRegistry` in SqueakMacCore, the same list the palette's keycaps read). The palette also offers actions that would work now: Stop, Approve/Deny (Squeak's own chats), Commit and push and Create PR (a Squeak chat: the host's git actions, with their ⇧⌘Y / ⇧⌘P keys; a Conductor chat: Create PR types the request into the chat, no key), Copy branch name, Reveal folder, Open in Conductor.

Bare card keys work only when the composer is empty or no text field has focus (another field never gives them up); the ⌘ forms work wherever focus is. ⌘, and ⌘Q keep their meaning (§CLAUDE). Existing global shortcuts (peek, show/hide, double-tap Quick message) are untouched.

#### Motion

Uses the §7 tokens and nothing else. `motion-quick` hover/press/toggle; `motion-standard` pane open/close, row insert/remove, sheet, tool expand (height + opacity together); `motion-emphasis` a card that needs you arriving. The loader steps through nine frames of 110ms; the needs-you pulse (1.0s) is only the duck.
**Nothing jumps:** a row changing state cross-fades its mark in the same slot and never changes height (chat rows are 28pt in every state); reserved boxes for the live row, background strip, hint line and tab marks; hover and focus recolour, never move or resize; a streaming message grows only below its own start; the transcript follows new output only while you are at the bottom, otherwise it lets go and shows a "New" pill; a collapsing receipt does not shift what is above it. Reduced motion: the loader holds frame 5, the duck's pulse still, expands and sheets fade, everything readable with zero motion (§7, §10).

#### Tokens used

Brand: `duck` (the single primary: Send, or Allow/Approve while a card waits; Create), `duck-outline` (text on it), `duck-text` (unused on dark). Neutrals (Mac dark set, §3.2): `bg`, `sidebar`, `surface`, `surface-raised`, `selected`, `line`, `line-strong`, `ink`, `muted`, `subtle`. State: `warning`, `negative`, `done`, `idle` (`working` green only for diffs); the 28×16 mark slot (§8.1). Shape: `radius-panel` (sheet, palette), `radius-card` (cards, composer, bubbles), `radius-control` (rows, buttons, inputs, chips that act), `radius-chip` (tags), `radius-round` (dots, Send/Stop). Depth: `shadow-float` only on the sheet and palette. Motion: quick/standard/emphasis, the dot-grid loader, the needs-you pulse. Type: the system UI font (Figtree and Inter stay brand material, never in the app) and the new `reading` size for agent text; mono (JetBrains Mono in the mock, as the web fallback of `font-mono`; SF Mono in the app) for paths, commands, diffs, branch names; tabular numbers on every count and time. Icons: Lucide, 1.5 stroke, 14–16.

#### Borrowed, and deliberately different

| From         | Borrowed                                                                                                                                                               | Different here                                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conductor    | Sidebar tree of projects/workspaces/chats; chat tabs; right inspector (Changes/Files); ⌘K; its shortcut set; queue + steer; plan toggle on ⇧Tab; city-named workspaces | Birds, not cities; Squeak palette (not stone/rose); status = Squeak's four marks (the same shape idea as Conductor's icon, different colours); no groups, urgency is never sort order; the duck footer; Conductor's own icon marks its chats, none on native ones                       |
| Happy        | 880 column; one-line tool previews; collapsible thinking; approval/plan/question cards as transcript entries; single hover shape; "nothing jumps"                      | Cards keep an amber (approval, plan) or grey (question) left edge and put the one duck primary on Allow/Approve; glyph marks in the age's place, the dot-grid loader for working; no grey/teal; user bubbles right-aligned at ≤85% as on the phone; no monochrome black primary on dark |
| Squeak today | Reply composer rules, queue cards, receipts, diff tints, state rows, copy voice                                                                                        | Window becomes three panes; one newest-first list with marks, no groups; copy says agent/chat/waiting for you/working/finished/failed                                                                                                                                                   |

Voice: sentence case, no exclamation marks, no emoji, the live row names the step ("Editing store.test.ts · 1m 12s"), never "Claude is working", honest receipts ("Allowed once"), the duck never speaks.

**Zen mode** (⇧⌘.) hides both side panes and brings back what was open with the same key (**job:** read or write with nothing beside you). It is ⇧⌘., not ⌘.: ⌘. is Stop, as macOS means it. The **next-chat pill** ("Next unread ›", "Next waiting · 3") floats at the transcript's bottom right, above the composer and taking no room, while another chat needs you; one press (or ⌥⌘L) opens the next one that waits on you, else the next unread, after the open chat in sidebar order. Shortcuts that need a feature Squeak lacks are left out of the sheet until it exists: back and forward, theme toggle, zoom, quick open, search in files, add repository, archive, copy link, open-in, toggle edit mode, snippets, copy concise transcript, queued-message keys beyond the ones above, paste as paths. A Conductor chat that blocks inside Conductor shows its card read-only ("Answer in Conductor"), because Squeak cannot give that approval. The sheet and palette scrim is 45% black in dark and 28% ink in light.

---

### 8.11 Menu-bar popup

The popup follows the current Mac workbench: warm neutral surfaces, system type, fine
`line` separators and the same trailing `MarkSlot` glyphs. It is 400pt wide, grows with
its content up to 640pt, and fits shorter screens by scrolling the content between its
pinned header and footer. Reduce Transparency uses an opaque `sidebar` ground.

- **Header:** one 24pt brand duck and Squeak wordmark, compact actions, connection text,
  then flat Chats / Usage / Controls navigation with a single selected underline.
- **Chats:** quiet awake and usage links above one activity-ordered list (pins first).
  Rows show the chat title, `pond · branch · agent`, and one preview line when available.
  Only hover and an expanded answer gain a fill. Waiting questions disclose their choices
  in place when clicked; expanding never sends. The explicit option button sends its letter.
  Questions without quick choices open their chat. Pointer hover holds the existing row order.
- **Usage and Controls:** the same frame and theme; usage stays monochrome, settings
  remain grouped. Their fetching, delivery and system-control behavior stays shared with
  the main app.
- **Footer:** Open Squeak and Quick message stay visible on all three tabs. Quick message
  shows its active global shortcut (double-tap Control by default, ⌃⇧ Space while Input
  Monitoring is unavailable), or no hint when disabled. It adds no local binding; ⌘K
  remains the command palette shortcut.
  New chat (⌘N), search (⌘F on Chats), Settings (⌘,) and Escape retain keyboard access.
  Chat details and New chat use the same inset, surfaces and button styles.

## 9. Voice and copy

### Vocabulary

Use these words, consistently, everywhere:

| Say                 | Means                                                                                                                   | Don't say                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **agent**           | Claude, Codex or another model doing work                                                                               | bot, AI, assistant                      |
| **thread**          | one agent on one task: what the sidebar lists (a Conductor one is a chat)                                               | job, task                               |
| **session**         | the same thing in logs and the daemon's own words; people see "thread"                                                  | job, task                               |
| **Pond**            | the container for threads: every project is one, local until you invite someone                                         | project (in the Mac app), room, channel |
| **Flock**           | a pond's members: people and their agents                                                                               | users, team                             |
| **Egg**             | an idea or task in a pond not started yet; starting it hatches it into a thread (a name only; the control says "Start") | draft, prompt                           |
| **Nest**            | the machine an agent runs on ("This Mac")                                                                               | host, server                            |
| **Ripples**         | a pond's activity feed                                                                                                  | log, history                            |
| **Quack**           | a notification                                                                                                          | alert, ping                             |
| **branch**          | a pond's own folder of work (a git worktree); "workspace" only for Conductor's                                           | workspace (in Squeak's UI)              |
| **chat**            | a session that lives in Conductor                                                                                       | conversation                            |
| **waiting for you** | blocked on an approval, a plan or an answer (tooltip, notification, search: "Waiting")                                  | needs you, action required              |
| **working**         | mid-turn right now                                                                                                      | running, processing, busy               |
| **finished**        | turn ended and you have not opened it ("Finished, not opened yet", "Unread" in search)                                  | done, completed                         |
| **failed**          | the turn ended in an error                                                                                              | error, crashed                          |

Lists show marks, not these words (the loader, an amber triangle, a question bubble, a red circle-x, a blue dot; §8.1); the words are the tooltip and VoiceOver, and the one added sentence is "Waiting for background tasks". "Idle" is not shown. Examples: Telegram and notifications `🔴 orchard · irrigation — waiting for your approval`; `✅ squeak · session-hub — finished`.

**Branch** is what a person sees where the code says workspace: a branch's own folder (a git worktree). "Workspace" is never said in Squeak's own UI; it stays in code, in this glossary, and for Conductor's own workspaces, which keep their name. The Mac sidebar's section is **Ponds**, the Create row opens **New pond** (a folder, a GitHub clone, an invite), the app menu's item **Open folder as pond…**. Playful words are names, never the only label: the Pond panel's controls say what they do ("Open in Code", "Answer"), and the Pond, Flock, Nest, Ripples and Quack only head sections or name things. "Needs you" heads the Pond panel's section; a single thread's state is still "waiting for you".

### Rules

- **Lead with the fact.** "orchard · irrigation is waiting for your approval" — not "Heads up!
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

| Situation  | Yes                                                                                              | No                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Blocked    | `🔴 orchard · irrigation — waiting for your approval`                                            | `⚠️ ACTION REQUIRED: Agent awaiting permission!`             |
| Finished   | `✅ squeak · session-hub — finished` / `Fixed the stale finish detection.` / `_3 files changed_` | `🎉 Great news! Your agent completed its task successfully!` |
| Reply sent | `Sent B to orchard · irrigation in Conductor.`                                                   | `Your response has been submitted.`                          |
| Failure    | `The reply did not go through: claude exited (1).`                                               | `Oops, something went wrong. Please try again.`              |

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
- **Never colour alone.** Each mark has a distinct shape or motion, and its words in the tooltip and VoiceOver. With
  red/green colour blindness, "waiting for you" and "working" differ by shape
  and motion (a triangle or bubble vs the stepping loader), and failed is a circle-x, not a red triangle, by the tooltip and VoiceOver words, and
  waiting also raises the badge.
- **Targets:** 44×44pt minimum on mobile; 24×24px minimum on desktop.
- **Reduced motion** is fully supported (§7).
- **Screen readers:** every row reads as "orchard, irrigation-pull-to-refresh,
  Claude, working, 2 minutes ago". The duck is decorative (`aria-hidden`); its
  mood is announced as text ("3 agents working, 1 waiting for you").
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
  /* Squeak for Mac overrides the neutrals with the warm scale of §3.2: bg #1a1514, sidebar/surface #24211e, raised #2b2825,
     selected #34312f, ink #f2eeea, muted #aaa39d, subtle #8a837d (light: #f7f5f3 / #efece9 / #fff / #e4e0dc /
     #1f1a17 / #5a534e / #6e6761) */

  /* state — dark */
  --sq-negative: #f87171; /* was --sq-needs-you */
  --sq-warning: #e0a030; /* glyph stroke and card edge only (§3.1) */
  --sq-working: #22c55e; /* diffs only */
  --sq-done: #38bdf8;
  --sq-idle: #71717a;
  --sq-offline: #52525b;

  /* terminal panel (Mac, §8.10) — dark; ground is --sq-bg */
  --sq-terminal-fg: #e7e2dd; /* 14.1:1 */
  --sq-terminal-cursor: #e7e2dd;
  --sq-terminal-selection: #4a4643;
  --sq-terminal-black: #3a3735; /* a ground for TUIs, 1.5:1 on bg */
  --sq-terminal-red: #f87171;
  --sq-terminal-green: #4ade80;
  --sq-terminal-yellow: #e0b84a;
  --sq-terminal-blue: #6fa8f5;
  --sq-terminal-magenta: #d08af0;
  --sq-terminal-cyan: #4fcfe0;
  --sq-terminal-white: #c9c3bd;
  --sq-terminal-bright-black: #8a8480; /* 4.9:1 */
  --sq-terminal-bright-red: #fca5a5;
  --sq-terminal-bright-green: #86efac;
  --sq-terminal-bright-yellow: #f2d27a;
  --sq-terminal-bright-blue: #9cc4fa;
  --sq-terminal-bright-magenta: #e3b0f7;
  --sq-terminal-bright-cyan: #8be3ee;
  --sq-terminal-bright-white: #f4f4f5;
  /* every colour but black is at least 4.5:1 on its ground (pinned by TerminalPanelTests) */

  /* type */
  --sq-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  --sq-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;

  /* workbench layout (Mac, §8.10) */
  --sq-sidebar-width: 256px;
  --sq-inspector-width: 30%; /* of the room beside the sidebar until dragged; 280–560 */
  --sq-column-max: 880px;
  --sq-chat-row-height: 28px;
  --sq-mark-slot: 28px 16px;
  --sq-type-reading: 15px / 24px;
  --sq-type-footnote: 12px / 16px;
  --sq-user-bubble-radius: 16px; /* the bottom-trailing corner 6px */

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
    --sq-negative: #dc2626;
    --sq-warning: #a16207;
    --sq-working: #15803d;
    --sq-done: #0369a1;
    --sq-offline: #a1a1aa;

    /* terminal panel — light; ground is --sq-bg */
    --sq-terminal-fg: #2a2623;
    --sq-terminal-cursor: #2a2623;
    --sq-terminal-selection: #d4d4d8;
    --sq-terminal-black: #d4d4d8;
    --sq-terminal-red: #b91c1c;
    --sq-terminal-green: #15803d;
    --sq-terminal-yellow: #8a5a00;
    --sq-terminal-blue: #1d4ed8;
    --sq-terminal-magenta: #9333ea;
    --sq-terminal-cyan: #0e7490;
    --sq-terminal-white: #52525b;
    --sq-terminal-bright-black: #6b6560;
    --sq-terminal-bright-red: #a81818; /* brights are the bolder ink on a light ground */
    --sq-terminal-bright-green: #166534;
    --sq-terminal-bright-yellow: #7a4f00;
    --sq-terminal-bright-blue: #1e40af;
    --sq-terminal-bright-magenta: #7e22ce;
    --sq-terminal-bright-cyan: #155e75;
    --sq-terminal-bright-white: #18181b;
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
  "workbench": { "sidebar": 248, "inspector": 320, "column": 880, "chatRow": 28, "markSlot": [28, 16] },
  "radius": { "panel": 16, "card": 12, "control": 8, "chip": 6 },
  "space": [2, 4, 8, 12, 16, 24, 32, 48],
  "type": {
    "display": [28, 34, 700],
    "title": [20, 26, 600],
    "heading": [15, 20, 600],
    "body": [13, 19, 400],
    "reading": [15, 24, 400],
    "footnote": [12, 16, 400],
    "bodyMobile": [16, 22, 400],
    "label": [13, 18, 550],
    "meta": [11, 15, 400],
    "code": [12, 18, 400]
  },
  "motion": { "quick": 120, "standard": 200, "emphasis": 320, "spinWorking": 900, "pulseNeedsYou": 1000 }
}
```

---

## 12. Changes from what ships today

This guide deliberately changed a few things in the duck and cards. All of
them are applied (step 3): the duck's panel reads `tokens.css`, and the
Telegram glyphs follow §3.3.

| Where                      | Today                    | This guide               | Why                                                                                                                      |
| -------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `duck.css` `--duck`        | `#ffd23f`                | `#FCD02C`                | Match the sprite's actual yellow                                                                                         |
| `duck.css` `--beak`        | `#f97316`                | `#FC8830`                | Match the sprite                                                                                                         |
| Error mark                 | `#f59e0b` amber dot      | `circle-x` in `negative` | Amber is duck-family; since 2026-11-09 amber is `warning`, a thin glyph for approvals and plans only, and failure is red |
| Needs-you dot              | `#ef4444`                | `#F87171` (dark)         | Higher contrast on the dark panel (6.40 vs 4.71)                                                                         |
| Telegram "needs an answer" | 🟡                       | 🔴                       | Both blocked states are "needs you"; yellow is the duck's                                                                |
| Telegram error             | ❗                       | 🟣                       | Matches the violet error colour                                                                                          |
| Panel text colours         | hard-coded in `duck.css` | `--sq-*` tokens          | One source for every surface                                                                                             |

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

### Owner correction: iOS glyph parity (2026-11-09)

The phone uses the Mac's faint moving monospaced glyph field behind running project/chat titles, with sharp foreground text. A compact glyph strip replaces indefinite spinners throughout the phone (sending, loading chats and steps, settings actions, image loading). Determinate progress bars retain their real progress. Only busy/running views instantiate the 12 fps timeline; Reduce Motion and a non-answering Mac hold a static frame. Navigation rows use age and unread title weight rather than waiting/failure glyphs or unread dots; decision and failure content remains inside the chat, with unchanged reply/approval behavior. Static skeleton surfaces carry a faint glyph texture while fetching their content.

### iOS glyph legibility correction (2026-11-09)

Foreground loaders are a crisp three-character `{ / }` strip, at least 30×18pt, with a traveling 40–100% opacity wave (55–85% for the quiet variant). They never reuse the low-alpha background field. Running row fields use 12pt medium glyphs at 20–40% opacity and only 0.2pt blur, keeping labels sharp above them. Reduce Motion and stale Mac state hold a legible static frame. Checked against a native iPhone 17 simulator render, rather than judging visibility only from compilation.

### Matrix activity correction (2026-11-09)

Owner clarification supersedes the literal character treatments: activity is an abstract pixel matrix with falling heads, fading wakes and a crossing current. No letters, digits, punctuation or text drawing. Both apps use SqueakIcons.MatrixActivity so their motion cannot diverge. The compact indicator is a bright 9×5 cell matrix at least 34×20pt; title backgrounds use a softer grid at 6pt pitch. Only running/loading views instantiate the 15 fps timeline; Reduce Motion or stale connection holds one fixed pattern. Foreground text remains crisp.

### Owner correction: the workbench follows the target's look (2026-11-09)

The owner compared Squeak for Mac 2.16.0 with the app it should resemble (`.context/ref/`, `.context/UI-SPEC.md`) and found it far too different. Colour, proportions, sidebar style, functionality, arrangement and the right panel's tab modularity now follow it; Squeak keeps its name, duck, Lucide icons and its own marks (matrix working glyph, dot-grid loader, §3.3 state marks), and its own wording. This section supersedes the earlier §8.10 text where they differ.

- **Colour and material (§3.2, §11).** The workbench window is opaque: window `#141110`, sidebar and composer `#211E1C`, cards `#2C2826`, text `#EAE8E6` / `#A5A09C` / `#766F6B`, borders white 10%; light is `#FFFFFF`, `#FAFAF9`, text `#2C2826` / `#8E8885` / `#A5A09C`. No glass, no behind-window material, no navy tint; the Window appearance setting is removed. The menu-bar panel keeps `panel-glass` (it floats over the wallpaper; it is not the workbench). Diff add/remove `#4ADE80`/`#F87272` (light `#16A249`/`#DC2828`). Reading text is 14/23.
- **Sidebar (256).** Top bar: Back/Forward paired after the traffic-light clearance, with the sidebar toggle at the trailing edge (⌘[ ⌘], `NavHistory`). Under it a Mac row, "<first name>'s Mac" with a chevron and the duck as its small avatar; its menu holds connection, Usage and Settings. Then three plain rows, icon and label, no key hints: **Dashboard** (the kanban workspace board with Continue last workspace), **Create** (opens New pond) and **Search** (opens the ⌘K palette; the separate search field is gone). A full-width hairline, the header "Ponds" with a small funnel menu at its right, then ponds: icon (an uploaded pond icon from the host, else the project's own, else a bold monochrome letter), bold name, a muted count of branches only when folded or when none are listed, and an always-visible "+" at the right that opens New branch. Branch rows sit indented under it, with a "+" on hover that opens New thread: git-branch icon (the matrix glyph while it works), the chat's title (not the bird name; the workspace and branch are in the tooltip), and the diff stat right-aligned in small mono, green +n red −n abbreviated (`DiffStatFormat`: 205, 3k, 5.5k, 102k). The selected row is a filled rounded pill (`selected`, radius 8). Rows are 38pt (pond) and 36pt (branch) at 14pt text. Footer: a compact Squeak/version block and update-options, help and Settings controls. The current installed version stays visible throughout updates. Check, available-version Install, download/preparation progress, Cancel when supported, Restart, retry/failure recovery and release notes live inline here. The options menu contains automatic-check and automatic-download preferences. Sidebar-initiated updates, including permission and delayed Sparkle focus callbacks, never open the progress window; other explicit update entry points retain their existing presentation. **A pond's menu** is exactly: New branch… (⇧⌘N), Open branch…, Open pull request…, New branch for issue…, a divider, Show in Finder, Labels…, Hide pond, Pond settings…. **Hide and labels** are the host's, per pond (`PATCH /native/projects/<key>/prefs`): a hidden pond leaves the list and a quiet "N hidden" row at its end shows them again (greyed, with Unhide in their menu). Labels… is a small popover: existing labels as toggle chips and a field to add one (1 to 24 characters, at most 8 per pond). The funnel menu lists "All ponds", each label with its count, a divider and "Show hidden"; the choice is kept, and an active label shows as a chip under the header with an × to clear (`PondFilter` in SqueakMacCore orders and filters; hidden are left out unless shown, newest first is kept). **Pond settings** is a page in the centre (see Pond settings in §8). The sidebar is never narrower than 200pt (a saved width below that is raised on load).
- **Real projects only.** The sidebar lists Squeak's own projects and Conductor's repos. Terminal and headless sessions in other folders (`.context/tab-release`) go in one folded group at the bottom, "Other sessions" (`SidebarSections.split`).
- **Centre.** Top bar: the repo's icon, "repo › branch" and a ··· menu (copy branch, reveal folder, Open in Conductor) at the left; at the right the target branch (`origin/<base>`), the rules shield, the open-in control (icon and chevron, bordered), the git action only while the right panel is closed, and the panel toggle. Tab row under it: each chat tab has a drag handle, its title and a 2pt underline when active; "+" after the last tab; a history button at the far right reopens the last closed tab (⇧⌘T). `ChatTabs` holds the close rules.
- **Transcript.** No "Worked · N steps" fold: every thinking block is a brain-icon "Thinking" row with its text below in muted body text; every tool call is its icon (">\_" for a command), a plain description and the target in a mono chip, at 14pt. The running line is Squeak's matrix glyph (`WorkingGlyph`: style `mark`, `ink`, 26×15pt) and the clock with tenths ("2m, 38.1s", `ElapsedFormat.live`), with the "Next unread ›" pill, 1pt border, at its right. "Expand all" and ⌃O still open every detail.
- **Composer.** One tall rounded box (about twice the old height, `surface` fill, 1pt `line`), the placeholder "Tell <agent> what to do next", "⌘L to focus" at the top right while empty, and one bottom row: model and effort with a chevron (and the mode chip) at the left; at the right attach, a context ring, "+" (attach, mention a file, run a command), dictate and a square send or stop button (ink tile with a square cut out). The "send / new line" hint row is gone; a problem in words still shows under the box.
- **Right panel (~30%).** The git primary action (Create PR and its dropdown) sits on a top row above the panel; its dropdown holds the git actions and "Pull request and checks…" — **Checks moved there**, out of the tab row. Upper tabs: All files, Changes with its count, Review, then search, a tree/list toggle and a ··· menu (`InspectorTab`). Changes: "N files changed" with +adds −dels, then rows with the folder dimmed and the file name bright, +n −n at the right and a small status square (`ChangeListing`). The lower part has its own tab row: a collapse chevron, Setup, Run, Terminal, "+" (`InspectorLowerTab`; Setup and Run for Squeak's own chats). The terminal moved here from the bottom panel; ⌘J toggles the lower part (and opens the panel if it was closed). Its height is remembered. Inspector tabs are ⌥⌘1–3.
- **Not done / open.** The target's Artifacts and Browser tabs; unread dots in the copper accent (`#CCA694`) are not drawn (Squeak's unread is weight); the light scale's `muted` `#8E8885` on white is below 4.5:1 as the target has it, so it is for secondary text only.

### Update and fullscreen behavior (2026-11-10)

The main window is created only after AppKit has actually switched to regular application policy,
including the brief Dock-settling delay after an update. A queued request survives that delay;
closing windows cancels it. The main window normalizes its collection behavior when attached and
after activation: managed and fullscreen-primary, clearing fullscreen-none and auxiliary/panel flags.
The native green button and existing Control-Command-F action remain the system's fullscreen controls.

Sidebar update progress uses the shared UpdateFlow; no second update engine or download path is added.
The footer owns presentation when it initiates a check or action. Permission remains an explicit choice
in the footer. The app menu can still explicitly request the update window.

The workbench extends its entire clipping and pane-toggle coordinate space into the title bar;
individual columns must not ignore the top safe area independently. The native windowed title bar,
fullscreen layout and restored window share the same visible header geometry.

The popup presents a single update card. A current check, offer, download, preparation, restart or
failure takes precedence over the previous launch's "Updated to" notice. Progress and wrapping
actions use workbench surfaces and colours. Release feeds also offer signed Sparkle delta archives
from the two most recent locally cached releases, retaining the full DMG when a patch is unavailable
or cannot apply. Patches and their appcast are published together; unreferenced patches are pruned.

The earlier menu-bar redesign is included in this desktop build: a 400pt panel capped at 640pt,
workbench surfaces, Chats/Usage/Controls tabs, compact rows and expandable quick answers. The popup's
Quick message hint comes from the active global shortcut (double-tap Control by default, with its
configured fallback); it has no local Command-K binding, which remains the command palette's.
