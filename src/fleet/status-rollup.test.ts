import { describe, expect, it } from "vitest";
import { pondStatusOf } from "./pond-status.js";
import { rollupStatus } from "./status-rollup.js";

const s = (state: string, extra: Record<string, unknown> = {}) => ({ state, ...extra }) as never;

describe("rollupStatus", () => {
  it("is idle with nothing or only finished chats", () => {
    expect(rollupStatus([])).toEqual({ activity: "idle", working: 0, needsYou: 0 });
    expect(rollupStatus([s("finished"), s("idle")]).activity).toBe("idle");
  });
  it("counts working and a duckling-held finished chat as working", () => {
    const r = rollupStatus([s("working"), s("finished", { ducklings: { running: 2, items: [] } }), s("finished")]);
    expect(r).toEqual({ activity: "working", working: 2, needsYou: 0 });
  });
  it("needs you wins over working and error", () => {
    const r = rollupStatus([s("working"), s("error"), s("awaiting_approval"), s("finished", { asks: "q?" })]);
    expect(r.activity).toBe("needs_you");
    // Waiting, a question and an unseen failure all count by the one rule.
    expect(r.needsYou).toBe(3);
    expect(r.working).toBe(1);
  });
  it("counts an unseen failure as needing you but draws only the failed mark when nothing waits", () => {
    expect(rollupStatus([s("error"), s("finished")])).toEqual({ activity: "error", working: 0, needsYou: 1 });
  });
  it("stops counting a failure the person opened, or one nobody touched for a day", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const seen = s("error", { errorSeenAt: "2026-11-26T11:00:00Z", lastActivityAt: "2026-11-26T10:00:00Z" });
    const old = s("error", { lastActivityAt: "2026-11-25T10:00:00Z" });
    expect(rollupStatus([seen, old], now)).toEqual({ activity: "idle", working: 0, needsYou: 0 });
  });
  it("working beats error, error beats idle", () => {
    expect(rollupStatus([s("error"), s("working")]).activity).toBe("working");
    expect(rollupStatus([s("error"), s("finished")]).activity).toBe("error");
  });
});

describe("pondStatusOf", () => {
  it("groups by pond id and skips chats without one", () => {
    const out = pondStatusOf(
      [s("working", { p: "a" }), s("finished", { p: "b" }), s("working", { p: null })],
      (x) => (x as unknown as { p: string | null }).p,
    );
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
    expect(out.a?.activity).toBe("working");
    expect(out.b?.activity).toBe("idle");
  });
});
