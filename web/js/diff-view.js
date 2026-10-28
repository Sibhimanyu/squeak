// What a chat changed (the iPhone's DiffView, DESIGN.md 8.8): the file list
// first, one file's patch second. Read-only: the Mac reads its own working
// tree, this only draws what came back. Added lines carry a green tint,
// removed a red one, hunk headers are muted; a long patch shows in pages.

import { PATCH_PAGE, diffTitle, fileCounts, patchPage } from "./chat-extras-logic.js";
import { h } from "./dom.js";

function fileList(d, x) {
  const diff = d.diff;
  return h(
    "div",
    { class: "xfiles" },
    diff.baseRef ? h("p", { class: "note" }, `Against ${diff.baseRef}`) : null,
    diff.files.length === 0 ? h("p", { class: "note" }, "No changes.") : null,
    diff.files.map((file, index) =>
      h(
        "button",
        { class: "xfile", type: "button", onclick: () => void x.openFile(index) },
        h("span", { class: "xpath", title: file.path }, file.path),
        h("span", { class: "xcount" }, fileCounts(file)),
      ),
    ),
    diff.truncated ? h("p", { class: "note" }, `Only the first ${diff.files.length} files are listed.`) : null,
  );
}

function patch(d, x) {
  const p = d.patch;
  if (p.phase === "loading") return h("p", { class: "note", role: "status" }, "Reading the changes on your Mac…");
  if (p.phase === "problem") return h("p", { class: "line bad", role: "alert" }, p.problem);
  if (p.empty) return h("p", { class: "note" }, "No textual changes.");
  const { shown, more } = patchPage(p.lines, d.pages);
  return h(
    "div",
    { class: "xpatchwrap" },
    h(
      "div",
      { class: "xpatch", role: "region", "aria-label": "Changes", tabindex: "0" },
      shown.map((line) => h("div", { class: `xl ${line.kind}` }, line.text === "" ? " " : line.text)),
    ),
    more > 0
      ? h(
          "button",
          { class: "btn quiet", type: "button", onclick: () => x.morePatch() },
          `Show ${Math.min(more, PATCH_PAGE)} more lines (${more} left)`,
        )
      : null,
  );
}

/** The dialog's title, body, and a back action when a file is open. */
export function diffBody(d, x) {
  if (d.phase === "loading") {
    return {
      title: "What changed",
      body: [h("p", { class: "note", role: "status" }, "Reading the changes on your Mac…")],
    };
  }
  if (d.phase === "problem") {
    return {
      title: "What changed",
      body: [
        h("p", { class: "line bad", role: "alert" }, `Couldn't load the changes. ${d.problem ?? ""}`.trim()),
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: () => x.retryDiff() }, "Try again"),
        ),
      ],
    };
  }
  if (d.file !== null) {
    const file = d.diff.files[d.file];
    return {
      title: file.path.split("/").pop() || file.path,
      subtitle: file.path,
      back: () => x.backToFiles(),
      body: [patch(d, x)],
    };
  }
  return { title: diffTitle(d.diff), body: [fileList(d, x)] };
}
