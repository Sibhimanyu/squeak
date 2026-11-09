---
name: squeak
description: Working inside Squeak, the app running this chat. Use when the person mentions Squeak, workspaces, the target branch, review comments, other chats or agents, handing work to another chat, progress, or being paged; or before opening a pull request, reviewing, or writing a changelog here.
---

# Working inside Squeak

Squeak runs this chat on the person's Mac and shows it on their Mac, phone, Telegram and Cliq. They are often away from the keyboard: be clear when you stop, and say what you need.

## Where you are

- A Squeak **workspace** is a git worktree on its own branch, under `~/squeak/workspaces/<project>/<name>`. Other chats may work in other worktrees of the same repository; never touch those folders.
- The workspace merges into a **target branch** (the project's default unless changed). `workspace_diff` and the Create PR action use it. Change it with `set_target_branch` only when the person asks to base the work elsewhere.
- `.context/` in the workspace is gitignored scratch space for notes and handoffs between chats.
- `SQUEAK_PORT` (when set) is the first of ten ports reserved for this workspace's scripts. Use it for dev servers so workspaces don't collide.

## Squeak's tools (the `squeak` MCP server)

- `workspace_diff`: the whole change against the target branch, including uncommitted and untracked files. Use it before a PR, a review or a changelog, not `git diff` alone.
- `review_comments`, `add_review_comment`, `resolve_review_comment`: the line comments in Squeak's Changes view. Address open ones when asked to "fix the comments"; resolve each one you addressed. Put review findings there rather than on GitHub unless asked.
- `notify_user`: page the person. Only when you stop and need them (something ready to look at, or a decision only they can make). At most once per turn.
- `update_progress`: a tracker above the composer for long multi-step work. Send the full state each time; `steps: []` when done.
- `list_chats`, `read_chat`, `send_to_chat`, `start_chat`: the other Squeak chats on this Mac (see below).

## Working with other chats

- Use your own subagents for short internal work. Use another Squeak chat when the work is long, parallel, should be watched or steered by the person, or needs a different agent (Claude or Codex).
- `start_chat` opens a chat in this same folder. Give it a self-contained brief: goal, files, constraints, how to check the result, and what to report back. Two chats editing the same files at once will collide; split the work by file or have one only read.
- `send_to_chat` delivers a message as a new turn there (queued if busy), marked as from you. Ask one clear thing. Then continue your own work and check back later with `read_chat`; don't poll in a tight loop.
- Messages are limited per hour. If a chat doesn't answer usefully, tell the person rather than retrying.
- Never pass secrets between chats.

## Finishing

When you end a turn, the last message is what the person reads on a lock screen: lead with the outcome, then anything they must decide. If you ask them to choose, put the question first and the options as `A) ...` lines; Squeak turns them into buttons.
