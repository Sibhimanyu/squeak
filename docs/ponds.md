# Ponds: multiplayer Squeak (Flotilla)

Status: design and contract, 2026-11-10. Owner's decisions are marked **D**. Off by default behind `SQUEAK_FLOTILLA=on`.

## Words (DESIGN.md §9)

**Pond** the shared container. **Flock** its members. **Thread** one agent on one task. **Nest** a member's machine.
**Egg** an idea not started; starting it hatches a thread. **Duckling** a helper agent. **Quack** a notification.
**Ripples** the activity feed. Workspace still means one git worktree. Controls stay literal.

## The model (D)

- A pond is any folder. Opening one shows its home: the flock and every thread.
- Access is granted per pond. Members see every thread unless its starter marks it private.
- Two kinds of collaboration:
  1. **Own thread**: a member runs their own agent on their own Nest. Needs a pond with a Git remote; code moves only through Git.
  2. **Shared thread**: members chat in a thread running on its starter's Nest. Only messages travel, so any folder works.
- On someone else's thread a member can watch, see the diff, message, steer and answer. **Approving actions and stopping a
  thread belong to its starter**, and only on the starter's own Mac; neither exists as a command on the wire.
- Whoever starts answering a question holds it (`hold`, 30 s, renewed while typing); others see "Aarav is answering".

## Trust

The phone channel's rule holds: **a Mac trusts a key, not a server.**

- Every pond has a random 32-byte **pond key**. Every document is sealed with it (AES-256-GCM, AAD = its path), so the cloud
  holds opaque boxes.
- Each member has a P-256 **member key** per Mac. Every command is signed; the receiving Mac checks membership, role, the thread
  not being private, expiry (≤ 10 min) and a fresh nonce, then runs it through the host's normal send path.
- An invite is a code carrying pond id, pond key, store location and one-time secret. Using it writes a join request; **a person on
  an owner's Mac must approve it**, as pairing does. The approval, signed by the owner, is what adds the member.
- Removing a member rotates the pond key (a new key sealed to each remaining member's public key).
- A guest's message drives an agent on the starter's Mac. So a thread running with `bypassPermissions` refuses other members'
  messages, and they never match the thread's "allow for this chat" rules unless its starter opts in.
- Accounts (Catalyst sign-in) are a seam: `member.accountId` is optional today. Identity today is the member key and a display name.

## Transport

`CloudStore` (`src/cloud/store.ts`), so Catalyst or Firebase, chosen by `cloud.json`. `watch` is the wake-up (Data Streams on
Catalyst, SSE on Firebase); a stream event never carries data and the reader re-reads through the store.

One channel per pond: `channels/<pondChannelId>/<kind>/<doc>`. New kinds, added to the relay's `kinds.json` and the RTDB rules:

| kind | doc | contents |
|---|---|---|
| `pond` | `meta` | name, owner, gitRemote?, created |
| `members` | member id | name, public key, role, nest name, owner's signature |
| `joins` | request id | name, public key, one-time secret proof |
| `threads` | thread id | title, starter, nest, agent, model, state, private, mode, updated |
| `tevents` | `<thread>-<seq>` | a batch of normalized thread events |
| `presence` | member id | online, viewing thread, typing; expires in 60 s |
| `holds` | request id | who is answering, expires in 30 s |
| `tcmds` | command id | a signed message, steer or answer |
| `ripples` | time-ordered id | one activity line |
| `keys` | member id | the rotated pond key sealed to that member |

Live output is batched at 250 ms, never token by token. Each event has a per-thread `seq`; a client resumes from its last `seq`.
`tevents` keeps the newest 500 per thread; the starter's Mac remains the source of history.

Normalized event (`ThreadEvent`): `{ seq, at, type, ... }`, with type one of `user` (`by`, `text`), `agent` (`text`), `thinking` (`text`),
`tool` (`label`, `state`), `question` (`requestId`, `text`, `options`), `approval` (`requestId`, `label`; shown, never answerable
remotely), `resolved` (`requestId`), `state` (`state`), `changed` (`files`, `added`, `removed`, `paths` up to 200, and per-file `diff`
up to 64 KB on request through `tcmds` `diff`).

## Host routes (`x-squeak-token`, no CORS, under `/native`)

| route | body | answer |
|---|---|---|
| `GET /ponds` | | `{ ponds: [PondSummary] }` |
| `POST /ponds` | `{ name, projectId? , rootPath? }` | `{ pond }` |
| `GET /ponds/<id>` | | `{ pond, members, threads, ripples, presence, holds, joins, me }` |
| `DELETE /ponds/<id>/members/<memberId>` | | owner only; rotates the key |
| `POST /ponds/<id>/invites` | `{ role }` | `{ code, expiresAt }` |
| `POST /ponds/join` | `{ code, displayName }` | `{ pondId, status: "pending" }` |
| `POST /ponds/<id>/joins/<requestId>` | `{ approve, role }` | `{ ok }` |
| `POST /ponds/<id>/threads` | `{ text, agent, model }` | own thread on this Nest; needs a git remote |
| `POST /ponds/<id>/share` | `{ sessionId, private? }` | publishes a host chat as a thread |
| `POST /ponds/<id>/threads/<tid>/visibility` | `{ private }` | starter only |
| `GET /ponds/<id>/threads/<tid>/events?after=<seq>` | | `{ events, lastSeq }` |
| `POST /ponds/<id>/threads/<tid>/messages` | `{ text, mode?: "queue"\|"steer" }` | `{ ok, queued }` |
| `POST /ponds/<id>/threads/<tid>/answers` | `{ requestId, answer }` | `{ ok }` or 409 with who holds it |
| `POST /ponds/<id>/threads/<tid>/hold` | `{ requestId }` | `{ ok, heldBy }` |
| `POST /ponds/<id>/presence` | `{ viewing?, typing? }` | `{ ok }` |
| `GET /ponds/stream` | | SSE; `event: changed`, data `{ pondId }`, never content |

Shapes: `PondSummary { id, name, role, memberCount, threadCount, needsYou, gitRemote?, tint }`; `Member { id, name, role, nest, online, you }`;
`PondThread { id, title, starter, starterName, nest, agent, model, state, private, mode: "own"|"shared", sessionId?, updatedAt }`;
`Ripple { id, at, actor, text }`; `Hold { requestId, by, byName, until }`. Roles: `owner`, `member`, `viewer` (viewers only watch).

## Not yet

Catalyst sign-in, a push path, scheduling across Nests, handoffs, Eggs and tasks, file locks, shared secrets. Real use needs a
deployed relay with the new kinds; that deploy and any cloud project are the owner's to start.
