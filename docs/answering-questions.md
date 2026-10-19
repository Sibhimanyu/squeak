# Answering an agent's questions from Squeak

Owner, 2026-10-19: when Claude (or any agent) asks "should we do A or B?", or
Conductor shows a question pop-up, Squeak for iPhone (and the Mac app) should
show it as a proper, native UI generated from the question itself — options to
pick, a field to type an answer — and deliver the answer to that chat.

## What can be waiting on you

| Kind                          | Where it comes from                                                                                                                                                                                      | What the human gives                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Question**                  | `AskUserQuestion` / `mcp__conductor__AskUserQuestion` tool call, pending (no `tool_result` yet). Input: `questions[]` of `{header?, question, multiSelect?, options[]: string \| {label, description?}}` | One or more options per question (one, or any with `multiSelect`), or their own words ("Other") |
| **Plan**                      | `ExitPlanMode` pending                                                                                                                                                                                   | Approve, or keep planning with a note                                                           |
| **Lettered options in prose** | The agent's last message ends with `A. … / B. …` (already parsed: `Choices`)                                                                                                                             | A letter or free text — this is a normal reply and already works                                |
| **Permission**                | `PermissionRequest` hook (approve a tool call)                                                                                                                                                           | Allow / deny — out of scope here; Conductor alone can answer it (see "Not in scope")            |

Detection is already in place (`src/fleet/pending-question.ts`, Swift
`PendingQuestion`): a chat with a pending question is "needs you" even while
Conductor says working. The Mac now also publishes the whole question to the
phone (b84bb91).

## Delivering an answer: three routes, best first

Conductor 0.91.1's Remote Control API answers `answer-question` and
`respond-to-plan` with **501**, so there is no first-class API today.

1. **Conductor's own API** (`POST …/sessions/:sid/answer-question`,
   `…/respond-to-plan`). Probed once per Conductor version; used automatically
   the day it stops returning 501. Exact, and works with the screen locked.
2. **Answer the pop-up itself** with Squeak Hands (Accessibility), when the Mac
   is unlocked and Conductor is running: prove the chat on screen from the web
   area's `AXURL` (as replies do), prove the open pop-up's question text matches
   the pending tool call, select the chosen options / type "Other", press
   Submit. Exactly what clicking would do. Refuses when anything doesn't match,
   and guarantees nothing was clicked in that case.
3. **Stop and answer** (works locked, through the relay): `POST …/sessions/:sid/stop`
   ends the waiting turn, then the answer is sent as the next message, written
   so the agent can't misread it:
   `Answer to your question "Where do you want …?": Squeak window, iPhone app.`
   The UI says so plainly before you send ("Squeak will stop the question and
   send your answer as a message").

Route choice is automatic (1 → 2 → 3) and the result says which one ran
("Answered in Conductor" / "Answered — sent as a message after stopping the
question"). Confirmation is always read back from `session_messages` (the
`tool_result`, or the new user row); an answer is never sent twice, the same
rule as replies.

## The phone command

A new signed command kind, like `start`:

```
{ v: 1, kind: "answer", sessionId, toolUseId,
  answers: [{ question: 0, picked: ["Squeak window", "iPhone app"], other?: "…" }],   // Question
  plan?: { approve: true } | { approve: false, note: "…" },                           // Plan
  nonce, expiresAt }
```

The Mac keeps every reply check (paired unrevoked key, signature, ≤10 min,
fresh nonce) and adds: the chat's pending tool call is **still** `toolUseId`
(answering a question that has moved on is refused, like the reply's
current-turn rule); every picked label exists in that question; single-select
questions get exactly one pick; `other` ≤ 2,000 characters; one answer per
question; rate limit as for starts. Unknown fields are refused.

## The UI (both apps, generated from the question)

One **question card**, built from the tool call's own data — nothing
hand-written per question:

- The question's `header` as a small label; the question in the body type.
- Options as large tappable rows (§8.4 decision rows): letter chip, label,
  description in `muted`. Single-select behaves like radio buttons;
  `multiSelect` shows checkboxes and says "Choose any".
- "Something else…" opens a text field for the human's own words (the
  equivalent of Conductor's Other).
- Several questions in one call: shown one after another in the card with
  "1 of 2"; Send is enabled when each is answered; a one-line summary of the
  answers above Send.
- Plans: the plan rendered with `MessageText`, then **Approve** (primary) and
  **Keep planning** with a note.
- Send goes through Face ID on the phone; then the card shows one status line
  (route and confirmation), and the "working" row resumes.
- When no route can deliver (e.g. the Mac is locked and the relay is down), the
  card still shows the question, with the reason and "Open in Conductor".
- Notifications/Telegram/Cliq: the push says the question in a line;
  single-select questions get one button per option where the channel allows.

DESIGN.md rules apply: §8.4 decision rows, "recommended" only if the agent
marks one, sentence case, §3.3 colours (red only for the "needs you" accent).

## Not in scope (for now)

- **Permission prompts** (allow this tool call?). Conductor's frontend owns
  them and the relay can't answer them; approving tool use from a phone is a
  security decision of its own. Shown as "needs approval" with Open in
  Conductor, as today.

## Plan

1. **Spike (delivery):** on a throwaway chat only — confirm route 3 (stop +
   send) end to end and what the agent sees; prototype route 2 on the real
   pop-up (AX tree of Conductor's question modal, how options and Submit are
   exposed); re-probe route 1. Record evidence in `.context/re/`.
2. **Mac side:** `POST /control/session/<id>/answer` (token-gated) + the
   delivery chain + confirmation; the `answer` phone command in
   `RemoteBridge.handleCommand`; tests for every refusal.
3. **UI:** the question card in the Mac window and popover, and on the phone
   (extending b84bb91's display), plan approval card; demo data and captures.
4. **Fixtures + e2e** for the new command (Swift ↔ Node byte-for-byte), docs in
   `docs/remote-channel.md`.
5. Release (service, Mac, iPhone).
