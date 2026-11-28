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
38. As an Owner, I want the decider to bring back a Closed Duck when a Task relates to its past work, so that its history is reused.
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
59. As an Owner, I want a Duck with no new work for 1 hour to close automatically, so that the active list stays short.
60. As an Owner, I want a Closed Duck's history kept and readable, so that I can see why it did something weeks later.
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
- **Target:** see "People and remote" below: one account-wide "Your devices" list; a new device sees its Ponds at once.

### Ponds and sharing

- **For:** a shared space for one body of work, private until the Owner invites someone.
- **Today:** every project is a Pond; folder or Git; add a folder or clone a URL; invite by email, link or code with Owner approval; Members are accounts with several devices; roles Owner, Member and Viewer, with a Member's Tasks and Ducks waiting for the Owner's approval (no per-Member switches); Private Ducks; approving and Stop the Owner's alone; shared chats; web guests; Ripples; presence; offline snapshot; Pond look and settings (scripts, branch prefix, merge method, review model, action prompts, routines, backlog). Flotilla tasks, claims and scope locks exist as backend only.
- **Target:** see "People and remote" below; the Room reaches Members; the start permission defaults off and gates Members' Tasks; Flotilla tasks become the Task (one model); scope locks enforced on file edits in folder Ponds; "Make it a Git Pond".

### Pond journey and Dashboard

Decided 2026-11-26. The aim: from the moment a Pond's page opens, everything you can do with it works at once, from one
place, and nothing ever throws you somewhere else.

- **For:** the first minutes with a Pond (make it, start a Duck, invite someone, put it on GitHub) and the page you
  return to.
- **Today:** the Dashboard stacks nine blocks (a "Pond overview" card with Invite, Start a duck and settings, a For-you
  card, a next-steps card, four count tiles, waiting-to-join, People and Tasks cards, the Notebook row, the Ducks list with
  a filter and scope, Canvases, Ripples). Make it a Git Pond lives in the ⋯ menu and Pond settings. Starting a Duck
  sometimes lands on the app's global Dashboard instead of the Duck, apparently while a new Pond is still being set up.
- **Target (v1):**
  - **Rules for every step.** (1) Nothing waits on the network: a Pond is a local folder the moment it is made; the cloud
    is touched only when it is shared, in the background. (2) Every action is available the instant the page opens; if
    the host has not caught up, the action waits for it in place, never refuses. (3) Clicking something never takes you
    anywhere except where it says. An action that has not finished shows itself where it was asked ("Starting…",
    "Inviting…", "Putting on GitHub…"); a failure stays there with a plain sentence and Try again. Navigation never
    falls back to another page.
  - **Making a Pond.** New pond asks one thing: a name (makes the folder) or a folder you choose or drop on the sidebar.
    Clone a repository stays as the third choice. Joining someone's Pond is not here: invites arrive in your Pond list
    (People and remote). The Pond's Dashboard opens at once.
  - **Starting a Duck** opens the Duck's page immediately with the composer focused. The Duck is shown as Starting… until
    the host confirms it, and its page never closes or changes to another page while it waits. Typing and sending work
    straight away; the message is held by the host until the Duck is ready.
  - **The Dashboard, simplified.** The window's top bar holds only back, forward and the Dashboard | Room switch; the Pond's name lives in the Dashboard header (`DESIGN.md` 8.12 updated). Top: the Pond's name, one state line ("Only on this Mac" / "Shared with 3 people ·
    Live" / "Owner's Mac offline"), the people as small avatars (click: the People sheet), and three buttons: **Start a
    duck** (primary), **Invite**, and, for a folder Pond the Owner holds, **Put on GitHub** (gone once it is a Git Pond).
    Everything else is in ⋯ (Pond settings, Notebook, Rename, Leave or Delete). Body, top to bottom, each block only when
    it has something: **Needs you** (questions, approvals, Members' Tasks waiting, people asking to join), **Ducks** (one
    list, working first, then the rest most recent first, Closed folded at the end; `DESIGN.md` is updated to allow this one state-based order), **Latest in the Room** (the last few lines, click: the Room). Count
    tiles, the next-steps card, the For-you card, the People and Tasks cards, the Notebook row and Ripples go: their
    contents live in Needs you, the avatars, the Room (which already gets join and leave lines) and ⋯. Canvases open from
    the tool rail (ADR 0002). A new Pond's empty Ducks block is the only guide: the duck and one sentence; the buttons stay only in the header.
    The exact look is drawn as mocks in Squeak's own style and approved before it is built.
  - **Invite** opens a small sheet on the Dashboard: type addresses, Send. If you are not signed in, sign-in happens in
    the sheet and the invite carries on. The first invite turns the local Pond into a shared one in the background; there
    is no separate "share this Pond" step. The person shows as Invited right away.
  - **Put on GitHub** asks once: private (default) or public, with one sentence on who will see it. If the Mac has no
    GitHub sign-in, it asks for it right there. It makes the repository, publishes the folder and turns on Streams. Local
    Git without GitHub stays in Pond settings (version history).

### People and remote

Decided 2026-11-26 (ADR 0004). The aim is that sharing feels instant and never goes silently stale.

**iPhone is deferred (2026-11-26).** This area, the Cloud area and the Web app are built for Mac and web only. Every iPhone item below (reading the cloud directly, push, the People sheet, Invitations) waits for a later pass; the iPhone app is left as it is, and nothing here may require changing it to ship.

- **For:** bringing people into a Pond, taking them out, and keeping every device of every person live and honest.
- **Today:** email invites, long codes, links and six-character short codes; per-browser web guests beside account Members; owner, member and viewer roles, a Member's Tasks and Ducks waiting for the Owner and Private Ducks; a new device, a leave and a key change all wait for the Owner's Mac; sync is a cloud notice plus polling (60 s web, 2 to 5 min host); offline serves a read-only snapshot and refuses writes; the iPhone reads Ponds through the Mac; web lives at two addresses and its own-Mac view has no Room; a Firebase store path remains.
- **Target (v1):**
  - **One way in: email.** The Owner types an address. Codes, short codes, copied links and web guests are gone. At most 10 people per Pond, counting pending invites. An address that is already a Member, or already has a pending invite, is refused in the sheet with the reason.
  - **The invite is one record in the cloud, and it is the only source of truth.** The relay holds it: Pond, address, who invited, state, and when each state was reached. States: **Pending → Joined, Declined, Expired (7 days) or Withdrawn**. Nothing else (the Owner's Mac, an email, a cached list) decides an invite's state; every surface draws the relay's record and sees each change within 2 s. The invite never carries the Pond key: once accepted the person is a Member in the cloud at once and shows as Connecting until the Owner's Mac seals the key (Devices, below).
  - **What the Owner sees.** Under People, below the Members: each invite with its state and when ("Invited · 3 days ago", "Declined · 2 h ago", "Expired"; Joined moves the person up into Members). Pending has Resend and Withdraw; Declined and Expired have Invite again; finished invites clear after 7 days. A decline or a join posts one quiet line in the Room; a join also sends a push and a Mac notification. The Dashboard's avatars show pending invites as outlined avatars, so a pending invite is visible without opening anything.
  - **What the invited person sees.** If they already have an account, on every signed-in device within seconds: a Mac notification and an iPhone push ("Sibhi invited you to greenroom"); an **Invitations** block at the top of their Pond list on Mac, iPhone and web, and in Needs you on the app's Dashboard, each with the Pond's name, who invited them, and **Join** / **Decline**. Join opens the Pond straight away (Connecting until the Owner's Mac lets the device in). Decline asks nothing and removes it. A person without an account gets only the email; see the next point.
  - **Invited without Squeak: the invite page is the welcome.** The email's Open invitation button goes to the invite page on the web (`squeak.onslate.in/invite`), which is also Squeak's first impression, so it sells as well as it lets in:
    - **Top:** "Sibhi invited you to greenroom", the Pond's name and colour, who is in it (first names and avatars, from the invite record), and one primary button: **Join in your browser**. Joining needs only sign-up (Zoho, Google or email) and lands straight in the Pond on the web; nothing to install.
    - **Below:** what Squeak is, in three short parts with real pictures from the app (a Room with people and Ducks talking, a Duck working on a Task, the Pond's Dashboard), and one line on what a Member can do in this Pond for their role.
    - **Not for me:** a quiet link under the buttons declines the invite (Sibhi sees Declined).
    - **Get Squeak for Mac:** on a Mac, a second button downloads the latest release from the Squeak website; the page says "Sign in with <masked address> and greenroom will be waiting". On other devices that button is not shown (the iPhone app is deferred).
    - **States:** an invite that is withdrawn, expired or already used says so in one sentence, with "Ask Sibhi for a new invitation"; the marketing part still shows below.
    - **After joining on the web:** a dismissible card in the Pond, "Get Squeak for Mac to run Ducks of your own", shown once.
    - **The Mac app for an invited person:** first launch is sign-in, then the Invitations block with the Pond, before any other setup; the rest of the setup waits until they make a Pond of their own.
    - **The email for someone without an account** says they need nothing installed to join, and that Squeak for Mac is optional.
  - **The email** stays, refined: subject "Sibhi invited you to greenroom on Squeak"; one line on what Squeak is; one button, **Open invitation** (the invite page below, with the same Join and Decline); "It is also waiting in the Squeak app if you have it"; the address it is for and the date it expires. Opening an email for an invite that is no longer pending says what happened ("Sibhi withdrew this invitation", "You already joined").
  - **Wrong address.** The invite is tied to the address it was sent to; signed in with another, the web page and the apps show the masked address and Switch account.
  - **A person's name has one source: their Squeak account.** It is the name the sign-in gives (Google or Zoho profile name; for an email sign-up, the name entered once when the account is made). Squeak never offers a rename anywhere: not in Settings, People, the Room or any invite. Nothing else may stand in for it: today a name can also come from the Mac's user name (`personName()`, `identity.name`), a per-Pond `myName`, or what a joiner's app claimed. All of those go; with no account name, the person shows as their email address. Every name in a Pond (People, Room posts, Ducks' "by", Ripples, invites, the Owner's own name) is read from the account by its id, so a name changed at the provider changes everywhere. Email sign-up stays (its name is typed once, at sign-up), which is why the email is always shown beside it. To make the name trustworthy, People always shows the email under the name, and hovering a name anywhere in the Room shows the email too.
  - **Three roles: Owner, Member, Viewer.** Finer permissions come later; until then these are the only levels.
    - **Viewer:** reads the Room and every Duck the Owner has not made Private, live. Posts nothing and wakes no Duck.
    - **Member:** everything a Viewer can, plus posting in the Room, messaging Ducks and answering their questions, and making Tasks or starting a Duck. Tasks and new Ducks wait for the Owner's approval ("Waiting for Sibhi") because they spend the Owner's tokens.
    - **Owner:** everything; approving edits and Stop stay with the Owner alone. Only the Owner invites, removes and changes roles. The role is chosen in the Invite sheet (Member by default) and changeable at any time in People; a change reaches the person's devices within 2 s. The Owner can mark a Duck Private, which hides it from everyone else. Ducks that existed before a Pond's first invite start Private, so sharing never reveals old chats by surprise; Ducks started after it are visible. Making an old Duck visible is one click.
  - **Your Pond list.** Accepted Ponds go straight into the sidebar's Pond list, ordered by latest activity with everything else. A filter at the top: **All · Shared · Not shared** (Shared covers Ponds you share out and Ponds shared with you). A Pond someone else owns carries the owner's avatar and, on hover, "Sibhi's Pond · you're a Member".
  - **A shared-with-you Pond's Dashboard** is the same page drawn for your role, never a different one. Header: name, "Sibhi's Pond · Member · Live" (or Owner's Mac offline), avatars, and only the buttons your role allows (Member: Start a duck, which asks Sibhi; Viewer: none). No Invite and no Put on GitHub; ⋯ holds Leave. Body: Needs you (questions and Tasks of yours), Ducks you can see, Latest in the Room. A closed control says why in one line ("You can view this Pond. Ask Sibhi to make you a Member.") instead of disappearing without a word.
  - **Leaving** is in the Pond's ⋯ menu and on its row in the Pond list (secondary click). One confirm: "Leave greenroom? Your messages stay in the Room under your name. To come back you need a new invite from Sibhi." It takes effect in the cloud at once; the Pond leaves your list on every device and the Room gets "Asha left".
  - **What stays when someone leaves or is removed.** The Pond keeps its record: their Room posts, the Tasks they made, their messages to Ducks and their answers stay, under their name marked "(left)". Ducks' work and history are never edited. Their own devices delete their copy of the Pond. While a person is in a Pond they can delete any single message of their own; leaving does not delete anything by itself. If their Squeak account is deleted, their posts show "Former member".
  - **Coming back.** A new invite to the same account rejoins as the same person: "(left)" goes away, their past posts are theirs again, and they read the whole Room history, as every new person does (the Owner's Mac seals every past key version to them, so history from before they joined, or between leaving and rejoining, is readable).
  - **Removal is final at once.** The cloud cuts every device of that person off immediately; they see "You were removed from X". The Pond key rotates when the Owner's Mac is next online. What stays is the same as for leaving (below); their devices delete that Pond's local copy (history cache, snapshot, Room) the next time they open.
  - **Devices.** Devices belong to the account, never to a Pond. Nothing about a device (added, removed, its count, its name) is ever shown in a Pond: no Room line, no Ripple, no device count in People. Devices appear only in Settings › Your devices. A person is one account; devices are never added to a Pond by hand. A new device shows its Ponds at once as "Connecting: waiting for Sibhi's Mac" and becomes readable when the Owner's Mac seals the key to it. "Your devices" is one account-wide list in Settings; removing a device there removes it from every Pond and rotates their keys.
  - **The Owner works from anywhere.** Invite, remove, change roles and delete the Pond from the Mac, the iPhone or web. Invites carry no key, so the cloud sends them while the Mac sleeps; the Mac lets the person in when it wakes. Deleting asks for the Pond's name; Members see "X was deleted" and the cloud copy is wiped.
  - **One People sheet**, the same on Mac, iPhone and web, opened from the Dashboard's avatars: each person's name with their email under it, "online" or "last seen 2 h ago" as text, and role; invites below with their states; the Owner sees Remove, Resend, Withdraw and Invite again, a Member sees Leave.
  - **Live and honest.** Every surface shows one connection state: Live, Reconnecting… or Owner's Mac offline. Live means a change shows on other devices within 2 s by push; a 30 s poll is only the fallback and shows Reconnecting…. Add, remove, leave and delete show done only after the cloud confirms. Members' posts and Tasks made while the Owner's Mac is offline wait in the cloud and are applied in order.
  - **iPhone and web read the cloud directly**, so Ponds and the Room work while the Owner's Mac sleeps; same-Wi-Fi direct is only a speed-up. Web is one address, `squeak.onslate.in` on Catalyst Slate (static files on a CDN, deployed from `web/`, a preview per change), a full peer of the iPhone, including the Room on your own Macs.
  - **Telling people.** Join, decline, leave and removal post one Room line. Push and Mac notifications go only to the person invited and to the Owner when someone joins. Nothing goes to Telegram or Cliq.
  - **Removed paths.** The Firebase store, the old web-client page at `/app/index.html` on the relay's Catalyst domain (redirects to `squeak.onslate.in`), and all code, short-code and guest code.
  - **Start clean, no migration.** The release clears all cloud Pond data (memberships, invites, devices' Pond records, sealed Pond documents). Every Pond and Duck stays on the Owner's Mac; shared Ponds become local again and the Owner re-invites people by email. Codes, guests, presets, switches, locks and grants are simply not carried over. Mac and web ship together with the relay; the relay refuses older Mac apps on Pond routes with "Update Squeak to keep using shared Ponds" (the iPhone app keeps its own Mac channel and is not affected).
  - **Proof.** One end-to-end journey (invite, join on web, add an iPhone, post while the Owner's Mac is offline, remove, every device cut off) runs in CI against the relay double on every change to this area, and daily against the real dev relay. This area does not ship while it is red. The journey also checks every invite state (pending, declined, withdrawn, expired, joined) on the Owner's and the invitee's devices, all read from the one relay record. A second journey covers the first minutes: make a Pond, start a Duck at once and send a message, invite, put on GitHub, with no step landing anywhere but where it was asked.

### Web app

Decided 2026-11-26. The aim: the web is a small, calm messaging app for your Ponds, not a copy of the Mac.

- **For:** reading and talking in your Ponds from any browser: the Room, your Ducks, questions waiting on you, and the
  people in a Pond. It is also where an invited person without the apps lands.
- **Today:** about 28,000 lines in 103 files under `web/`, two apps in one (your own Mac's view and a separate Member
  view, `guest-*`), plus pairing, a Realtime Database reader, Mac controls (lid, awake, hotspot, volume), voice, film
  review, usage, channel setup, presets and a Mac picker. Sign-in bounces between domains. The owner finds both the sign-in
  and the screens hard to use.
- **Target (v1): rebuilt from scratch, not reworked.**
  - **What the web does:** sign in; see Invitations and Join or Decline them; the Pond list (filter All · Shared · Not
    shared); a Pond's Room (read, post, Make task, as the role allows); its Ducks (read a Duck's conversation, reply,
    answer its questions, Stop if you are the Owner); start a Duck with a first message (Owner; a Member's asks the Owner);
    Needs you; the People sheet (invite, roles, remove, withdraw for the Owner; Leave for a Member); Settings with your
    account (name and email from sign-in, not editable), Your devices, and Sign out.
  - **What the web does not do:** Mac controls, voice and calls, film review, usage and cost, Telegram and Cliq setup,
    presets and model choice (a new Duck uses the Pond's default), diffs and files (a Duck's changes show as one line,
    "Changed 4 files", with "Open on your Mac"), canvas editing (a canvas card opens a picture of it), Duckling detail
    (a Duck's Ducklings show as collapsed lines), approving edits, add-ons and Pond settings. Where one of these would be
    asked for, the web says "Open on your Mac" in one line, never a dead control.
  - **No Mac picker.** Every chat belongs to a Pond and Ponds come from the account, so the web lists Ponds, never Macs.
  - **Layout.** Phone width first. Narrow: three screens in a stack (Ponds → Pond → Duck), with Room and Ducks as two
    tabs inside a Pond (Room first). Wide: a left column (Invitations, Needs you, Ponds) and the open Pond or Duck on the
    right; never more than two columns. The composer is always at the bottom, the newest message always in view.
  - **Sign-in, one page.** The Squeak mark, one line on what Squeak is, and Continue with Zoho, Google or email (Catalyst
    hosted login), coming back to where you were. An invite link shows "Sibhi invited you to greenroom" above the same
    buttons and lands on the Pond with Join and Decline. No codes, no Mac pairing, no "Can't reach" screens that offer
    something else: a failure is one sentence with Try again.
  - **Light and dark** follow the browser's setting; both are drawn in the mocks before building.
  - **Built on shared code.** TypeScript with a small UI library and a build step (Slate builds it), using the same
    message shapes and sealing code as the daemon from one shared module, so the web cannot drift from Node the way two
    hand-written copies do. The look follows `DESIGN.md`, drawn as mocks and approved before it is built.
  - **Cutover.** The new web ships at `squeak.onslate.in` with the People and remote work; the old `web/` code, the
    guest page and `/app/index.html` are deleted in the same release.

### Cloud: what is stored where, and how changes travel

Decided 2026-11-26 (ADR 0005). The aim: every change reaches the people who need it within 2 s, an idle device costs
almost nothing, and the cloud never reads what people and Ducks say.

- **For:** the data and the wiring behind People and remote, the Room for Members, iPhone and web.
- **Today:** one relay (a Catalyst function, with the owner's Mac moved to AppSail on 2026-11-16) over one NoSQL table
  `squeak_docs` (partition `channels/<id>/<kind>`, 34 kinds). Every document is sealed by devices, including who is in a
  Pond, so only the Owner's Mac can decide membership. Change notices go out on **one** Data Streams channel shared by every
  user: every connected client receives every user's notices (the web wakes on all of them) and then re-reads whole lists.
  Presence is a cloud document written every 2 minutes per Pond. Room posts are ordered and published only by the Owner's
  Mac, so Members' posts reach each other only while that Mac is online. The cloud keeps the newest 200 Room posts.
  Data Streams facts that limit it: channels are made by hand in the console (no channel per Pond or per person),
  delivery waits for each client's acknowledgement, and resuming after a drop delivers messages twice and replays 48 hours.
- **Target (v1):**
  - **Two kinds of data, two homes.**
    - **People data, readable by the server**, in Catalyst Data Store tables: accounts and their names (from sign-in),
      devices, Ponds (id, owner, name, created), **memberships** (Pond, account, role, joined, left), **invites** (the
      record whose state everyone draws), and push tokens. The server must read these to enforce removal at once, keep
      invite states, apply the 10-person limit, and serve names. Unique rules live in the tables (one pending invite per
      address per Pond, one membership per account per Pond). The member documents signed by the Owner stay as the
      cryptographic record of who holds the key; the table is who may read. Both must agree, and the server's refusal
      covers the gap until the Owner's Mac rotates the key.
    - **Content, sealed by devices**, in the NoSQL table as today: Room posts, Tasks, what Members see of Ducks, key
      envelopes, history. The server stores and orders it, never reads it.
    - **Pictures and files** go to Stratus as sealed blobs, referenced from a post by id, not into NoSQL documents.
  - **The relay is one AppSail server**, holding the routes, the change feed and the live connections; the function is
    retired once every client uses it. (AppSail runs 1 to 5 instances; see "How a change travels".)
  - **The web app is on Slate, the relay on AppSail.** Slate serves the web's static files from a CDN, so a page load never touches a relay instance, and the web deploys (with a preview per change) without restarting the relay, which would drop every device's live connection. The web signs in the way the iPhone and Mac do: hosted login once, then an account token it sends to the relay (`x-squeak-account`), so the web and the relay need not share an origin and no cookie crosses domains. The relay allows exactly the Slate origin (and preview origins) for these account routes; the daemon's control routes keep no CORS.
  - **Every write gets a sequence number.** The server stamps each content write with the Pond's next `seq`. That number
    is the one order everyone draws (the Room no longer waits for the Owner's Mac to order posts), and it makes reads
    cheap: a device asks "what changed in this Pond since 4182" and gets only those documents. No device re-reads a whole
    list after the first open.
  - **How a change travels.** A device keeps one live connection to the relay (server-sent events, with WebSocket only if
    the iPhone needs it) and tells it what it watches: its account and the Ponds it is in. The server checks each against
    memberships and sends a short notice ("Pond X, seq 4183, room") only to those connections. Between AppSail instances,
    one internal Data Streams channel carries notices (at most 5 subscribers: the instances), so Data Streams is never
    fanned out to every device. Removing someone closes their connections' Pond subscriptions on the spot. If the live
    connection is down, a device polls the change feed every 30 s and shows Reconnecting….
  - **Presence is not stored.** A person is online while one of their devices holds a live connection; typing is passed
    along and never written. Only "last seen" is written, once, when their last connection closes.
  - **Members' posts are visible at once.** A Member's post is a signed, sealed document every Member reads from the
    cloud immediately, ordered by its `seq`. The Owner's Mac takes it into the Room's own record when it is online
    (that is when Ducks hear it). Tasks a Member makes wait the same way, as already decided.
  - **What the cloud keeps.**
    - The whole Room, sealed (posts are short; capped at 25 MB per Pond, oldest paged out with a note). The 200-post cap goes,
      so someone joining or rejoining reads everything.
    - A key rotation does not rewrite old documents: they stay under their old key version, and every person in the Pond
      holds every version. New writes use the new key. (Today a rotation rewrites the whole Room.)
    - For each Duck a Member can see: its messages and short step lines for the last 30 days. Big outputs (diffs, files,
      logs) are not uploaded; a Member opening one gets it from the Owner's Mac, or "Available when Sibhi's Mac is
      online".
    - Nothing else: no Ripples (they are Room lines now), no cloud presence, no codes, guests, grants, claims or
      Flotilla tasks. Those kinds are deleted from the relay and the table.
  - **Cost budgets, checked by the journey tests.** An idle signed-in device: one open connection and no requests. Opening
    a Pond already seen: one change-feed read. A Room post: one write, and one notice and one small read per other device
    watching. The per-account daily quota stays as the backstop.
  - **What we verify before building:** that AppSail keeps server-sent connections open long enough behind Catalyst's
    front door (else WebSocket), and that the Data Store's limits suit the people tables. If AppSail cannot hold live
    connections, the fallback is Data Streams channels split into a fixed set of shards by notice tag, so each device
    hears about 1/64 of the traffic instead of all of it.

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
- **Today:** Claude and Codex chats in the session host; model catalog, effort, permission modes, presets; queue or steer while working; auto title, context meter, compact, retry, archive, rename, fork, checkpoints; Duck identities (name, role, colour, notebook, open or closed); agent tools (diff, notify, progress, Duck-to-Duck chat, canvas, Room, Pond upkeep); artifacts and viewer; preview tabs.
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

- **Today:** File browser, search and Markdown preview. The default Mac layout puts Terminal in the Duck's Work Pane. Classic layout uses its dock.
- **Target:** unchanged.

### Workspace: rail, tools and tabs (Mac, new layout)

- **Today:** the Room and the Duck view have a slim icon rail (Changes, Files, Artifacts, Terminal) that opens a side work pane; the Dashboard has none.
- **Target:**
  - **One rail everywhere.** The Dashboard, the Room and every Duck view show the same rail on the right: Changes, Files, Artifacts, Tasks, Notebook, Terminal.
  - **Tools open lists, items open as tabs.** Changes, Files, Artifacts and Tasks open a one-shot popover list anchored to the icon (no pin). Picking an item opens it as a tab in the centre and closes the popover. Picking a Task opens its Duck. Notebook opens as a tab. Terminal opens in the pane beside the chat, the pane's only use.
  - **What each list shows.** Changes: on the Dashboard and in the Room, every Duck's changed files grouped by Duck and branch; in a Duck, that Duck's only. Artifacts: the whole Pond, the current Duck's own first. Files: search, then Recent (opened or shown by Ducks), then the tree of the Pond folder (or the Duck's Stream).
  - **The strip.** One strip at the top of the centre: open Ducks as circles (they cannot be closed; they leave when Closed; an opened Closed Duck sits at the end while it is open), a thin divider, then opened items as round-ended pills (icon, short name, close on hover; a diff pill carries a dot in its Duck's colour). Pills scroll sideways with an edge fade, and a "⋯" at the end lists them all. The Dashboard | Room switch stays in the Pond header.
  - **Tabs belong to the Pond**, persist per Pond (by project id), and keep the tab rules: one click opens one tab, clicking an open item switches to it, new tabs go right after the current one, nothing opens a tab by itself, closing never opens or closes the Duck. A Duck showing a file adds a pill without taking focus.
  - **The centre shows one thing:** the Dashboard, the Room, a Duck's chat or an opened item.
  - **Diff tabs.** Picking a file opens its diff; "Review all from <Duck>" opens all that Duck's changes in one tab. The header names the Duck and branch with "Ask <Duck> to fix…"; a line comment goes to the Duck as a message. The review-all tab carries merge and PR controls.
  - **Artifact tabs** show the artifact full size (canvases stay hand-editable) with one header: name, Duck, and one Export menu (the formats that fit, Reveal in Finder, Copy path). Zoom is ⌘+ / ⌘− / ⌘0.
  - **Live tabs.** An open diff, file or artifact updates in place when its Duck changes it, keeping scroll; an "updated" mark shows on a pill you are not on. When the source is gone (merged, Duck deleted, file removed), the tab says so with Close and never closes by itself.
  - **Keyboard.** ⌘W closes the current item tab (does nothing on a Duck or the Room); ⌘1–9 jump to strip tabs; ⌃Tab cycles. Esc steps back (list, pane, Duck to Room, Room to Dashboard).
  - **One bar, oval tabs (2026-11-25, supersedes the circle strip).** The top bar never changes between pages: Pond logo, Pond name, the Dashboard | Room switch, then tabs filling the rest. Every tab is a low oval: a Duck tab shows its glyph (animated only while working), name and what it is doing ("Working · editing auth.ts", "Needs you", "Idle · 4m"); file, diff and artifact tabs use the same shape. Open Ducks always have a tab, first, not closable; opened Closed Ducks and items are normal tabs. From the Dashboard or Room a new tab opens right after the switch; from a tab, right after it. Inside a Duck the bar stays; a subheader below it carries the Duck's Streams or branch, commit and push, PR, merge, rules and the ⋯ menu; below that the Pond-coloured gradient, then the chat. There is no separate Duck header. Rail lists open at once from data loaded ahead and refresh quietly.
  - **Room as a real group chat (2026-11-25).** The Room holds only what a person would read: people's messages, Duck replies, Duck-to-Duck hand-offs, and one finish message per Task. "Took it", repeated "finished" lines and tool chatter stay in the Duck's chat. A Duck writes its Room message itself with its Room tool, two or three plain sentences (what it did, what it found, what it needs); if it finishes without posting, Squeak writes one from the turn's result with the on-device model. Room messages show in full (no first-sentence clamp); an unusually long one shows about 12 lines, then "Open in <Duck>'s chat". Tapping a message, avatar or name opens that Duck's chat at that turn. Each Task is one live card (waiting, working, done with the summary and Open). Visual direction: flat rows (Slack or Cliq style; chosen 2026-11-25 from mock-ups in .context/artifacts/room-mocks): avatar, bold name, muted time, text on the page with no box; consecutive messages grouped; hover highlight; your own messages marked by a thin Pond-coloured left line; Task cards inline.
  - **Names are masks (2026-11-25).** A Duck wears a name only while open; closing releases it to the pool, and coming back gives a fresh one. Names are short, mostly Indian-flavoured with some fun ones, never with a number. Closed Ducks are known by their chat title. A Duck tab shows the title on line 1 and the glyph, name and current activity on line 2. The Closed list, search and the @ list show a Closed Duck by title, with when it went closed and its last summary line; picking it from @ brings it back. Squeak rewrites a chat's title in 3–6 plain words once the work is clear (never over a title the person set). Room posts keep the name the Duck had when it posted.
  - **Top area as one surface (2026-11-25, mock-up C).** The bar and the Duck subheader sit on one Pond-tinted surface: pond identity at left, borderless translucent tabs (only the selected one raised), a glass Dashboard | Room switch, the subheader's controls as ghost buttons, and chat content that starts below with a soft fade so text never shows through. The tint is quiet: derived from the Pond's colour but desaturated and darkened, with chroma and brightness capped so a bright logo colour (yellow, neon) never dominates, and short (it fades out within about 120pt). The same restraint holds across the whole screen: a Pond's colour is a quiet accent (logo, a thin line, a soft tint), never a dominant fill anywhere.
  - **One Pond roster (2026-11-25).** The host's Duck route is the only list of a Pond's Ducks; every surface (tiles, list, tabs, subheader, For you, sidebar, Room threads, phone) draws it and none rebuilds it. One window, keyed by Duck id; counts are exactly the listed rows. Each Duck carries `activity` (working when its turn runs or any Duckling is still working), `ducklingsRunning`, a host-written `statusLine`, `heading` (name while open, chat title when closed), `streams` ("Pond" when none; no folder branch), and `open`. Cloud threads show only when matched to a Duck.
  - **Every control has a flow.** No control is added without a named user flow; labels never truncate or wrap.
  - **Room.** Reply quotes a message into the composer and @mentions its sender; there are no threads.
  - **No Archived.** Archived chats become Closed Ducks; the sidebar has no Archived entry.
  - **Scope.** Mac new layout only; the classic layout is unchanged; iPhone and web follow later.

### Heresay

- **Today:** Report a Problem and crash reports on Mac and iPhone; report button on web.
- **Target:** unchanged.

### Releases

- **Today:** Mac through Sparkle; iPhone through SideStore; daemon embedded in the app; Home Assistant add-on image.
- **Target:** unchanged.

## Implementation Decisions

- **One Task model.** Room jobs and Flotilla tasks merge into the Task. A Task holds a title, the included discussion, who made it, its state, the Duck it was routed to, its parent Task (for hand-offs), and its result. States: waiting (for approval or a free slot), working, blocked, done, dropped. It lives on the Owner's Mac and is published to Members through the sealed channel.
- **No coordinator agent.** Squeak's own code makes Tasks, routes them and enforces the limits. Ducks coordinate only through the Room and the Task list.
- **The decider** is a module in the session host with one interface: given a new Task and the Pond's Ducks, return one choice: give to a Duck, hatch a new Duck, or wait. It is score-based, with no hard cutoffs. Inputs per Duck: text similarity between the Task and the Duck's Task(s); overlap between the code areas the Duck has touched and the Task; context fill (heavy penalty past about half, softened for small, closely related Tasks); Task size; busy (low weight); Closed (eligible, so it can come back). Similarity runs first; a model decides only when the score is unsure. When still unsure, it hatches a new Duck. It runs only when a Task is made.
- **Decider models behind an adapter**, with two real adapters: Apple's on-device model (default) and Haiku (Settings option), plus automatic fallback to Haiku when Apple Intelligence is off. Similarity uses Apple's on-device text embeddings. Both Apple pieces are Swift-only, so the Node session host calls a small Swift helper program shipped inside the app.
- **One way to start a Duck.** All paths that create a Duck (the decider, people, Duck tools, routines, Git actions) go through one module in the host. It owns placement (Stream choice, Main read-only in Git Ponds, folder Ponds edit the folder), model inheritance and the Duck link.
- **The host owns waiting messages.** Queued messages, steers and queued Tasks live in one host module that writes its own records and events. The Mac shows only a "just pressed, not confirmed" state until the host replies.
- **Room sync** uses the existing sealed cloud channel and document kinds, with a new Room kind and a Task kind. Members' posts while the Owner's Mac is offline wait in the cloud and are applied in order when it returns.
- **Waking rules.** Room messages wake a Duck only on an @mention or a change to its own Task. Ducks read the Room through the catch-up they get when taking a Task, plus mentions and comments delivered at their next turn.
- **Duck posts** are limited to state changes (took, blocked, handing off, done), each a short line with expandable detail. Duck-to-Duck messages are shown collapsed. All posts are skipped while the Pond is solo (not shared and one Duck working).
- **Hand-offs** are Room messages: an @mention goes straight to that Duck; an untagged Task goes through the decider.
- **Spec cards** are written only when the Duck judges the Task more than small.
- **Closed** happens automatically after 1 hour with no new work. Closed Ducks keep their history and stay eligible for routing.
- **Limits.** A per-Pond working-Ducks limit (default 4) applies; Tasks over it wait.
- **Approvals.** Members' Tasks need the Owner's approval unless the Member has the start permission, which defaults off. Ask before starting is a per-Pond setting, off by default.
- **Notebook.** One per Pond, size-capped, written only at Task end with lasting lessons, read by every new Duck, editable by the Owner. Per-Duck notebook entries migrate into it.
- **Ducks start Pond-wide and choose their Streams** (replaces "Ducks own their Stream", 2026-11-25). A Duck starts in the Pond's main folder with no Stream; Squeak never picks one for it. In a Git Pond, Main stays read-only for Ducks: to edit, a Duck creates or joins a Stream with its tools (`streams` lists them and who is in each, `open_stream` creates or joins one and returns its folder, `leave_stream` leaves), and may be in several at once, editing each by path, with file locks per Stream. Squeak's code does the git work and enforces limits. Folder Ponds edit the folder with file locks, as before. The Duck's header shows its Streams as chips ("Pond" when none), Changes are grouped per Stream, and joining, leaving or creating a Stream posts one status line in the Room. Existing Ducks move to the Pond's main folder, keeping their Stream as their first joined one; a Duck whose Stream folder is gone returns to the Pond and rejoins its branch if it still exists.
- **File locks.** Folder Ponds enforce per-file locks on Duck edits. A blocked Duck is told who holds the file and is expected to @mention them in the Room.
- **Make it a Git Pond.** This initialises a repository in the folder, creates a private GitHub repo under the Owner's account with the Mac's existing GitHub sign-in (public toggle), and pushes. The Pond then gains Streams.
- **Surfaces draw only.** Every computed field (Task state, routing line, offline banner, solo mode) comes from host state; Mac, iPhone and web only draw.
- **Phone channel.** New Room and Task shapes must match byte for byte in Swift and Node, with regenerated fixtures and both suites run.
- **Words in code.** A Pond is a `project` in code (`projectId`); a Stream is a `workspace` (`workspaceId`); a Duck's conversation is a `session` or `chat`; Room jobs are `room_jobs` until merged into the Task. No rename now.

## Testing Decisions

- **A good test** drives a module only through its interface, the same way callers use it, and checks outcomes people would notice (who got the Task, what the Room shows, what state a Task is in). It never reaches past the interface into private state.
- **Main seam: the session host's HTTP routes and agent tools.** A real host runs on a temp folder with a fake agent runner. This covers Tasks, routing outcomes, hatching, Closed, the working limit, approvals, @mention hand-offs, file locks, the Notebook, Make it a Git Pond (on a temp repo with a fake GitHub), and the host owning waiting messages. Prior art: the existing server, Room, Room jobs, Ducks-own-branch, folder Ponds and placement tests.
- **Decider adapter seam.** Scoring is tested with a fake adapter that returns fixed similarity numbers and fixed model answers: table tests over related/unrelated, context fill, Task size, busy, Closed and unsure cases. Each real adapter (Swift helper, Haiku) gets one small contract test.
- **Cloud seam.** Room and Task sync, offline posting and catch-up, approvals and permissions are tested with the in-memory cloud store, like the existing Flotilla end-to-end and relay tests.
- **Mac seam.** The Mac core tests cover only drawing rules: collapsed lines, expand, the unconfirmed state until the host replies.
- **Phone channel.** Swift and Node suites both run against regenerated fixtures for new shapes.
- Every fix gets a regression test beside the code.
- **People and remote journey.** One end-to-end test on the relay double drives invite, web join, every invite state, post while the Owner's Mac is offline, remove and leave, and checks every device is cut off and its cache wiped; a daily run uses the real development relay. A second journey covers a new Pond's first minutes (start a Duck and send at once, invite, put on GitHub) and fails if any step lands anywhere but where it was asked.
- **Cloud seam.** The relay's people tables, change feed and targeted notices are tested through its HTTP routes with an in-memory Data Store and notice bus; cost budgets (requests per idle device, per open, per post) are asserted there.
- **Web.** The new web app is tested through its views with a fake relay; message shapes come from the shared module, so no separate fixtures.

## Out of Scope

- Phase 2: Members running their own Ducks on their own Macs, code moving between Macs through Git, cross-machine hand-offs. Direction only: a Member's Duck runs on their Nest, works on its own Stream, and talks in the same Room; the Pond must be a Git Pond for this.
- Live multi-person canvas editing.
- Any coordinator or lead agent in the Room.
- Renaming code identifiers to match the glossary.
- Architecture refactors beyond the two above (settings registry, live-chat stream module, one needs-you rule, project preferences module, voice module).
- All iPhone work for People and remote, Cloud and Web (deferred 2026-11-26), including push notifications.
- Changes to voice, RasanAI, external sessions, add-ons, usage, power, files, Heresay and releases.

## Further Notes

- **Mocks (approved 2026-11-26):** `docs/mocks/2026-11-26/` (Pond Dashboard, web app, invite page and email), each folder with an `index.md`.

- **Reversed decision:** routed Tasks start without a Go tap. This reverses the 2026-11-17 rule that nothing starts without a person's Go; Ask before starting keeps the old behaviour per Pond.
- **Suggested build order:**
  1. One way to start a Duck, and the host owning waiting messages.
  2. The Task model and decider on the Mac.
  3. Room sync to Members.
  4. iPhone and web Room.
  5. Notebook, file locks and Make it a Git Pond.
  6. Docs.
- **People, cloud and web build order** (2026-11-26): (1) start-a-duck fixes (new Pond counted live; Esc and shared/folder starts stay in the Pond / open the Duck); (2) the cloud foundation: people tables, per-Pond sequence numbers and change feed, targeted notices on AppSail; (3) People and remote on the Mac; (4) the new web app on Slate; (5) the Pond Dashboard redesign once its mocks are approved. Catalyst production stays later: this ships on the development environment.
