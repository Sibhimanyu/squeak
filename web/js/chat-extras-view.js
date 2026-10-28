// The chat's extras, drawn (WP3): the stuck notice, the background strip, the
// composer's photos, pictures in messages, the "Earlier messages" row, the
// chat menu, the model and thinking picker, and the dialogs. Everything the
// channel supplied goes in as text nodes; a picture is an `<img>` whose
// `data:` URI the images module has already checked.

import {
  CONFIRM,
  levelName,
  messageImages,
  imageName,
  stuckLine,
  taskRow,
  stripOpen,
  taskSummary,
  imageFiles,
} from "./chat-extras-logic.js";
import { diffBody } from "./diff-view.js";
import { h } from "./dom.js";
import { setupLine } from "./format.js";
import { subagentBody } from "./subagent-sheet.js";
import { tasks as readTasks } from "./view-model.js";

/* ---------- notices ---------- */

/** A working chat with no word from the model for minutes. The Mac decides it is stuck; this only says so. */
export function stuckNotice({ stalled, canStop, stopping, stop, now = Date.now() }) {
  return h(
    "div",
    { class: "xnotice stuck", role: "status" },
    h(
      "div",
      { class: "grow" },
      h("div", { class: "xtitle" }, "Seems stuck"),
      h("div", { class: "note" }, stuckLine(stalled, now)),
      h(
        "div",
        { class: "note" },
        canStop ? "Stop it, then reply to run the turn again." : "Stop it on your Mac, then try again.",
      ),
    ),
    canStop
      ? h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: stopping,
            "aria-label": stopping ? "Stopping" : "Stop the agent",
            onclick: stop,
          },
          stopping ? "Stopping…" : "Stop",
        )
      : null,
  );
}

/** What a menu action said (closed, couldn't archive, a PR asked for), with a way to dismiss it. */
export function noticeLine(x, session) {
  const n = x.notice(session.key);
  if (!n) return null;
  return h(
    "div",
    { class: n.bad ? "xnotice bad" : "xnotice", role: n.bad ? "alert" : "status" },
    h(
      "div",
      { class: "grow" },
      n.title ? h("div", { class: "xtitle" }, n.title) : null,
      h("div", { class: "note" }, n.line),
    ),
    n.busy
      ? null
      : h("button", { class: "btn quiet", type: "button", onclick: () => x.dismissNotice(session.key) }, "OK"),
  );
}

/** The chat's subagents and background shells while it works; null when there are none. */
export function taskStrip(x, session, now = Date.now()) {
  const tasks = readTasks(session);
  if (!tasks) return null;
  const open = stripOpen(tasks, x.stripChosen(session.key));
  const summary = taskSummary(tasks);
  return h(
    "div",
    { class: "xstrip", "aria-label": "Background work" },
    h(
      "button",
      {
        class: "xstriphead",
        type: "button",
        "aria-expanded": String(open),
        "aria-label": `Background work: ${summary}`,
        onclick: () => x.toggleStrip(session.key, open),
      },
      h("span", { class: "grow" }, summary),
      h("span", { class: open ? "xchev up" : "xchev", "aria-hidden": "true" }),
    ),
    open
      ? tasks.map((task) => {
          const row = taskRow(task, now);
          const inner = [
            h("span", { class: "xticon", "aria-hidden": "true" }, row.icon === "agent" ? "Agent" : "Shell"),
            h(
              "span",
              { class: "grow" },
              h("span", { class: "xtlabel" }, task.label),
              row.showSummary ? h("span", { class: "xdesc" }, task.summary) : null,
            ),
            h(
              "span",
              { class: `xtstatus ${row.word}` },
              row.word === "running" ? h("span", { class: "dot live", "aria-hidden": "true" }) : null,
              row.word === "done" ? (row.time ?? "done") : row.word === "running" ? (row.time ?? "") : row.word,
            ),
          ];
          return row.canOpen
            ? h(
                "button",
                {
                  class: "xtask open",
                  type: "button",
                  "aria-label": `${task.label}: show its steps`,
                  onclick: () => void x.openSubagent(session, task),
                },
                ...inner,
              )
            : h("div", { class: "xtask" }, ...inner);
        })
      : null,
  );
}

/* ---------- photos ---------- */

/** Thumbnails of the photos waiting to go with the message, each removable, and what went wrong. */
export function photoBar(x, session) {
  const st = x.photoState(session.key);
  if (st.list.length === 0 && !st.problem) return null;
  return h(
    "div",
    { class: "xphotos" },
    st.list.length > 0
      ? h(
          "div",
          { class: "xthumbs" },
          st.list.map((photo) =>
            h(
              "div",
              { class: photo.state === "error" ? "xthumb bad" : "xthumb" },
              photo.uri
                ? h("img", { src: photo.uri, alt: `Photo to send: ${photo.name}` })
                : h("span", { class: "note" }, photo.state === "error" ? photo.error : "Preparing…"),
              h(
                "button",
                {
                  class: "xremove",
                  type: "button",
                  "aria-label": `Remove ${photo.name}`,
                  disabled: st.busy,
                  onclick: () => x.removePhoto(session, photo.id),
                },
                "×",
              ),
            ),
          ),
        )
      : null,
    st.busy ? h("p", { class: "note", role: "status" }, "Sending the photos to your Mac…") : null,
    st.problem ? h("p", { class: "line bad", role: "alert" }, st.problem) : null,
  );
}

/** The paperclip: a button and the (hidden) file picker it opens. Null where photos cannot go. */
export function attachButton(x, session) {
  if (!x.canAttach(session)) return null;
  const input = h("input", {
    class: "xfile-input",
    type: "file",
    accept: "image/*",
    multiple: true,
    tabindex: "-1",
    "aria-hidden": "true",
  });
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    void x.addFiles(session, files);
  });
  const busy = x.photoState(session.key).busy;
  return h(
    "span",
    { class: "xattach" },
    input,
    h(
      "button",
      { class: "btn", type: "button", disabled: busy, "aria-label": "Attach photos", onclick: () => input.click() },
      "+ Photo",
    ),
  );
}

/** Pasting an image into the box, or dropping one on the composer, attaches it. */
export function bindPhotoDrops(area, zone, x, session) {
  if (!x.canAttach(session)) return;
  area.addEventListener("paste", (event) => {
    const files = imageFiles(event.clipboardData?.files);
    if (files.length === 0) return;
    event.preventDefault();
    void x.addFiles(session, files);
  });
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  zone.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.add("dropping");
  });
  zone.addEventListener("dragleave", (event) => {
    if (event.target === zone) zone.classList.remove("dropping");
  });
  zone.addEventListener("drop", (event) => {
    zone.classList.remove("dropping");
    if (!hasFiles(event)) return;
    event.preventDefault();
    void x.addFiles(session, Array.from(event.dataTransfer.files));
  });
}

/* ---------- pictures in the timeline ---------- */

function imageTile(x, session, image) {
  const state = x.imageState(session, image);
  const name = imageName(image);
  if (state.phase === "loaded") {
    return h(
      "button",
      { class: "ximg", type: "button", "aria-label": `${name}: enlarge`, onclick: () => x.viewImage(session, image) },
      h("img", { src: state.uri, alt: name }),
    );
  }
  const loading = state.phase === "loading";
  return h(
    "button",
    {
      class: "ximg idle",
      type: "button",
      disabled: loading,
      "aria-label": `Image: ${name}. Loads it from your Mac`,
      onclick: () => void x.loadImage(session, image, { thenView: false }),
    },
    h("span", { class: "xtlabel" }, name),
    h(
      "span",
      { class: "xdesc" },
      state.phase === "failed" ? state.reason : loading ? "Loading from your Mac…" : "Image · tap to show",
    ),
  );
}

/**
 * A message's words and the pictures it names. `render(text)` draws the words (the caller's own paragraph or
 * bubble); a message that is only pictures shows only them.
 */
export function messageBody(x, session, text, render) {
  if (!x) return [render(text)];
  const { body, images } = messageImages(text);
  const out = [];
  if (body !== "" || images.length === 0) out.push(render(body));
  if (images.length > 0)
    out.push(
      h(
        "div",
        { class: "ximgs" },
        images.map((image) => imageTile(x, session, image)),
      ),
    );
  return out;
}

/* ---------- earlier history ---------- */

export function earlierNode(x, session) {
  switch (x.earlierRowKind(session)) {
    case "sentinel":
      return h(
        "button",
        { class: "btn quiet xearlier", type: "button", onclick: () => void x.loadEarlier(session, true) },
        "Earlier messages",
      );
    case "loading":
      return h("p", { class: "note xearlier", role: "status" }, "Loading earlier messages…");
    case "failed":
      return h(
        "button",
        { class: "btn quiet xearlier", type: "button", onclick: () => void x.loadEarlier(session, true) },
        "Couldn't load earlier messages. Try again.",
      );
    case "start":
      return h("p", { class: "note xearlier" }, "Start of chat");
    default:
      return null;
  }
}

/* ---------- the menu and the setup picker ---------- */

/** The chat's "…" menu. */
export function menuNode(x, session) {
  const open = x.menuOpen === session.key;
  const items = x.menu(session);
  const list = [];
  let section = null;
  for (const item of items) {
    if (item.section && item.section !== section) {
      section = item.section;
      list.push(h("div", { class: "xmenusection", role: "presentation" }, section));
    }
    list.push(
      h(
        "button",
        {
          class: item.danger ? "xmenuitem danger" : "xmenuitem",
          type: "button",
          role: "menuitem",
          disabled: !item.enabled,
          title: item.why ?? false,
          onclick: () => void x.runMenu(session, item.id),
        },
        item.label,
        item.why ? h("span", { class: "xdesc" }, item.why) : null,
      ),
    );
  }
  return h(
    "div",
    { class: "xmenuwrap" },
    h(
      "button",
      {
        class: "btn quiet",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": String(open),
        "aria-label": "Chat options",
        onclick: () => x.toggleMenu(session.key),
      },
      "More",
    ),
    open
      ? h("button", {
          class: "xscrim",
          type: "button",
          tabindex: "-1",
          "aria-hidden": "true",
          onclick: () => x.closeMenu(),
        })
      : null,
    open ? h("div", { class: "xmenu", role: "menu" }, list) : null,
  );
}

/** The muted "Opus 5.5 · Medium" line; a tap opens the model and thinking choices when the Mac offers them. */
export function setupNode(x, session) {
  const pending = x.pendingSetup(session.key);
  const line = pending ?? setupLine(session);
  if (!line) return null;
  const models = x.setupChoices(session);
  const busy = x.setupBusy.has(session.key);
  const midTurn = ["working", "awaiting_approval", "awaiting_input"].includes(session.state);
  if (models.length === 0) return h("div", { class: "meta setup", "aria-label": `Runs ${line}` }, line);
  const open = x.setupOpen === session.key;
  const current = models.find((m) => m.id === session.modelId) ?? null;
  const panel = [];
  if (open) {
    panel.push(h("div", { class: "xmenusection", role: "presentation" }, "Model"));
    for (const m of models) {
      panel.push(
        h(
          "button",
          {
            class: "xmenuitem",
            type: "button",
            role: "menuitemradio",
            "aria-checked": String(m.id === session.modelId),
            disabled: busy,
            onclick: () => void x.changeSetup(session, m, {}),
          },
          h("span", { class: "xcheck", "aria-hidden": "true" }, m.id === session.modelId ? "✓" : ""),
          m.label,
        ),
      );
    }
    if (current && current.levels.length > 0) {
      panel.push(h("div", { class: "xmenusection", role: "presentation" }, "Thinking"));
      for (const level of current.levels) {
        panel.push(
          h(
            "button",
            {
              class: "xmenuitem",
              type: "button",
              role: "menuitemradio",
              "aria-checked": String(level === session.effortId),
              disabled: busy,
              onclick: () => void x.changeSetup(session, current, { thinking: level }),
            },
            h("span", { class: "xcheck", "aria-hidden": "true" }, level === session.effortId ? "✓" : ""),
            levelName(level),
          ),
        );
      }
    }
    if (current && session.agent === "claude") {
      panel.push(h("div", { class: "xmenusection", role: "presentation" }, "Speed"));
      panel.push(
        h(
          "button",
          {
            class: "xmenuitem",
            type: "button",
            role: "menuitemcheckbox",
            "aria-checked": String(session.fast === true),
            disabled: busy,
            onclick: () => void x.changeSetup(session, current, { fast: session.fast !== true }),
          },
          h("span", { class: "xcheck", "aria-hidden": "true" }, session.fast === true ? "✓" : ""),
          "Fast mode",
        ),
      );
    }
  }
  return h(
    "div",
    { class: "xmenuwrap setupwrap" },
    h(
      "button",
      {
        class: "meta setup xsetupbtn",
        type: "button",
        disabled: midTurn,
        "aria-expanded": String(open),
        "aria-label": `Runs ${line}. ${midTurn ? "Can be changed once this turn ends." : "Changes the model or thinking level."}`,
        onclick: () => x.toggleSetup(session.key),
      },
      line,
      midTurn ? null : h("span", { class: "xchev", "aria-hidden": "true" }),
    ),
    open
      ? h("button", {
          class: "xscrim",
          type: "button",
          tabindex: "-1",
          "aria-hidden": "true",
          onclick: () => x.toggleSetup(session.key),
        })
      : null,
    open ? h("div", { class: "xmenu", role: "menu" }, panel) : null,
  );
}

/* ---------- dialogs ---------- */

function dialogShell({ title, subtitle = null, body, onClose, back = null, wide = false, tone = "" }) {
  return h(
    "div",
    { class: "xlayer" },
    h("button", { class: "xbackdrop", type: "button", tabindex: "-1", "aria-label": "Close", onclick: onClose }),
    h(
      "div",
      {
        class: `xdialog${wide ? " wide" : ""}${tone ? ` ${tone}` : ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      },
      h(
        "div",
        { class: "xdhead" },
        back ? h("button", { class: "btn quiet", type: "button", onclick: back }, "Back") : null,
        h(
          "div",
          { class: "grow" },
          h("h3", { class: "xdtitle" }, title),
          subtitle ? h("div", { class: "note xdsub" }, subtitle) : null,
        ),
        h("button", { class: "btn quiet", type: "button", "data-keep": "xdialog", onclick: onClose }, "Close"),
      ),
      h("div", { class: "xdbody" }, body),
    ),
  );
}

function confirmDialog(x, session) {
  const c = x.confirm;
  const copy = CONFIRM[c.kind];
  return dialogShell({
    title: copy.title,
    onClose: () => x.closeConfirm(),
    body: [
      h("p", { class: "message" }, copy.message),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          { class: "btn quiet", type: "button", disabled: c.busy, onclick: () => x.closeConfirm() },
          "Cancel",
        ),
        copy.alternative
          ? h(
              "button",
              { class: "btn", type: "button", disabled: c.busy, onclick: () => void x.hide(session) },
              copy.alternative,
            )
          : null,
        h(
          "button",
          { class: "btn danger", type: "button", disabled: c.busy, onclick: () => void x.confirmAction(session) },
          c.busy ? "Working…" : copy.confirm,
        ),
      ),
    ],
  });
}

function viewerDialog(x) {
  const v = x.viewer;
  return dialogShell({
    title: v.name,
    wide: true,
    tone: "viewer",
    onClose: () => x.closeTop(),
    body: [h("div", { class: "xviewer" }, h("img", { src: v.uri, alt: v.name }))],
  });
}

/** The dialog for the open chat, if one is up. Nodes (zero or one). */
export function overlays(x, session, env) {
  switch (x.dialogFor(session.key)) {
    case "confirm":
      return [confirmDialog(x, session)];
    case "viewer":
      return [viewerDialog(x)];
    case "subagent": {
      const { title, body } = subagentBody(
        x.sub,
        env?.verbose === false ? "Turn on Show thinking live to read a subagent's steps." : null,
      );
      return [dialogShell({ title, body, onClose: () => x.closeSubagent() })];
    }
    case "diff": {
      const d = diffBody(x.diff, x);
      return [
        dialogShell({
          title: d.title,
          subtitle: d.subtitle,
          back: d.back,
          body: d.body,
          wide: true,
          onClose: () => x.closeDiff(),
        }),
      ];
    }
    default:
      return [];
  }
}
