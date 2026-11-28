# Pond policy: two settings the Owner sets, Room first by default

Who may do what in a Pond is one pure function, `decide(actor, action, ctx, policy)` in `src/flotilla/permissions.ts`,
and the **Pond policy** is its input: two settings the Owner sets, `reachDucks` (`room` or `direct`) and `startDucks`
(`room`, `members-approval` or `members`), each with per-person overrides. Both default to `room`: Members talk in the
Room, its decider picks or starts the Duck, and no one messages a Duck directly. The policy is Pond data, signed by the
Owner in the Pond's `pond/meta` document so every Member's Mac, the web and the phone read the same thing. The Owner's
Mac enforces it where requests arrive (the Room inbox, queued asks, verified commands) and the daemon sends every
surface its answer as `me.can` (action to `true` or the refusal sentence) so surfaces draw from it and compare no roles.

This supersedes [ADR 0004](0004-email-only-membership-cloud-enforced-removal.md)'s dropping of per-Member switches for
exactly these two settings and their per-person overrides; presets, `caps` flags, per-Duck locks and machine grants stay
dropped. The owner asked for it on 2026-11-28: sharing a Pond with a team should mean the Room is how people reach Ducks,
and the Owner decides when to open that up for a person they trust.

We kept three roles and the Owner's alone-ness over approving edits, shell and pushes and over Stop, because an agent
runs on the Owner's Mac with the Owner's tokens and credentials; no policy setting reaches those. We put the policy in the
signed meta document instead of in each member's document so there is one place to read and one signature to check, and a
removed Member's override simply stops being asked. We kept the relay out of the policy: it enforces only what it can see
in the people tables (membership, Owner-only people actions, and that a Viewer writes no Room post or command), and the
Owner's Mac, which holds the keys, decides the rest.
