# Squeak spec

The single living spec for Squeak. It describes every area as it is today and where it is going. Change it through PRs.
Vocabulary comes from `GLOSSARY.md`. **v1** means everything being built now; **phase 2** means Members running their
own Ducks on their own Macs.

## Problem Statement

A person using Squeak can run several AI agents (Ducks) on their Mac, but they work as separate chats. When the person
gives out lots of work, they have to decide by hand which Duck gets what, keep each Duck's context from filling with
unrelated work, and carry knowledge from one Duck to the next themselves. Ducks can't see what each other are doing,
except through tools they rarely call.

When they share a Pond with other people, those people only see shared chats, never the Pond's Room. A group can't
discuss work together with the Ducks, turn that discussion into work, and watch Ducks take it up. The Room exists only
on the Owner's Mac.

A Pond that is just a folder can't become a Git repository without leaving Squeak. Twelve docs describe a Squeak that no
longer exists, so new contributors and agents are misled.

## Solution

Each Pond has one **Room**: a true group chat of its people and its Ducks, on Mac, iPhone and web, synced through the
sealed cloud channel so Members can join from anywhere, even while the Owner's Mac is asleep.

Anyone in the Room can say "make it a task". Squeak turns the recent discussion into a **Task**, and an invisible,
score-based **decider** gives it to the best Duck. That might be a Duck whose work and context fit, or a newly hatched
Duck when none fits, so no Duck's context fills with unrelated work. The Duck starts at once (unless the Pond asks
first), catches up on the discussion, writes a short spec only when the Task needs one, and posts a single expandable
line in the Room when its state changes. Ducks hand work to each other by @mentioning in the Room, in plain sight.
Lessons that last go into the Pond's shared **Notebook**, which every new Duck reads.

Solo use stays first-class: a Pond still opens on its Dashboard, and a person can use Ducks as separate chats and work
through tasks themselves. Ducks stay quiet in the Room until the Pond is shared or more than one Duck is working.

In Git Ponds, Ducks pick their own Stream and never edit Main. In folder Ponds, Ducks share the folder, per-file locks
stop clashes, and clashing Ducks talk it out in the Room. A folder Pond can become a Git Pond in one step, published as
a private GitHub repo.

## User Stories

### Room

1. As an Owner, I want each Pond to have one Room, so that my people and my Ducks talk in one place.
2. As a Member, I want to read and post in a shared Pond's Room from the Mac app, so that I can discuss work with the Owner and the Ducks.
3. As a Member, I want the Room on my iPhone, so that I can follow and join the discussion away from my desk.
4. As a Member without the Mac app, I want the Room in a browser, so that I can take part without installing anything.
5. As a Member, I want to read the Room and post while the Owner's Mac is offline, so that the discussion doesn't stop when their laptop sleeps.
6. As a Member, I want to see "Owner's Mac is offline; Ducks will pick this up when it's back" when it is, so that I know why nothing is moving.
7. As a Member, I want my offline posts and Tasks delivered when the Owner's Mac returns, so that nothing I said is lost.
8. As an Owner, I want Room content sealed so the cloud server can't read it, so that my Pond's discussion stays private.
9. As a person in the Room, I want to attach pictures and files to messages, so that I can show what I mean.
10. As a person in the Room, I want to see who is in the Pond and who is present now, so that I know who I'm talking to.
11. As a person in the Room, I want Duck-to-Duck messages shown collapsed, so that they don't drown out people.
12. As a person in the Room, I want to expand any collapsed line, so that I can see the detail when I care.
13. As a solo user, I want my Pond to keep opening on its Dashboard, so that I can use Ducks as separate chats like before.
14. As a solo user, I want Ducks to skip Room status lines while the Pond isn't shared and only one Duck is working, so that I don't pay tokens for posts nobody reads.
15. As an Owner, I want Ducks to start posting status in the Room as soon as I share the Pond or a second Duck starts working, so that the Room becomes useful exactly when it's needed.

### Tasks

16. As a person in the Room, I want to say "make it a task" in plain words, so that turning discussion into work feels natural.
17. As a person in the Room, I want a Make task action on a message, so that I can turn a specific message into a Task.
18. As a person making a Task, I want it to include the Room messages since the previous Task, up to the last 2 hours, so that the Duck gets the whole discussion.
19. As a person making a Task, I want to trim the included messages before sending, so that irrelevant chatter isn't passed along.
20. As a person making a Task, I want it to get a one-line title, so that everyone can tell Tasks apart.
21. As a person in the Room, I want Squeak's quiet suggestion line on messages that read like work, so that I can make a Task in one tap.
22. As an Owner, I want only people to create Tasks from discussion, so that Ducks don't invent work on their own.
23. As an Owner, I want a Member's Task to wait for my approval by default, so that nobody spends my tokens without asking.
24. As an Owner, I want to give a Member the start permission, so that their Tasks run without my approval.
25. As a Member without start permission, I want to see that my Task is waiting for the Owner, so that I know it was received.
26. As a person in the Room, I want to see every Task with its state (waiting, working, blocked, done, dropped), so that I know what's happening.
27. As a person in the Room, I want to drop a Task, so that work that is no longer wanted stops.
28. As a person in the Room, I want to comment on a Task's spec card, so that I can steer the Duck before it goes far.

### The decider

29. As a person making a Task, I want it routed automatically to the best Duck, so that I don't have to decide who does what.
30. As a person, I want the routing shown as one quiet line ("→ given to Pixel (related to the icon work)"), so that I understand why without a bot in the way.
31. As a person, I want to send a routed Task to a different Duck with one tap, so that I can correct a bad routing.
32. As an Owner, I want routing to weigh how similar the Task is to each Duck's work, so that related work stays together.
33. As an Owner, I want routing to weigh how much the code areas a Duck has touched overlap with the Task, so that the Duck that knows the code gets it.
34. As an Owner, I want routing to weigh how full a Duck's context already is, so that a full Duck isn't overloaded.
35. As an Owner, I want a small, closely related Task to still go to a fairly full Duck, so that tiny follow-ups don't cost a fresh start.
36. As an Owner, I want being busy to count only a little against a Duck, so that the best-fitting Duck still gets related work, queued after its current Task.
37. As an Owner, I want an unrelated Task to hatch a new Duck, so that no Duck's context fills with unrelated work.
38. As an Owner, I want the decider to bring back an Off-duty Duck when a Task relates to its past work, so that its history is reused.
39. As an Owner, I want the decider to pick a new Duck when it isn't sure, so that a mistake costs a fresh start, not a polluted context.
40. As an Owner, I want routing to run only when a Task is made, never on ordinary chat, so that discussion costs nothing.
41. As an Owner, I want routing to use the free on-device model by default, so that it costs nothing and works offline.
42. As an Owner, I want to choose Haiku for routing in Settings, so that I can trade a tiny cost for a stronger model.
43. As an Owner whose Mac has Apple Intelligence off, I want routing to fall back to Haiku automatically, so that it always works.
44. As an Owner, I want no coordinator agent in the Room, so that I talk to my people and Ducks, not to a middleman bot.

### Ducks working on Tasks

45. As an Owner, I want a routed Task to start at once by default, so that work moves without me tapping Go.
46. As an Owner, I want a per-Pond Ask before starting setting, so that I can require a Go tap in Ponds where I want control.
47. As an Owner, I want a per-Pond limit on Ducks working at once (default 4), so that a burst of Tasks doesn't flood my Mac or my token budget.
48. As an Owner, I want Tasks over the limit to wait in line, so that they run as soon as a Duck is free.
49. As a Duck, I want the Task's discussion, any previous Duck's hand-off note and the Pond's Notebook when I take a Task, so that I start fully caught up.
50. As an Owner, I want a Duck to write a short spec and plan card only when the Task is more than small, so that small Tasks don't waste tokens.
51. As a person, I want a small Task to show just a single "took it" line, so that the Room stays light.
52. As a person, I want a Duck to post one expandable line when it takes a Task, gets blocked, hands off or finishes, so that I can follow progress at a glance.
53. As a person, I want no per-turn posts from Ducks, so that the Room stays readable.
54. As a person, I want to @mention a Duck to give it work directly, so that I can skip the decider when I know who should do it.
55. As a Duck, I want to hand part of my Task to another Duck by @mentioning it in the Room, so that hand-offs happen in plain sight.
56. As a Duck, I want to post an untagged Task when no Duck fits a piece of work, so that the decider can hatch a new Duck for it.
57. As an Owner, I want Ducks woken by the Room only on an @mention or a change to their own Task, so that people chatting never burns tokens.
58. As a Duck, I want comments on my spec card delivered at my next turn, so that I can adjust without being interrupted mid-step.
59. As an Owner, I want a Duck with no new work for 1 hour to go Off duty automatically, so that the active list stays short.
60. As an Owner, I want an Off-duty Duck's history kept and readable, so that I can see why it did something weeks later.
61. As a person, I want to still open a Duck and chat with it directly like a normal session, so that the Room never gets in the way of one-on-one work.

### Notebook

62. As an Owner, I want one shared Notebook per Pond, so that what one Duck learns, every later Duck knows.
63. As an Owner, I want a Duck to add to the Notebook only at the end of a Task, and only lessons that will last, so that it stays short and useful.
64. As an Owner, I want the Notebook size-capped with unused entries trimmed, so that reading it stays cheap.
65. As an Owner, I want to read and edit the Notebook, so that I can correct wrong lessons.
66. As an Owner, I want today's per-Duck notebook entries moved into the Pond's Notebook, so that nothing already learned is lost.

### Streams, folders and Git

67. As an Owner of a Git Pond, I want each Duck to pick its own Stream (join the one matching its Task, or branch off a new one), so that I never manage branches by hand.
68. As an Owner of a Git Pond, I want Main read-only for Ducks, so that nothing lands on Main without a review.
69. As a person, I want to ask a Duck for a specific branch decision ("plan this on a separate branch"), so that I can still steer placement.
70. As an Owner of a folder Pond, I want Ducks to edit the folder directly, so that a Pond doesn't need Git.
71. As an Owner of a folder Pond, I want two Ducks blocked from editing the same file at once, so that they don't overwrite each other.
72. As a Duck blocked on a file, I want to @mention the Duck holding it in the Room and work it out, so that clashes get resolved, not just waited out.
73. As an Owner, I want to turn a folder Pond into a Git Pond in one step, so that I can start using Streams without leaving Squeak.
74. As an Owner, I want that step to create a private GitHub repo under my account, using the GitHub sign-in already on my Mac, so that publishing needs no setup.
75. As an Owner, I want a toggle to make the new repo public, so that open projects are possible.

### Surfaces and channels

76. As an Owner, I want Telegram and Cliq to get only the Room moments that need me (a Duck asking a person, a Task blocked, a Member's Task waiting for approval), so that they stay signal, not noise.
77. As a person, I want a Task that produces a canvas to show it as a card on the Duck's done line, so that I can open the result from the Room.
78. As a Member, I want to open that canvas view-only, so that I can see the result without editing rights.
79. As an iPhone or web user, I want the same Room, Tasks and lines as the Mac, drawn from the same state, so that every surface agrees.

### Docs

80. As a contributor or agent, I want the docs to match the code, so that I'm not misled by retired setups.

## Areas

Each area: what it is for, what exists today, and the target. Areas without a target stay as they are.

### Accounts and sign-in

- **For:** one identity across Mac, iPhone and web; signing in is the whole cloud setup.
- **Today:** Squeak account through hosted login (Zoho, Google, email); older installs migrate on sign-in; self-hosting retired; profile photo; Claude account switch (Mac, iPhone).
- **Target:** unchanged.

### Devices

- **For:** a person's own devices join by signing in; nobody types codes.
- **Today:** Devices page; own-account devices join by themselves, others need the Mac's approval; same-Wi-Fi direct path to the phone; several Macs per account; Face ID before sensitive sends; Home Assistant gateway pairing.
- **Target:** unchanged.

### Ponds and sharing

- **For:** a shared space for one body of work, private until the Owner invites someone.
- **Today:** every project is a Pond; folder or Git; add a folder or clone a URL; invite by email, link or code with Owner approval; Members are accounts with several devices; roles and presets with per-Member switches (see, diffs, message, answer, start, muted); per-Duck locks; approving and Stop never grantable; shared chats; web guests; Ripples; presence; offline snapshot; Pond look and settings (scripts, branch prefix, merge method, review model, action prompts, routines, backlog). Flotilla tasks, claims and scope locks exist as backend only.
- **Target:** the Room reaches Members; the start permission defaults off and gates Members' Tasks; Flotilla tasks become the Task (one model); scope locks enforced on file edits in folder Ponds; "Make it a Git Pond".

### Room

- **For:** the Pond's one group chat of people and Ducks.
- **Today:** Mac only, stored on the Owner's Mac; people's messages with attachments; Duck posts through agent tools at two levels (room, agents); turn rows updated with outcomes; summary lines for quiet Ducks.
- **Target:** stories 1-15 and 76-79.

### Tasks and the decider

- **For:** turning discussion into work that Ducks take up themselves.
- **Today:** Room jobs on the Owner's Mac (suggested, dismissed, handed, running, done, failed); one Haiku check per message; word-overlap matching; Go, Allow, New, Dismiss; Ducks can list and ask to claim jobs, always waiting for a person.
- **Target:** stories 16-48.

### Ducks

- **For:** AI teammates you chat with and that take up Tasks.
- **Today:** Claude and Codex chats in the session host; model catalog, effort, permission modes, presets; queue or steer while working; auto title, context meter, compact, retry, archive, rename, fork, checkpoints; Duck identities (name, role, colour, notebook, duty); agent tools (diff, notify, progress, Duck-to-Duck chat, canvas, Room, Pond upkeep); artifacts and viewer; preview tabs.
- **Target:** stories 49-61; Ducks own their Stream on in v1; one way to start a Duck; the host owns waiting messages.

### Ducklings

- **For:** short-lived helpers a Duck spawns inside its work.
- **Today:** subagents and background shells shown as a strip or tab, rebuilt after a host restart.
- **Target:** unchanged.

### Notebook

- **Today:** one notebook per Duck.
- **Target:** stories 62-66.

### Canvas

- **For:** artboards (decks, posters, logos, social, blank) made by Ducks and edited by hand.
- **Today:** Duck tools; Mac hand editing (move, resize, rotate, text, undo, Design tab, merge with Duck edits); Members get a view-only bundle with PDF and PNG export; not on iPhone or web.
- **Target:** canvas cards in the Room (stories 77-78). Live multi-person editing is a later spec.

### Dashboard and Needs you

- **Today:** home, Pond Dashboard with lanes by state, right zone tabs; Needs-you cards everywhere (Mac, iPhone, web, Telegram, Cliq, calls); menu-bar panel, quick composer, floating duck, command palette, dictation; stall detection.
- **Target:** the Pond still opens on the Dashboard, with the Room one swipe away.

### Notifications

- **Today:** macOS notifications with privacy level; per-channel rules (approval, question, stalled, quota, finished, quiet hours); no iPhone push (SideStore), so Telegram and Cliq carry alerts.
- **Target:** Room moments that need you follow the same rules (story 76).

### External sessions

- **Today:** add-ons, off by default, for Terminal and desktop Claude Code and Codex; replies into Terminal.app.
- **Target:** unchanged.

### Add-ons

- **Today:** Conductor, RasanAI, Claude external, Codex external; all off until added in Settings › Extensions; core builds without them.
- **Target:** unchanged.

### Channels

- **Today:** Telegram (cards, reply, diffs, commands) and Cliq (cards, signed replies through the relay).
- **Target:** story 76.

### Voice

- **Today:** outbound calls through a SIP gateway (Home Assistant add-on or direct), PIN and key answers, callbacks, history; calling in with Whisper transcription; realistic voices (Kokoro, Qwen3, Ming, Chatterbox).
- **Target:** unchanged.

### RasanAI

- **Today:** film director add-on on iPhone and web.
- **Target:** unchanged.

### Usage and cost

- **Today:** Claude cost estimate, Codex quota, Claude plan limits on refresh, on Mac, iPhone, web and Telegram.
- **Target:** unchanged.

### Mac settings

- **Today:** You (Account, Ponds, Notifications, Privacy); Agents (Models and presets, Messages); This Mac (General, Keep awake, Background service); Devices (Devices, Connections); Extensions (Telegram, Cliq, Phone calls, Conductor, RasanAI); About.
- **Target:** Agents gains the routing model choice (on-device default, Haiku); Pond settings gain Ask before starting and the working-Ducks limit; the Notebook is readable and editable from the Pond.

### Mac power and controls

- **Today:** keep awake (lid closed, heat governor, energy mode, hotspot failover); phone controls the Mac (volume, brightness, fans, apps, tabs, media, lock).
- **Target:** unchanged.

### Git

- **Today:** Streams from a branch, PR or issue; diffs with line comments; PR status, checks and merge; Git actions as prompts; disk cleanup.
- **Target:** Ducks own their Stream; "Make it a Git Pond".

### Files and terminal

- **Today:** file browser, search, Markdown preview; terminal panel.
- **Target:** unchanged.

### Heresay

- **Today:** Report a Problem and crash reports on Mac and iPhone; report button on web.
- **Target:** unchanged.

### Releases

- **Today:** Mac through Sparkle; iPhone through SideStore; daemon embedded in the app; Home Assistant add-on image.
- **Target:** unchanged.

## Implementation Decisions

- **One Task model.** Room jobs and Flotilla tasks merge into the Task. A Task holds a title, the included discussion, who made it, its state, the Duck it was routed to, its parent Task (for hand-offs), and its result. States: waiting (for approval or a free slot), working, blocked, done, dropped. It lives on the Owner's Mac and is published to Members through the sealed channel.
- **No coordinator agent.** Squeak's own code makes Tasks, routes them and enforces the limits. Ducks coordinate only through the Room and the Task list.
- **The decider** is a module in the session host with one interface: given a new Task and the Pond's Ducks, return one choice: give to a Duck, hatch a new Duck, or wait. It is score-based, with no hard cutoffs. Inputs per Duck: text similarity between the Task and the Duck's Task(s); overlap between the code areas the Duck has touched and the Task; context fill (heavy penalty past about half, softened for small, closely related Tasks); Task size; busy (low weight); Off duty (eligible, so it can come back). Similarity runs first; a model decides only when the score is unsure. When still unsure, it hatches a new Duck. It runs only when a Task is made.
- **Decider models behind an adapter**, with two real adapters: Apple's on-device model (default) and Haiku (Settings option), plus automatic fallback to Haiku when Apple Intelligence is off. Similarity uses Apple's on-device text embeddings. Both Apple pieces are Swift-only, so the Node session host calls a small Swift helper program shipped inside the app.
- **One way to start a Duck.** All paths that create a Duck (the decider, people, Duck tools, routines, Git actions) go through one module in the host. It owns placement (Stream choice, Main read-only in Git Ponds, folder Ponds edit the folder), model inheritance and the Duck link.
- **The host owns waiting messages.** Queued messages, steers and queued Tasks live in one host module that writes its own records and events. The Mac shows only a "just pressed, not confirmed" state until the host replies.
- **Room sync** uses the existing sealed cloud channel and document kinds, with a new Room kind and a Task kind. Members' posts while the Owner's Mac is offline wait in the cloud and are applied in order when it returns.
- **Waking rules.** Room messages wake a Duck only on an @mention or a change to its own Task. Ducks read the Room through the catch-up they get when taking a Task, plus mentions and comments delivered at their next turn.
- **Duck posts** are limited to state changes (took, blocked, handing off, done), each a short line with expandable detail. Duck-to-Duck messages are shown collapsed. All posts are skipped while the Pond is solo (not shared and one Duck working).
- **Hand-offs** are Room messages: an @mention goes straight to that Duck; an untagged Task goes through the decider.
- **Spec cards** are written only when the Duck judges the Task more than small.
- **Off duty** happens automatically after 1 hour with no new work. Off-duty Ducks keep their history and stay eligible for routing.
- **Limits.** A per-Pond working-Ducks limit (default 4) applies; Tasks over it wait.
- **Approvals.** Members' Tasks need the Owner's approval unless the Member has the start permission, which defaults off. Ask before starting is a per-Pond setting, off by default.
- **Notebook.** One per Pond, size-capped, written only at Task end with lasting lessons, read by every new Duck, editable by the Owner. Per-Duck notebook entries migrate into it.
- **Ducks own their Stream** (the existing flag) turns on by default in v1.
- **File locks.** Folder Ponds enforce per-file locks on Duck edits. A blocked Duck is told who holds the file and is expected to @mention them in the Room.
- **Make it a Git Pond.** This initialises a repository in the folder, creates a private GitHub repo under the Owner's account with the Mac's existing GitHub sign-in (public toggle), and pushes. The Pond then gains Streams.
- **Surfaces draw only.** Every computed field (Task state, routing line, offline banner, solo mode) comes from host state; Mac, iPhone and web only draw.
- **Phone channel.** New Room and Task shapes must match byte for byte in Swift and Node, with regenerated fixtures and both suites run.
- **Words in code.** A Pond is a `project` in code (`projectId`); a Stream is a `workspace` (`workspaceId`); a Duck's conversation is a `session` or `chat`; Room jobs are `room_jobs` until merged into the Task. No rename now.

## Testing Decisions

- **A good test** drives a module only through its interface, the same way callers use it, and checks outcomes people would notice (who got the Task, what the Room shows, what state a Task is in). It never reaches past the interface into private state.
- **Main seam: the session host's HTTP routes and agent tools.** A real host runs on a temp folder with a fake agent runner. This covers Tasks, routing outcomes, hatching, Off duty, the working limit, approvals, @mention hand-offs, file locks, the Notebook, Make it a Git Pond (on a temp repo with a fake GitHub), and the host owning waiting messages. Prior art: the existing server, Room, Room jobs, Ducks-own-branch, folder Ponds and placement tests.
- **Decider adapter seam.** Scoring is tested with a fake adapter that returns fixed similarity numbers and fixed model answers: table tests over related/unrelated, context fill, Task size, busy, Off duty and unsure cases. Each real adapter (Swift helper, Haiku) gets one small contract test.
- **Cloud seam.** Room and Task sync, offline posting and catch-up, approvals and permissions are tested with the in-memory cloud store, like the existing Flotilla end-to-end and relay tests.
- **Mac seam.** The Mac core tests cover only drawing rules: collapsed lines, expand, the unconfirmed state until the host replies.
- **Phone channel.** Swift and Node suites both run against regenerated fixtures for new shapes.
- Every fix gets a regression test beside the code.

## Out of Scope

- Phase 2: Members running their own Ducks on their own Macs, code moving between Macs through Git, cross-machine hand-offs. Direction only: a Member's Duck runs on their Nest, works on its own Stream, and talks in the same Room; the Pond must be a Git Pond for this.
- Live multi-person canvas editing.
- Any coordinator or lead agent in the Room.
- Renaming code identifiers to match the glossary.
- Architecture refactors beyond the two above (settings registry, live-chat stream module, one needs-you rule, project preferences module, voice module).
- iPhone push notifications.
- Changes to voice, RasanAI, external sessions, add-ons, usage, power, files, Heresay and releases.

## Further Notes

- **Reversed decision:** routed Tasks start without a Go tap. This reverses the 2026-11-17 rule that nothing starts without a person's Go; Ask before starting keeps the old behaviour per Pond.
- **Docs to fix (12):**
  1. `getting-started.md` describes the deleted relay, Firebase, QR pairing and old Settings pages.
  2. `AGENTS.md` and `layout.md` say the daemon watches every session; external discovery is now add-ons, off by default.
  3. `macos/README.md` has an outdated Settings list and Sparkle status.
  4. `voice.md` and the Home Assistant config describe a Firebase gateway and "Settings › Voice" (now Phone calls).
  5. `cliq.md` routes replies through Firebase.
  6. `cloud-layer.md` describes a Settings › Cloud tab that no longer exists.
  7. `ponds.md` contradicts itself on live status, guest tokens and cloud setup.
  8. `web-app.md` claims parity with iPhone.
  9. `remote-channel.md` still recommends FCM push.
  10. `flags.md` omits environment switches.
  11. `todo.md` says Codex asks aren't answerable (check against code).
  12. The terminal panel's status disagrees between docs.
- **Suggested build order:**
  1. One way to start a Duck, and the host owning waiting messages.
  2. The Task model and decider on the Mac.
  3. Room sync to Members.
  4. iPhone and web Room.
  5. Notebook, file locks and Make it a Git Pond.
  6. Docs.
