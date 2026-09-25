# Squeak — Design & Brand Guidelines

> Version 1 · 2026-09-25 · Step 1 of the Squeak app roadmap (see §13).
>
> This is the single reference for how every Squeak surface looks, moves and
> speaks: the menu-bar duck that ships today, the desktop app, the mobile app,
> and the Telegram cards. It is written from what already exists — the duck's
> artwork, the panel in `desktop/renderer/duck.css`, the card rules in
> `CLAUDE.md` — so it codifies rather than reinvents. Where it changes
> something that ships today, §12 lists the change.

---

## 1. The brand

### Name and idea

**Squeak** watches every coding agent on your Mac and tells you, at a glance,
which ones need you. Its mascot is a **rubber duck** — the programmer's oldest
debugging companion, the thing you explain your problem to. Here the duck
explains the agents' problems to *you*.

One line: **Squeak is a pager for your coding agents, with a duck.**

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
| **Menu-bar duck** (ships today) | Ambient status. Mood at a glance; panel on click. | Very low | Dark panel over any wallpaper |
| **Squeak for Mac** (next) | The home of Squeak: start/stop the duck, see all work, review and reply. Replaces every Terminal command. | Medium | Follows system, dark first |
| **Squeak for iPhone / Android** (later) | Guide agents away from the desk: answer decisions, reply, review diffs. | Low per screen, deep by navigation | Follows system |
| **Telegram cards** (ships today) | Push notifications with one-tap answers. | Three lines | Telegram's own |

The desktop app is the full picture; the duck is its ambient face; the phone
and Telegram are remote hands. They share one visual language so that
"working", "needs you" and "done" look the same everywhere.

---

## 3. Colour

### 3.1 Brand colours — the duck

Sampled from the duck artwork (`desktop/renderer/duck-*.png`), so the UI and
the sprite are the same yellow.

| Token | Hex | Use |
| --- | --- | --- |
| `duck` | `#FCD02C` | The duck. App icon ground. Primary action fill on dark. |
| `duck-wing` | `#FCC010` | Pressed/hover state of a duck-filled control. Illustration shading. |
| `beak` | `#FC8830` | Illustration only. Never a UI colour (it would read as a warning). |
| `duck-outline` | `#3C1804` | Illustration outline; text/icons placed *on* duck yellow. |
| `duck-text` | `#8A5A00` | Yellow-family text or links on light backgrounds, where `duck` is unreadable. |

**Yellow and orange belong to the duck.** No state, warning or error may use
them: next to a yellow duck, a yellow "error" reads as brand decoration, not
as a problem.

### 3.2 Neutrals

Zinc, as today. Dark is the primary theme — the panel floats over arbitrary
wallpaper and the menu bar is dark on most setups — with a full light theme
for the apps.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `bg` | `#09090B` | `#F4F4F5` | Window / screen canvas |
| `surface` | `#18181B` | `#FFFFFF` | Panels, cards, list backgrounds |
| `surface-raised` | `#27272A` | `#FFFFFF` + border | Hovered row, popovers, sheets |
| `panel-translucent` | `rgba(24,24,27,0.92)` + 20px blur | `rgba(255,255,255,0.88)` + 20px blur | The floating duck panel only |
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
| `ink` (zinc-900) on `duck` | 11.98 | AAA — text on a duck-yellow button |
| `duck-outline` on `duck` | 10.72 | AAA |
| `duck` on `surface` (dark) | 11.98 | AAA |
| `duck` on white | **1.48** | **fails — never do this** |
| `duck-text` on white | 5.93 | AA |
| State dots, dark (needs / working / done / error / idle) | 6.40 / 7.78 / 8.27 / 6.51 / 3.67 | all ≥ 3:1 |
| State dots, light (needs / working / done / error / idle) | 4.83 / 5.02 / 5.93 / 5.70 / 4.83 | all ≥ 4.5:1, usable as text |

---

## 4. Typography

System fonts everywhere. Squeak sits beside the user's editor, terminal and
Conductor; a custom typeface would make it the odd one out.

| Role | Apple | Android / web fallback |
| --- | --- | --- |
| Interface | SF Pro (`-apple-system`) | Roboto, `system-ui` |
| Code, paths, branches, diffs | SF Mono (`ui-monospace`) | JetBrains Mono, `monospace` |

### Scale

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
- Sentence case everywhere. No all-caps labels.
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

---

## 6. The duck and iconography

### 6.1 The duck

The duck is a cartoon rubber duck: a round body, a dark-brown outline
(`duck-outline`), flat yellow with a single wing shade, an orange beak, facing
right. It is the only illustrated element in Squeak.

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
- The app icon is the working duck on a `#18181B` rounded-square ground,
  facing right, occupying ~70% of the tile. No text, no gradients.
- The menu-bar mark is the monochrome outline in
  `desktop/assets/duckTemplate.svg` (a template image, so macOS tints it).

### 6.2 Icons

[Lucide](https://lucide.dev), 1.5px stroke, 16px in lists and 20px in
toolbars, `muted` colour by default — the same set Conductor uses, so the two
apps feel related. Icons accompany words; an icon alone is only acceptable for
universal actions (close, back, more) and must carry an accessible label.

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
●  repo · branch                       ← label, one line, ellipsis
   claude · working · 2m · ctx 62%     ← meta: agent · state · age · extras
   +2017/−1824 · 39 files              ← git line, only when there is change
```

- Three lines maximum. The third line exists only when something changed on
  disk.
- When two rows would read identically (same repo, branch and agent), append
  the chat's own title to the label — only then (`labelCounts` in `radar.ts`).
- Rows are ordered by attention: needs you, then done, then working, then idle.
- A row is a button: it opens the session's detail (app) or offers its actions
  (phone). Hover: `surface-raised`.

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
snof · irrigation"*. Send is the only primary button. After sending, the
composer is replaced by the receipt described above. It never sends to a
session the user did not explicitly pick.

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

- **Lead with the fact.** "snof · irrigation needs approval" — not "Heads up!
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
| Blocked | `🔴 snof · irrigation — needs approval` | `⚠️ ACTION REQUIRED: Agent awaiting permission!` |
| Finished | `✅ conductor-tg · session-hub — done` / `Fixed the stale finish detection.` / `_3 files changed_` | `🎉 Great news! Your agent completed its task successfully!` |
| Reply sent | `Sent B to snof · irrigation in Conductor.` | `Your response has been submitted.` |
| Failure | `The reply did not go through: claude exited (1).` | `Oops, something went wrong. Please try again.` |

---

## 10. Accessibility

- **Contrast:** every text/background pair in §3.4 meets WCAG AA; keep it that
  way when adding colours, and measure, don't eyeball.
- **Never colour alone.** Each state has a word, and a distinct motion. With
  red/green colour blindness, "needs you" and "working" differ by word and by
  pulse speed (1.0s vs 1.6s), and needs you also raises the badge.
- **Targets:** 44×44pt minimum on mobile; 24×24px minimum on desktop.
- **Reduced motion** is fully supported (§7).
- **Screen readers:** every row reads as "snof, irrigation-pull-to-refresh,
  Claude, working, 2 minutes ago". The duck is decorative (`aria-hidden`); its
  mood is announced as text ("3 agents working, 1 needs you").
- **Dynamic type** on mobile up to 200% without truncating the state word.
- **Keyboard:** the desktop app is fully usable without a mouse; the duck's
  two global shortcuts (peek, show/hide) stay separate (see `CLAUDE.md`).

---

## 11. Design tokens

Canonical values, for every surface to import instead of copying. The
desktop app and the Electron duck consume the CSS; the mobile app consumes the
JSON.

```css
:root {
  /* brand */
  --sq-duck: #fcd02c;
  --sq-duck-wing: #fcc010;
  --sq-beak: #fc8830;
  --sq-duck-outline: #3c1804;
  --sq-duck-text: #8a5a00;

  /* neutrals — dark (default) */
  --sq-bg: #09090b;
  --sq-surface: #18181b;
  --sq-surface-raised: #27272a;
  --sq-panel-translucent: rgba(24, 24, 27, 0.92);
  --sq-line: rgba(255, 255, 255, 0.08);
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

  /* motion */
  --sq-motion-quick: 120ms ease-out;
  --sq-motion-standard: 200ms ease-out;
  --sq-motion-emphasis: 320ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

@media (prefers-color-scheme: light) {
  :root {
    --sq-bg: #f4f4f5;
    --sq-surface: #ffffff;
    --sq-surface-raised: #ffffff;
    --sq-panel-translucent: rgba(255, 255, 255, 0.88);
    --sq-line: rgba(0, 0, 0, 0.08);
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
  "brand": { "duck": "#FCD02C", "duckWing": "#FCC010", "beak": "#FC8830", "duckOutline": "#3C1804", "duckText": "#8A5A00" },
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

---

## 13. Roadmap — where this guide is heading

Step by step, each step shippable on its own:

1. **Brand & design guidelines** — this document. ✅
2. **Squeak for Mac.** ✅ A real `.app` (in `~/Applications`) with a Dock/menu-bar
   presence that starts and stops the daemon and the duck (no more
   `launchctl`), and a main window: every session grouped by state, session
   detail with the agent's last message, diff review, reply and decisions. It
   reads the same `/state` the duck does. Built on the existing Electron duck
   so there is one desktop codebase.
3. **Tokens as code.** ✅ Extract §11 into a shared package consumed by the Mac
   app and the duck; apply the §12 changes.
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
