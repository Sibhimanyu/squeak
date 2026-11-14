import { describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";
import { TimelineLog, TimelineRecorder } from "./timeline-log.js";

describe("TimelineRecorder.recover", () => {
  it("ends the specific open turn, not just the chat's newest one", () => {
    const store = new NativeStore(":memory:");
    const log = new TimelineLog(store.db);
    const at = new Date().toISOString();
    log.append("s", { type: "turn.started", turnId: "t1", promptSeq: 1, text: "a", at } as never);
    log.append("s", { type: "turn.started", turnId: "t2", promptSeq: 2, text: "b", at } as never);
    log.append("s", { type: "turn.ended", turnId: "t2", outcome: "done", at });
    const rec = new TimelineRecorder(log, () => undefined);
    rec.recover();
    const ended = log.after("s", 0).filter((e) => e.type === "turn.ended");
    expect(ended.map((e) => ("turnId" in e ? e.turnId : "")).sort()).toEqual(["t1", "t2"]);
    expect(log.openTurns()).toEqual([]);
    rec.recover();
    expect(log.after("s", 0).filter((e) => e.type === "turn.ended")).toHaveLength(2);
  });
});
