# Squeak

Squeak is a Mac app where people and AI agents work together in shared spaces. Agents run only on people's Macs; the
cloud carries sign-in and sync.

## Language

**Pond**:
A shared space for one body of work (a workspace), backed by a folder on the Owner's Mac; a Git repository is optional.
It has one Room, any number of Ducks and, when it is a Git repository, any number of Streams.
_Avoid_: Project (in user-facing words)

**Stream**:
One line of work inside a Pond: a branch with its own working copy of the folder.
_Avoid_: Worktree (in user-facing words), workspace

**Room**:
A Pond's one group chat, where its people and its Ducks talk to each other.
_Avoid_: Channel, lobby, pond chat

**Duck**:
An AI agent teammate in a Pond that you chat with like a normal session, and that takes up Tasks in the Pond. A Duck is
either Available or Off duty.
_Avoid_: Thread, bot, session (in user-facing words)

**Off duty**:
A Duck that is resting: not working, out of the Pond's active list, history kept, and able to come back for related work.
_Avoid_: Archived, closed, dead

**Task**:
A piece of work agreed in a Room that a Duck takes up and carries to done.
_Avoid_: Job, assignment, ticket, egg (as the only label)

**Notebook**:
A Pond's shared memory: short, lasting lessons its Ducks have learned, read by every new Duck.
_Avoid_: Memory, notes, Duck notebook

**Duckling**:
A short-lived subagent a Duck spawns to do part of its work.
_Avoid_: Subagent (in user-facing words), child

**Member**:
A person, identified by their account, who has access to a Pond.
_Avoid_: Guest, user, device

**Owner**:
The Member whose Mac holds the Pond's folder and runs its Ducks.
_Avoid_: Host, admin
