# Web redesign: three directions (2026-11-27)

Static HTML under `a/`, `b/`, `c/`, rendered headless to PNG by `_build/shot.sh` (generator `_build/gen.py`; edit the generator, not the HTML). Viewer is Asha, a Member of Sibhi's greenroom. Every direction uses the real brand files in `assets/` (full-colour duck and lockups, `duckThread.png` tinted by hue, the pond palette, a static TideGlyph frame) and follows DESIGN.md: warm neutrals, duck yellow, no status dots, amber triangle only for waiting on you, tide only for working, sentence case. Per owner feedback there is no All / Shared / Not shared filter (the web only sees shared Ponds) and the account is shown once, as the email (no name).

Per direction: `wide-room.png` (1440x900 light), `wide-room-dark.png`, `phone-room.png` (390x844), `wide-empty.png` (signed in, no shared Ponds), `phone-invite.png` (/invite).

## A: Warm paper (refined version of the approved light mocks)
Left column of coloured Pond tiles with the owner's avatar on each, Invitations and Needs you above, the Pond list below. The open Pond has a faint pond-colour wash behind its header and a pond-colour tab underline. Duck-yellow primary buttons with ink text (12.9:1). System font. The empty state is one calm card with the duck and "Ponds you share from your Mac appear here".
Trade-off: safest and closest to DESIGN.md, but also the closest to a conventional two-pane mail app; the personality is in colour only.

## B: Chat first (Room is the screen)
An 88 px dark rail of pond-colour tiles (name under each, triangle or tide on the corner, an Invites tile with a count) and the Room taking everything else. The Needs you question is pinned at the top of the Room with an Answer button; own messages are tinted in the pond colour. On phone the rail becomes a strip of tiles. The empty state is a message from Squeak in an empty chat. The invite page is an invitation arriving as a chat message with a Pond card.
Trade-off: feels most like a messaging app (the spec's aim) and gives the Room the most space, but Invitations and Needs you shrink to a tile and a pinned strip, and Pond names get truncated in the rail.

## C: Bold brand (duck-yellow ground, big type)
A full duck-yellow sidebar with white Pond cards and an ink selected card; the open Pond is a large pond-colour headline on a wash with a mono label (Figtree display and JetBrains Mono, the brand type) and ink bubbles. The empty state is a poster-style headline with the duck. The invite page opens with a yellow sheet and a huge headline.
Trade-offs: the most memorable and a real first impression for invitees, but it breaks the "yellow is about 12% of a composition" balance, uses brand type in the product (DESIGN says product uses system fonts: needs an owner call), and is loudest to live in all day.

## Recommendation
Pick **B**. It is the clearest answer to "a small, calm messaging app for your Ponds", is least like an admin panel, and keeps every brand rule intact (system font, yellow only as the primary and the logo). Take C's invite page for the /invite landing regardless: it is Squeak's first impression. A is the fallback if the rail feels too compact for people with many Ponds.

## Calls I made
- Thread ducks use hues from the pond palette (none in the duck band). The mood sprites were not used, only the logo duck and the template thread duck.
- Working marks are static frames of the TideGlyph; they twinkle in a browser.
- Dark: A and B follow the warm dark neutrals; C keeps the yellow sidebar in both themes (brand constant).
