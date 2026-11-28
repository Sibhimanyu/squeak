# Pond Dashboard mocks (greenroom, 1440x900, dark; Inter + brand duck mask, all local)

Follows spec.md "Pond journey and Dashboard" and "People and remote", and DESIGN.md (warm neutrals, duck-yellow primary,
`working` blue only on the TideGlyph, `warning` amber triangle only on things waiting for you, thread ducks from the
brand's `duckThread.png` tinted per Duck, no status dots, sentence case). `_build/gen.py` regenerates every file;
`_build/shot.sh` renders headless PNGs to /tmp/pdm. The toolbar is the one unified bar: back/forward and the
Dashboard | Room switch only; the Pond's name lives in the page header (DESIGN 8.12 says the Dashboard must not repeat it
in the bar). A slim icon rail (Changes, Files, Artifacts) sits at the right as on every page.

**owner-new-folder-pond** - A Pond just made from a folder. Header: tile, "greenroom", "Only on this Mac", one avatar
(Sibhi), Start a duck (primary), Invite, Put on GitHub, and the ⋯. The only body is an empty Ducks block: the brand duck,
one sentence and the same three buttons. Sidebar shows the Pond list with the All · Shared · Not shared filter.

**owner-busy-shared** - Shared Git Pond: "Shared with 3 people · Live", avatars of Sibhi, Asha, Dev and an outlined
envelope avatar for the pending invite; Put on GitHub is gone. Needs you: Pip's question with lettered options
(recommended marked) and a free-text field, and Asha's Task waiting for approval (Approve, Decline, amber triangle).
Ducks: two working (animated glyph slot), Pip waiting (triangle), two idle (age only, no icon), Closed folded. Latest in the Room:
three lines. Sidebar also shows the Invitations block (Dev invites you to field-notes, Join / Decline).

**people-sheet** - The People sheet over the Dashboard. Members with the email under the name, "online" or
"last seen 2 h ago" as text, role menu (Owner is fixed text for the Owner), Remove. Invitations below: Invited · 3 days
ago (Resend, Withdraw), Declined · 2 h ago (Invite again), Expired (Invite again); outlined avatars; no device counts. The
subtitle counts places (3 people + 1 pending = 4 of 10; declined and expired do not count).

**invite-sheet** - Email tokens, one refused inline and on the token ("asha@greenroom.app: Already a Member. Remove it to
send the rest."), Member (default) / Viewer picker with one-line meanings, places used, Cancel, Send 2 invites.

**member-view** - Same page for Asha, a Member of Sibhi's Pond: "Sibhi's Pond · Member · Live", owner badge on the Pond
tile, Start a duck (asks Sibhi) and ⋯ only (open: Notebook, Pond settings, Leave greenroom…). Needs you holds her own
Duck's question and her Task "Waiting for Sibhi" with Withdraw. Sidebar has the filter on Shared and the owner badge on the row.

**member-view-viewer** (extra file) - Viewer variant: Start a duck drawn closed (lock, no fill) with the line "You can
view this Pond. Ask Sibhi to make you a Member." under the header; no Needs you block because there is nothing for a Viewer.

**starting-duck** - A Duck page just opened: "New duck · Starting…" (plain text, no glyph: it is not working yet), the
message already sent shown right-aligned "Sends when the duck is ready", the composer focused (Pond-accent ring) with a
second message being typed and a Send button. The sidebar shows the new Duck under greenroom; nothing navigated away.

## Spec conflicts and open questions

- Empty Ducks block repeats the header's three buttons (spec says both). Two Start a duck buttons on one screen reads
  oddly; suggest the header hides Start a duck/Invite/GitHub while the Ducks list is empty, or the block keeps only the sentence.
- DESIGN 8.12 puts the Pond icon and name in the bar and says the Dashboard does not repeat them; spec puts the name atop
  the Dashboard. Mocks follow the spec and keep the bar to nav + switch. 8.12's Duck tabs are not drawn (ducks live in the list).
- Role menu: user brief says Owner/Member/Viewer; spec says only the Owner can change roles and names one Owner. Drawn as
  Member/Viewer menus with Owner fixed; confirm whether a second Owner can be made.
- Invite sheet with one refused address: Send is shown for the rest ("Send 2 invites") with the refusal inline; spec only
  says refused in the sheet. Confirm whether Send blocks until the token is removed.
- Spec says count tiles and the Pond overview card go; the Dashboard mocks keep Needs you duck cards at full question
  size. Is the free-text answer field wanted on the Dashboard or only in the Duck?
- A Duck waiting on you appears both in Needs you and (with the triangle) in the Ducks list; confirm the double listing.
- Dashboard is dark only here; light theme not drawn.
