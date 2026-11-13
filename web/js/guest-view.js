// The web guest's screens: join, waiting, the pond, a thread. Everything the pond supplied (a name, a title, an agent's
// words) goes in as a text node through `h`, never as HTML. What a screen says is decided in guest-model.js; this only
// draws, in the people-first way DESIGN.md asks: plain words, big text, one hand on a phone. No code panes, no file trees.

import { h, svg } from "./dom.js";
import { bellIcon, chatsIcon, shieldIcon } from "./icons.js";
import { welcomeLayout, wlButton, wlError, wlProgress } from "./welcome-view.js";
import { agentName, ago, stripMarkdown } from "./format.js";
import {
  answeringLine,
  awayLine,
  changedLine,
  composerBlock,
  flockLine,
  groupThreads,
  hueOf,
  initial,
  limitsLine,
  pondLine,
  waitingLine,
  QUEUE_HINT,
  stateMark,
  toolsLine,
} from "./guest-model.js";

const iso = (ms) => new Date(ms).toISOString();

const glyph = (path, size = 18) =>
  svg(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    svg("path", { d: path }),
  );
const triangleAlert = (size) =>
  glyph("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01", size);
const circleX = (size) => glyph("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6M9 9l6 6", size);
const chevronLeft = () => glyph("m15 18-6-6 6-6", 22);

/** Three dots that pulse: the working mark. Motion stops under reduced motion (guest.css). */
export const dots = () => h("span", { class: "g-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i"));

/** The state's mark with its words for a screen reader; nothing when finished. */
export function markNode(state) {
  const mark = stateMark(state);
  if (!mark.kind) return null;
  const inner = mark.kind === "working" ? dots() : mark.kind === "waiting" ? triangleAlert(18) : circleX(18);
  return h("span", { class: `g-mark ${mark.kind}`, role: "img", "aria-label": mark.word, title: mark.word }, inner);
}

export function avatar(name, { you = false, online = false } = {}) {
  return h(
    "span",
    { class: `g-avatar hue-${hueOf(name)}${you ? " you" : ""}`, "aria-hidden": "true" },
    initial(name),
    online ? h("i", { class: "on" }) : null,
  );
}

const brand = () =>
  h(
    "header",
    { class: "g-brand" },
    h("img", { src: "assets/squeak-duck.svg", alt: "", width: 28, height: 28 }),
    h("span", null, "Squeak"),
  );

export const page = (...children) => h("main", { class: "g-page" }, brand(), ...children);

function button(label, onClick, { primary = false, quiet = false, type = "button", disabled = false } = {}) {
  return h(
    "button",
    { class: `g-btn${primary ? " primary" : ""}${quiet ? " quiet" : ""}`, type, onclick: onClick, disabled },
    label,
  );
}

const GUEST_POINTS = [
  { icon: bellIcon, text: "See what the flock's agents need" },
  { icon: chatsIcon, text: "Read and message shared threads" },
  { icon: shieldIcon, text: "The owner lets you in" },
];
const invite = (pondName, ownerName) => ({
  eyebrow: "You're invited to",
  title: pondName || "a pond",
  detail: ownerName ? `Shared by ${ownerName}` : "A pond is a few people's shared agent threads",
});
const guestCard = (invited, children) => welcomeLayout({ invite: invited, points: GUEST_POINTS, children });
const OWNER_LETS = "The owner has to let you in. Nothing is shared with you until they do.";

/** Signed in: who they will join as, and a way out if it is the wrong account. */
export function signedInScreen({ line, role, error, busy, onJoin, onSignOut, pondName = null, ownerName = null }) {
  return guestCard(invite(pondName, ownerName), [
    h("h1", null, line),
    h(
      "p",
      { class: "wl-lead" },
      role === "viewer"
        ? "You'll be able to watch this pond's threads."
        : "You'll be able to read this pond's shared threads and message them.",
    ),
    h(
      "div",
      { class: "wl-actions" },
      wlButton(busy ? "Asking\u2026" : "Join", onJoin, { primary: true, disabled: busy }),
      wlButton("Not you? Sign out", onSignOut, { quiet: true, disabled: busy }),
    ),
    wlError(error),
    h("p", { class: "wl-note" }, OWNER_LETS),
  ]);
}

/** Signed out: one way in, through Catalyst's hosted login. */
export function signInScreen({ pondName, error, onSignIn, onCancel }) {
  return guestCard(invite(pondName), [
    h("h1", null, `Join ${pondName}`),
    h("p", { class: "wl-lead" }, "Sign in so the owner knows who is asking. You'll come straight back here."),
    h(
      "div",
      { class: "wl-actions" },
      wlButton("Continue with Zoho, Google or email", onSignIn, { primary: true }),
      wlButton("Cancel", onCancel, { quiet: true }),
    ),
    wlError(error),
    h("p", { class: "wl-note" }, "Signing in only says who you are. The owner still has to let you in."),
  ]);
}

export function waitingScreen({ pondName, ownerName, requestedAt = null, expiresAt = null, onCancel }) {
  return guestCard(invite(pondName, ownerName), [
    h("h1", null, `Waiting for ${ownerName || "the owner"} to let you in`),
    h("p", { class: "wl-lead", role: "status" }, waitingLine(pondName, ownerName, requestedAt, expiresAt)),
    wlProgress(),
    h("div", { class: "wl-actions" }, wlButton("Withdraw my request", onCancel, { quiet: true })),
  ]);
}

/** A screen that ends something: an invite that cannot be used, a refusal, a removal. */
export function endScreen({ title, body, action }) {
  return welcomeLayout({
    points: GUEST_POINTS,
    children: [
      h("h1", null, title),
      h("p", { class: "wl-lead" }, body),
      action ? h("div", { class: "wl-actions" }, wlButton(action.label, action.onClick, { primary: true })) : null,
    ],
  });
}

/** The pond: its name, the Flock, and its shared threads. */
export function pondScreen({ view, now, onOpen, onLeave }) {
  const groups = groupThreads(view.threads);
  let leaving = false;
  const leave = button(
    "Leave this pond",
    () => {
      if (!leaving) {
        leaving = true;
        leave.textContent = "Tap again to leave";
        return;
      }
      onLeave();
    },
    { quiet: true },
  );
  return page(
    h("h1", null, view.pond.name),
    h("p", { class: "g-lead" }, pondLine(view)),
    h("p", { class: "g-quiet" }, limitsLine(view.me.role)),
    h(
      "section",
      { class: "g-section", "aria-label": "People in this pond" },
      h("h2", null, "Flock"),
      h("p", { class: "g-quiet" }, "The flock is everyone in this pond."),
      h(
        "ul",
        { class: "g-flock" },
        view.members.map((m) =>
          h(
            "li",
            null,
            avatar(m.name, { you: m.you, online: m.online }),
            h(
              "span",
              { class: "g-person" },
              h("strong", null, m.you ? `${m.name} (you)` : m.name),
              h("small", null, flockLine(m, view.threads)),
            ),
          ),
        ),
      ),
    ),
    groups.length === 0
      ? h("p", { class: "g-quiet" }, "No threads are shared with the pond yet.")
      : groups.map((group) =>
          h(
            "section",
            { class: "g-section", "aria-label": group.title },
            h("h2", null, group.title),
            h(
              "div",
              { class: "g-cards" },
              group.threads.map((t) =>
                h(
                  "button",
                  { class: "g-card", type: "button", onclick: () => onOpen(t.id) },
                  h(
                    "span",
                    { class: "g-card-main" },
                    h("strong", null, t.title),
                    h("small", null, `${t.starterName} · ${agentName(t.agent)}`),
                  ),
                  markNode(t.state),
                  h("small", { class: "g-age" }, ago(iso(t.updatedAt), now)),
                ),
              ),
            ),
          ),
        ),
    h(
      "footer",
      { class: "g-foot" },
      h("p", { class: "g-quiet" }, `You're here as ${view.me.name}, from this browser.`),
      leave,
    ),
  );
}

/** A question with options and a free answer. Stateful, so a redraw keeps what is typed and who is answering. */
function questionCard(row, handlers) {
  const status = h("p", { class: "g-status", "aria-live": "polite" });
  const input = h("input", {
    class: "g-field",
    type: "text",
    placeholder: "Something else…",
    "aria-label": "Your answer",
    maxlength: 2000,
  });
  const answer = (text) => {
    const value = text.trim();
    if (value) handlers.onAnswer(row.requestId, value);
  };
  const buttons = row.options.map((option) => button(option, () => answer(option)));
  const send = button("Answer", () => answer(input.value), { primary: true });
  input.addEventListener("input", () => handlers.onHold(row.requestId));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      answer(input.value);
    }
  });
  const body = h(
    "div",
    { class: "g-q-body" },
    h("div", { class: "g-options" }, buttons),
    h("div", { class: "g-q-free" }, input, send),
  );
  const node = h(
    "article",
    { class: "g-q" },
    h("p", { class: "g-q-text" }, stripMarkdown(row.text, { keepLines: true })),
    body,
    status,
  );
  return {
    node,
    update({ open, holder, sent, meId }) {
      const someone = holder && holder.by !== meId ? `${holder.byName} is answering` : null;
      body.hidden = !open;
      node.classList.toggle("done", !open);
      for (const control of [...buttons, input, send]) control.disabled = Boolean(someone) || Boolean(sent);
      status.textContent = !open
        ? "Answered."
        : someone
          ? someone
          : sent
            ? "Sent. Waiting for the thread's starter to pass it on."
            : holder
              ? "You're answering."
              : "";
    },
  };
}

function approvalCard(row, starterName) {
  return h(
    "article",
    { class: `g-approval${row.open ? "" : " done"}` },
    h("span", { class: "g-mark waiting" }, triangleAlert(20)),
    h(
      "div",
      null,
      h("strong", null, stripMarkdown(row.label)),
      h("small", null, row.open ? `Waiting for ${starterName} to approve` : "Handled."),
    ),
  );
}

/**
 * A thread: the conversation, a composer. `update(model)` redraws what changed and keeps the draft, the focus and
 * the cards' state. Messages go through `handlers.onSend(text, "queue" | "steer")`; there is no stop and no approve.
 */
export function createThreadScreen(handlers) {
  const title = h("h1", { class: "g-thread-title" });
  const sub = h("p", { class: "g-quiet" });
  const markSlot = h("span", { class: "g-mark-slot" });
  const timeline = h("div", { class: "g-timeline", role: "log", "aria-label": "Conversation" });
  const cards = new Map();
  const hint = h("p", { class: "g-hint" });
  const block = h("p", { class: "g-block" });
  // A refusal, a send that cannot be confirmed, the connection going away: said here, where the person is looking.
  const note = h("p", { class: "g-note", role: "alert" });
  note.hidden = true;
  const away = h("p", { class: "g-quiet", role: "status" });
  away.hidden = true;
  const box = h("textarea", {
    class: "g-box",
    rows: 1,
    placeholder: "Message the agent",
    "aria-label": "Message",
    enterkeyhint: "send",
  });
  const steer = button("Steer", () => submit("steer"), {});
  const send = button("Send", () => submit("queue"), { primary: true });
  steer.hidden = true;

  const submit = (mode) => {
    const text = box.value.trim();
    if (!text || box.disabled) return;
    box.value = "";
    grow();
    handlers.onSend(text, mode);
  };
  const grow = () => {
    box.rows = Math.min(6, Math.max(1, box.value.split("\n").length));
  };
  box.addEventListener("input", grow);
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit("queue");
    }
  });
  const composer = h(
    "form",
    { class: "g-composer", onsubmit: (event) => event.preventDefault() },
    hint,
    h("div", { class: "g-compose-row" }, box, steer, send),
  );
  const back = h(
    "button",
    { class: "g-back", type: "button", onclick: handlers.onBack, "aria-label": "Back to the pond" },
    chevronLeft(),
  );

  const node = page(
    h("div", { class: "g-thread-head" }, back, h("div", null, title, sub), markSlot),
    timeline,
    block,
    note,
    away,
    composer,
  );

  const bubble = (who, text, { mine = false, extra = null } = {}) =>
    h(
      "div",
      { class: `g-msg ${mine ? "mine" : "theirs"}` },
      h("small", null, mine ? "You" : who),
      h("p", null, text),
      extra,
    );

  function update(m) {
    const near = document.scrollingElement
      ? document.scrollingElement.scrollHeight - document.scrollingElement.scrollTop - window.innerHeight < 160
      : true;
    title.textContent = m.thread.title;
    sub.textContent = `${m.thread.starterName} · ${agentName(m.thread.agent)}`;
    markSlot.replaceChildren(...[markNode(m.state)].filter(Boolean));
    const blocked = composerBlock(m.role, m.thread);
    block.hidden = !blocked;
    block.textContent = blocked ?? "";
    composer.hidden = Boolean(blocked);
    note.hidden = !m.note;
    note.textContent = m.note ?? "";
    const awayText = awayLine(m.thread);
    away.hidden = !awayText;
    away.textContent = awayText ?? "";
    steer.hidden = m.state !== "working";
    hint.textContent = m.state === "working" ? QUEUE_HINT : "Enter sends. Shift and Enter makes a new line.";
    const rows = [];
    let lastAgent = false;
    for (const row of m.rows) {
      switch (row.kind) {
        case "user":
          rows.push(bubble(row.who, row.text, { mine: row.mine }));
          lastAgent = false;
          break;
        case "agent":
          rows.push(
            h(
              "div",
              { class: "g-msg agent" },
              lastAgent ? null : h("small", null, agentName(m.thread.agent)),
              h("p", null, stripMarkdown(row.text, { keepLines: true })),
            ),
          );
          lastAgent = true;
          break;
        case "thinking":
          rows.push(
            h(
              "details",
              { class: "g-thinking" },
              h("summary", null, "Thinking"),
              h("p", null, stripMarkdown(row.text, { keepLines: true })),
            ),
          );
          break;
        case "tools":
          rows.push(
            h("p", { class: "g-step" }, row.steps.some((s) => s.state === "running") ? dots() : null, toolsLine(row)),
          );
          break;
        case "changed":
          rows.push(h("p", { class: "g-step" }, changedLine(row)));
          break;
        case "approval":
          rows.push(approvalCard(row, m.thread.starterName));
          break;
        case "question": {
          let card = cards.get(row.requestId);
          if (!card) cards.set(row.requestId, (card = questionCard(row, handlers)));
          card.update({
            open: row.open,
            holder: m.holds.find((x) => x.requestId === row.requestId) ?? null,
            sent: m.answered.has(row.requestId),
            meId: m.me.id,
          });
          rows.push(card.node);
          break;
        }
        default:
          break;
      }
    }
    for (const s of m.pending) {
      rows.push(
        bubble("You", s.text, {
          mine: true,
          extra: s.unconfirmed
            ? h(
                "p",
                { class: "g-status" },
                "Couldn't confirm it arrived. ",
                button("Put it back in the box", () => handlers.onTakeBack(s), { quiet: true }),
              )
            : h(
                "p",
                { class: "g-status" },
                s.mode === "steer"
                  ? "Steering. Waiting for the thread's starter."
                  : "Sent. Waiting for the thread's starter.",
              ),
        }),
      );
    }
    if (m.working) rows.push(h("p", { class: "g-step working" }, dots(), m.working));
    timeline.replaceChildren(...rows);
    if (near && document.scrollingElement) window.scrollTo(0, document.scrollingElement.scrollHeight);
  }

  return {
    node,
    update,
    /** Puts text back in the box (an unconfirmed message), without losing what is already there. */
    setDraft(text) {
      box.value = box.value ? `${box.value}\n${text}` : text;
      grow();
      box.focus();
    },
  };
}

/** The question's line for tests and the pond list: who is answering, if it is someone else. */
export { answeringLine };
