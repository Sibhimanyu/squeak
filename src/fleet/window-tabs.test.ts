import { describe, expect, it, vi } from "vitest";

import { readSelectTab, readShowChat, type TabsSystem, WindowTabs } from "./window-tabs.js";

function fake(front: { id: string; name: string } | null) {
  const tabs = [
    { index: 0, title: "GitHub", selected: true },
    { index: 1, title: "Heresay", selected: false },
  ];
  const system: TabsSystem = {
    front: async () => front,
    hands: vi.fn(async (request) =>
      request.bundleId === "com.conductor.app"
        ? { ok: true as const, tabs: [], conductor: { workspaceId: "w2", sessionId: "chat-0002" } }
        : request.action === "select" && request.title !== tabs[request.index ?? -1]?.title
          ? { ok: false as const, reason: "That tab moved or closed. The list has been read again." }
          : { ok: true as const, tabs },
    ),
    showChat: vi.fn(async () => null),
    conductor: () => [
      { id: "w1", name: "squeak · main", repo: "squeak", chats: [{ id: "chat-0001", title: "Fans", working: false }] },
      { id: "w2", name: "farm · arm", repo: "farm", chats: [{ id: "chat-0002", title: "Timer", working: true }] },
    ],
    chat: (id) => (id === "chat-0001" ? { workspaceId: "w1", title: "Fans" } : null),
  };
  return { tabs: new WindowTabs(system), system };
}

describe("WindowTabs", () => {
  it("lists a browser's tabs, and Conductor's workspaces and chats when it is in front", async () => {
    expect(await fake({ id: "com.apple.Safari", name: "Safari" }).tabs.list()).toMatchObject({
      kind: "tabs",
      app: { name: "Safari" },
      tabs: [{ title: "GitHub", selected: true }, { title: "Heresay" }],
    });
    expect(await fake({ id: "com.conductor.app", name: "Conductor" }).tabs.list()).toMatchObject({
      kind: "conductor",
      workspaces: [{ name: "farm · arm" }, { name: "squeak · main", chats: [{ id: "chat-0001" }] }],
    });
    expect(await fake(null).tabs.list()).toMatchObject({ kind: "none" });
    // The workspace and chat on screen come first and are marked.
    const conductor = await fake({ id: "com.conductor.app", name: "Conductor" }).tabs.list();
    expect(conductor.workspaces?.[0]).toMatchObject({
      id: "w2",
      current: true,
      chats: [{ id: "chat-0002", current: true }],
    });
    expect(conductor.workspaces?.[1]).not.toHaveProperty("current");
  });

  it("presses a tab only while it still has the title the phone saw", async () => {
    const t = fake({ id: "com.apple.Safari", name: "Safari" });
    expect(await t.tabs.select({ index: 1, title: "Heresay" })).toMatchObject({ ok: true });
    expect(await t.tabs.select({ index: 1, title: "Something else" })).toMatchObject({ ok: false });
    expect(t.system.hands).toHaveBeenCalledWith({
      bundleId: "com.apple.Safari",
      action: "select",
      index: 1,
      title: "Heresay",
    });
  });

  it("opens a Conductor chat by id, its workspace looked up on the Mac", async () => {
    const t = fake({ id: "com.conductor.app", name: "Conductor" });
    expect(await t.tabs.showChat("chat-0001")).toMatchObject({ ok: true, tabs: { kind: "conductor" } });
    expect(t.system.showChat).toHaveBeenCalledWith({ workspaceId: "w1", sessionId: "chat-0001", sessionTitle: "Fans" });
    expect(await t.tabs.showChat("chat-9999")).toEqual({ ok: false, reason: "That chat isn't in Conductor any more." });
  });

  it("reads only exact payloads", () => {
    expect(readSelectTab({ index: 2, title: "GitHub" })).toEqual({ index: 2, title: "GitHub" });
    for (const bad of [
      { index: -1, title: "x" },
      { index: 1.5, title: "x" },
      { index: 60, title: "x" },
      { index: 1 },
      { index: 1, title: "x", extra: 1 },
      "1",
      null,
    ]) {
      expect(readSelectTab(bad)).toBeNull();
    }
    expect(readShowChat({ sessionId: "0a401f51-6093-442e-8437-9ca80979fb78" })).toEqual({
      sessionId: "0a401f51-6093-442e-8437-9ca80979fb78",
    });
    for (const bad of [
      { sessionId: "../etc" },
      { sessionId: "short" },
      { sessionId: "abcdefgh", workspaceId: "w" },
      {},
    ]) {
      expect(readShowChat(bad)).toBeNull();
    }
  });
});
