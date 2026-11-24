# No coordinator agent in a Pond

A Pond's Room has no lead or coordinator agent. Squeak's own code makes Tasks and routes them with a score-based decider
(text similarity first, then a small model only when unsure: Apple's on-device model by default, Haiku as an option),
and Ducks coordinate only through the Room and the Task list, handing work off by @mention.

We rejected a master bot because it must wake on every message (cost grows with chatter), it is a single bottleneck and
point of failure, its knowledge of who-does-what lives in one context window instead of readable data, and people end up
talking to a middleman instead of their Ducks. The decider runs only when a Task is made, holds no memory between Tasks,
and never chats. The owner rejected a "pond lead" on 2026-11-17 and again on 2026-11-24 after weighing it.
