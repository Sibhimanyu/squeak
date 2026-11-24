// The Room screen for a web guest: the pond's group chat. A person's words are bubbles, a duck's post is one collapsed line
// that opens, a Task is a small card with its state. Everything the pond supplied goes in as a text node through `h`.
// What is shown is decided in guest-room-model.js; this only draws, and keeps the draft, the focus and what is open.

import { h, svg } from "./dom.js";
import { ago } from "./format.js";
import { page } from "./guest-view.js";
import { ownerOfflineLine, roomBlock, roomRows } from "./guest-room-model.js";

const iso = (ms) => new Date(ms).toISOString();
const chevronLeft = () =>
  svg(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 22,
      height: 22,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    svg("path", { d: "m15 18-6-6 6-6" }),
  );

/**
 * `update(model)` redraws what changed. `model` is `{ room, meId, pending, note, now }`; `handlers.onSend(text)` posts,
 * `handlers.onBack` leaves, `handlers.onTakeBack(pending)` puts an unconfirmed message back in the box.
 */
export function createRoomScreen(handlers) {
  const open = new Set();
  const title = h("h1", { class: "g-thread-title" }, "Room");
  const sub = h("p", { class: "g-quiet" });
  const timeline = h("div", { class: "g-timeline g-room", role: "log", "aria-label": "Room" });
  const empty = h("p", { class: "g-quiet" }, "Nothing in the Room yet.");
  const block = h("p", { class: "g-block" });
  const note = h("p", { class: "g-note", role: "alert" });
  note.hidden = true;
  const away = h("p", { class: "g-quiet", role: "status" });
  away.hidden = true;
  const hint = h("p", { class: "g-hint" }, "Enter sends. Shift and Enter makes a new line.");
  const box = h("textarea", {
    class: "g-box",
    rows: 1,
    placeholder: "Message the pond",
    "aria-label": "Message the Room",
    enterkeyhint: "send",
    maxlength: 2000,
  });
  const send = h("button", { class: "g-btn primary", type: "button", onclick: () => submit() }, "Send");
  const grow = () => {
    box.rows = Math.min(6, Math.max(1, box.value.split("\n").length));
  };
  const submit = () => {
    const text = box.value.trim();
    if (!text || box.disabled) return;
    box.value = "";
    grow();
    handlers.onSend(text);
  };
  box.addEventListener("input", grow);
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  const composer = h(
    "form",
    { class: "g-composer", onsubmit: (event) => event.preventDefault() },
    hint,
    h("div", { class: "g-compose-row" }, box, send),
  );
  const back = h(
    "button",
    { class: "g-back", type: "button", onclick: handlers.onBack, "aria-label": "Back to the pond" },
    chevronLeft(),
  );
  const node = page(
    h("div", { class: "g-thread-head" }, back, h("div", null, title, sub)),
    timeline,
    block,
    note,
    away,
    composer,
  );

  const when = (row, now) => (row.at ? ago(iso(row.at), now) : "");

  function personRow(row, now) {
    const status = row.pending
      ? row.pending.failed
        ? h(
            "p",
            { class: "g-status" },
            "Couldn't confirm it arrived. ",
            h(
              "button",
              { class: "g-btn quiet", type: "button", onclick: () => handlers.onTakeBack(row.pending) },
              "Put it back in the box",
            ),
          )
        : h("p", { class: "g-status" }, "Sent. It shows here once the owner's Mac has it.")
      : null;
    return h(
      "div",
      { class: `g-msg ${row.mine ? "mine" : "theirs"}${row.attention ? " attention" : ""}`, "data-id": row.id },
      h("small", null, [row.mine ? "You" : row.who, row.label, when(row, now)].filter(Boolean).join(" · ")),
      row.replyLine ? h("small", { class: "g-reply" }, row.replyLine) : null,
      h("p", null, row.text),
      status,
    );
  }

  /** A Member's comment on a spec+plan card: queued for the Owner's Mac, which hands it to the Duck at its next turn. */
  function commentBox(row) {
    const field = h("input", {
      class: "g-box g-comment-box",
      type: "text",
      placeholder: "Comment on this plan",
      "aria-label": `Comment on ${row.who}'s plan`,
      maxlength: 500,
    });
    const go = () => {
      const text = field.value.trim();
      if (!text) return;
      field.value = "";
      handlers.onComment?.(row.id, text);
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        go();
      }
    });
    return h(
      "div",
      { class: "g-comment" },
      field,
      h("button", { class: "g-btn quiet", type: "button", onclick: go }, "Comment"),
    );
  }

  function duckRow(row, now) {
    const head = h(
      "summary",
      null,
      h("strong", null, row.who),
      row.label ? h("span", { class: `g-kind${row.attention ? " attention" : ""}` }, ` ${row.label}`) : null,
      h("span", { class: "g-duck-text" }, ` ${row.summary}`),
    );
    const details = h(
      "details",
      { class: "g-duck", "data-id": row.id },
      head,
      h("p", null, row.text),
      row.detail ? h("p", { class: "g-detail" }, row.detail) : null,
      ...(row.canvases ?? []).map((c) =>
        h(
          "div",
          { class: "g-canvas", "data-id": c.id },
          h("strong", null, c.title),
          h("span", { class: "g-quiet" }, `${c.subtitle} \u00B7 View only`),
        ),
      ),
      row.canComment ? commentBox(row) : null,
      h("small", null, when(row, now)),
    );
    // Even a short line can be opened (its time and exact words); what is open stays open across redraws.
    details.open = open.has(row.id);
    details.addEventListener("toggle", () => {
      if (details.open) open.add(row.id);
      else open.delete(row.id);
    });
    return details;
  }

  function taskRow(row) {
    const t = row.task;
    return h(
      "div",
      { class: `g-task ${t.state}`, "data-id": row.id },
      h("small", null, "Task"),
      h("strong", null, t.title),
      h("span", { class: "g-task-state" }, row.words),
      t.result ? h("p", null, t.result) : null,
    );
  }

  function update(m) {
    const scroller = document.scrollingElement;
    const near = scroller ? scroller.scrollHeight - scroller.scrollTop - window.innerHeight < 160 : true;
    sub.textContent = [m.room.ownerName ? `Shared by ${m.room.ownerName}` : null].filter(Boolean).join(" · ");
    const rows = roomRows(m.room, m.meId, m.pending ?? []);
    const nodes = rows.map((row) =>
      row.kind === "duck" ? duckRow(row, m.now) : row.kind === "task" ? taskRow(row) : personRow(row, m.now),
    );
    timeline.replaceChildren(...(nodes.length ? nodes : [empty]));
    const closed = roomBlock(m.room);
    block.hidden = !closed;
    block.textContent = closed ?? "";
    composer.hidden = Boolean(closed);
    note.hidden = !m.note;
    note.textContent = m.note ?? "";
    away.hidden = m.room.ownerOnline;
    away.textContent = m.room.ownerOnline ? "" : ownerOfflineLine(m.room.ownerName);
    if (near && scroller) window.scrollTo(0, scroller.scrollHeight);
  }

  return {
    node,
    update,
    setDraft(text) {
      box.value = box.value ? `${box.value}\n${text}` : text;
      grow();
      box.focus();
    },
  };
}
