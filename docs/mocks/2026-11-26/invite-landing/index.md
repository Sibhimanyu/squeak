# Invite landing mocks (greenroom)

Static HTML plus headless-Chrome PNGs. Same family as `../web/`: warm light neutrals, system/Inter text, ink primary buttons, pond-palette tile and avatars (greenroom is green; Sibhi lavender, Asha pink, Dev cyan), the real horizontal lockup and full-colour duck from `brand/logo/svg`. The pictures are the existing PNGs (`pond-room.png`, `duck.png`, `owner-busy-shared.png`) in device frames, copied to `img/`. Pond colour is the only colour added: a soft green wash behind the top, green on the Pond name and section labels. No status dots, no Squeak jargon beyond Pond, Duck, Room, Task.

**landing-mac.html (1440x2400 @2x)** - Top: lockup and "An invitation for a***@gmail.com". Hero left: Pond tile, "Sibhi invited you to greenroom" (Pond name in its colour), one line on what it is, Sibhi, Asha and Dev avatars with names, then Join in your browser (primary) and Get Squeak for Mac (secondary), with "Nothing to install" and "Sign in with a***@gmail.com and greenroom will be waiting". Hero right: two overlapping tilted phones (a Room, a Duck asking). Below: one calm line on what Squeak is, three alternating parts (Room, Ducks, Pond Dashboard) with real pictures, the Member line in a Pond-tinted card, a closing "greenroom is waiting" with both buttons, footer with the address and expiry.

**landing-phone.html (390 wide, rendered 390x3100 @3x, the page is longer than the 2000 asked)** - Same story in one column. The only button is Join in your browser (no Mac download, per spec); it repeats after the Member line. A single column cannot hold three parts with pictures in 2000 px.

**landing-expired.html (390x1200 @3x)** - Withdrawn state: muted Pond tile, one sentence "Sibhi withdrew this invitation.", primary "Ask Sibhi for a new invitation", the address it was for, then the story below. No Join button. Expired and used-already use the same layout with their own sentence ("This invitation expired.", "You already joined.").

**email.html (600x900 @2x)** - Subject, To and From shown above the card. Card: Pond-tinted header with lockup, tile, avatars and the headline; one line on what Squeak is; one Open invitation button; "You don't need to install anything to join."; a soft note that Squeak for Mac is optional and the invite is also waiting in the app; footer with the masked address and expiry (3 December 2026).

## Spec conflicts and calls
- Spec asks for "a Duck working on a Task" picture; no existing PNG shows that. I used the Duck asking a question (`duck.png`), which is the closest real shot. A new capture is needed if it must show a Task.
- The Dashboard picture is the Owner's view (Invite button, Approve). A Member view (`member-view.png`) would match "what you can do" better and could replace it.
- Phone page and 2000 px: content needs about 3000 px, so the render is taller than requested.
- The landing page uses the light theme; the Mac Dashboard picture is dark. I kept it dark as a deliberate contrast; say if the pictures should be light.
- Spec lists "Decline" on the invite page in the email section ("same Join and Decline") but the landing bullet names only Join. I left Decline off the landing page.
- Mac story bullet "Get Squeak for Mac" has no destination URL in the spec; it is shown without one.

## Open questions
- Show the members' names in the hero, or only avatars (names come from the invite record)?
- Should the email show the avatars at all, since mail clients may block images (they are inline discs here, but real email needs hosted images)?
- Is a one-line Member sentence enough, or should the Viewer wording also be mocked (it depends on the invited role)?
- A masked address in the hero and footer: repeated twice on purpose (hero for who it is for, footer for the date). Enough?
