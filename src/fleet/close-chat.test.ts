import { describe, expect, it, vi } from "vitest";

import { closeChat, type ChatCloserDeps } from "./close-chat.js";
import type { UiCloseResult } from "./conductor-ui.js";

function deps(status: string | null, ui: UiCloseResult | null) {
  const hidden: string[] = [];
  const close = vi.fn(async () => ui!);
  const d: ChatCloserDeps = {
    lookup: (id) => (id === "s1" ? { status, workspaceId: "w1", title: "Fix it" } : null),
    hide: (id) => {
      hidden.push(id);
      return "closed";
    },
    ui: ui ? { close } : null,
  };
  return { d, hidden, close };
}

describe("closeChat", () => {
  it("closes the tab in Conductor's window, then makes sure the chat is hidden", async () => {
    const { d, hidden, close } = deps("idle", { ok: true });
    expect(await closeChat(d, "s1")).toBe("closed");
    expect(close).toHaveBeenCalledWith({ workspaceId: "w1", sessionId: "s1", sessionTitle: "Fix it" });
    expect(hidden).toEqual(["s1"]);
  });

  it("hides it in the database when its tab is not open, or the window cannot be driven", async () => {
    for (const error of ["chat-not-open", "locked", "conductor-not-running", "no-menu", "helper-missing"]) {
      const { d, hidden } = deps("idle", { ok: false, error });
      expect(await closeChat(d, "s1")).toBe("closed");
      expect(hidden).toEqual(["s1"]);
    }
  });

  it("hides it in the database without Squeak Hands", async () => {
    const { d, hidden } = deps("idle", null);
    expect(await closeChat(d, "s1")).toBe("closed");
    expect(hidden).toEqual(["s1"]);
  });

  it("never touches a chat that is running or waiting on someone, nor one that does not exist", async () => {
    for (const status of ["working", "cancelling", "needs_user_input", "needs_plan_response"]) {
      const { d, hidden, close } = deps(status, { ok: true });
      expect(await closeChat(d, "s1")).toBe("busy");
      expect(close).not.toHaveBeenCalled();
      expect(hidden).toEqual([]);
    }
    const { d, close } = deps("idle", { ok: true });
    expect(await closeChat(d, "nope")).toBe("missing");
    expect(close).not.toHaveBeenCalled();
  });
});
