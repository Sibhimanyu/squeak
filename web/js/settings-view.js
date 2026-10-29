// Settings: the screen's frame and the sections every package extends
// (settings-sections.js). It draws the built-in ones: "Show thinking live" and
// this browser's keys (Forget). Nothing from the channel is parsed as HTML.

import { h } from "./dom.js";
import { hiddenChats, hiddenCount, showHiddenAgainChange } from "./hidden-chats.js";
import { hasSettingsSection, registerSettingsSection, settingsSections } from "./settings-sections.js";

export const title = () => "Settings";

function thinkingSection(ctx) {
  const { verbose, setVerbose } = ctx.settings;
  return h(
    "label",
    { class: "toggle", title: "Streams the open chat's whole turn and its history from your Mac" },
    h("input", { type: "checkbox", checked: verbose, onchange: (event) => void setVerbose(event.target.checked) }),
    "Show thinking live",
  );
}

function deviceSection(ctx) {
  const { confirmForget, setConfirmForget, forget } = ctx.settings;
  return confirmForget
    ? h(
        "div",
        { class: "row-actions" },
        h("span", null, "Wipe this browser's keys?"),
        h("button", { class: "btn", type: "button", onclick: () => void forget() }, "Forget"),
        h("button", { class: "btn quiet", type: "button", onclick: () => setConfirmForget(false) }, "Keep"),
      )
    : h("button", { class: "btn quiet", type: "button", onclick: () => setConfirmForget(true) }, "Forget this browser");
}

function hiddenSection(ctx) {
  const count = hiddenCount(hiddenChats(ctx.prefs.get("hiddenChats")));
  if (count === 0) return null;
  return [
    h("p", { class: "note" }, `${count} chat${count === 1 ? "" : "s"} put away on this browser.`),
    h(
      "button",
      {
        class: "btn quiet",
        type: "button",
        onclick: () => void ctx.prefs.save(showHiddenAgainChange()).then(ctx.touch),
      },
      "Show hidden chats again",
    ),
  ];
}

if (!hasSettingsSection("thinking")) {
  registerSettingsSection({ id: "thinking", order: 10, title: "Live view", render: thinkingSection });
  registerSettingsSection({ id: "hidden", order: 80, title: "Hidden chats", render: hiddenSection });
  registerSettingsSection({ id: "device", order: 90, title: "This browser", render: deviceSection });
}

const asNodes = (value) => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** The Settings pane: a heading, then each section in order, in its own block. */
export function render(ctx) {
  const blocks = [];
  for (const section of settingsSections()) {
    let nodes;
    try {
      nodes = asNodes(section.render(ctx));
    } catch {
      continue;
    }
    if (nodes.length === 0) continue;
    blocks.push(
      h(
        "section",
        { class: "setting", "data-section": section.id },
        section.title ? h("h2", null, section.title) : null,
        nodes,
      ),
    );
  }
  return [h("div", { class: "screen settings" }, h("h1", null, "Settings"), blocks)];
}
