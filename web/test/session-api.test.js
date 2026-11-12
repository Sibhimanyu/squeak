import { describe, expect, it } from "vitest";

import { Channel } from "../js/channel.js";
import { CAPABILITIES } from "../js/channel-crypto.js";
import { menuItems, answerInput, setupInput } from "../js/chat-extras-logic.js";
import { canReply, replyBlock } from "../js/format.js";
import { FINISHED_MODE_LIST } from "../js/settings-mac-logic.js";
import {
  addons,
  can,
  chatHandle,
  conductorUi,
  readFinishedMode,
  replyableMode,
  sourceLabel,
  tabsGroups,
} from "../js/session-api.js";
import { notify } from "../js/view-model.js";

const old = { key: "k", conductorSessionId: "c1", state: "idle" };
const native = {
  key: "squeak:n1",
  sessionId: "n1",
  conductorSessionId: null,
  state: "idle",
  actions: ["reply", "diff"],
  source: { id: "squeak", label: "Squeak" },
};

describe("handle and actions", () => {
  it("an old view (no sessionId, actions, source) falls back to the Conductor id", () => {
    expect(chatHandle(old)).toBe("c1");
    expect(can(old, "reply")).toBe(true);
    expect(can(old, "close")).toBe(true);
    expect(canReply(old)).toBe(true);
    expect(sourceLabel(old)).toBe("Conductor");
    expect(chatHandle({ key: "t" })).toBeNull();
    expect(can({ key: "t" }, "reply")).toBe(false);
    expect(setupInput({ ...old, modelId: "m" }, {}).sessionId).toBe("c1");
  });

  it("a new view uses sessionId and gates by actions", () => {
    expect(chatHandle(native)).toBe("n1");
    expect(can(native, "reply")).toBe(true);
    expect(can(native, "stop")).toBe(false);
    expect(can(native, "close")).toBe(false);
    expect(canReply(native)).toBe(true);
    expect(replyBlock({ ...native, actions: ["diff"] })).toMatch(/Not a chat you can answer/);
    expect(sourceLabel(native)).toBe("Squeak");
    const both = { ...old, sessionId: "h1", actions: ["reply", "stop"] };
    expect(chatHandle(both)).toBe("h1");
    expect(can(both, "model")).toBe(false);
  });

  it("menu items follow actions and the add-on", () => {
    const conductorChat = {
      ...old,
      sessionId: "c1",
      actions: ["reply", "close", "archive", "diff"],
      workspaceId: "w",
      open: true,
    };
    const ids = (view) =>
      menuItems(conductorChat, { workspaceActions: true, conductorUi: conductorUi(view) }).map((i) => i.id);
    expect(ids({ addons: ["conductor"] })).toEqual(["diff", "close", "hide", "createPr", "archive"]);
    expect(ids({ addons: [] })).toEqual(["diff", "hide"]);
    expect(ids({})).toEqual(["diff", "close", "hide", "createPr", "archive"]);
    expect(menuItems(native, {}).map((i) => i.id)).toEqual(["diff", "hide"]);
  });

  it("answers name the handle", () => {
    const q = { ...native, question: { toolUseId: "t", questions: [{ question: "Q?", options: [{ label: "a" }] }] } };
    const input = answerInput(q, { answers: [] });
    if (input) expect(input.sessionId).toBe("n1");
  });
});

describe("add-ons, caps, notify, tabs", () => {
  it("reads add-ons and gates the Conductor UI", () => {
    expect(addons({})).toBeNull();
    expect(conductorUi({})).toBe(true);
    expect(conductorUi({ addons: ["conductor"] })).toBe(true);
    expect(conductorUi({ addons: [] })).toBe(false);
  });

  it("advertises generic-sessions within the cap limits", () => {
    expect(CAPABILITIES).toContain("generic-sessions");
    expect(CAPABILITIES.length).toBeLessThanOrEqual(10);
    expect(Math.max(...CAPABILITIES.map((c) => c.length))).toBeLessThanOrEqual(20);
    expect(Channel).toBeTypeOf("function");
  });

  it("decodes both finished spellings and sends by the Mac's generation", () => {
    expect(readFinishedMode("conductor")).toBe("replyable");
    expect(readFinishedMode("replyable")).toBe("replyable");
    expect(notify({ notify: { telegram: { finished: "conductor" } } }).telegram.finished).toBe("replyable");
    expect(notify({ notify: { telegram: { finished: "replyable" } } }).telegram.finished).toBe("replyable");
    expect(replyableMode({})).toBe("conductor");
    expect(replyableMode({ addons: [] })).toBe("replyable");
    expect(FINISHED_MODE_LIST[0].title).toBe("Chats you can reply to");
  });

  it("reads groups and conductor tabs answers", () => {
    const workspaces = [{ id: "w" }];
    expect(tabsGroups({ kind: "groups", title: "Squeak", workspaces })).toEqual({
      kind: "groups",
      title: "Squeak",
      workspaces,
    });
    expect(tabsGroups({ kind: "conductor", workspaces }).title).toBe("Conductor");
    expect(tabsGroups({ kind: "other" })).toBeNull();
  });
});
