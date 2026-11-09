import { describe, expect, it } from "vitest";
import { fleetSession } from "./fixtures.js";
import { toAgentSession } from "./state-map.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ctx = (over = {}) => ({ nowMs: NOW, ...over });

describe("core attention summary", () => {
  it("is absent without a context, so plain mapping is unchanged", () => {
    expect(toAgentSession(fleetSession()).attention).toBeUndefined();
  });

  it("a stalled session stays working and says stalled", () => {
    const s = fleetSession({ state: "working", waitingOn: "model", waitingSince: "2026-11-09T11:00:00.000Z" });
    const core = toAgentSession(s, ctx());
    expect(core.state).toBe("working");
    expect(core.attention?.stalled).toBe(true);
    expect(toAgentSession(fleetSession({ state: "working" }), ctx()).attention?.stalled).toBe(false);
  });

  it("context pressure keeps the real state and carries the percent", () => {
    const core = toAgentSession(fleetSession({ state: "finished", contextPercent: 91 }), ctx());
    expect(core.state).toBe("completed");
    expect(core.attention?.contextPercent).toBe(91);
    expect(toAgentSession(fleetSession(), ctx()).attention).not.toHaveProperty("contextPercent");
  });

  it("carries asks, the question, last activity and the disambiguated title", () => {
    const s = fleetSession({ key: "k", state: "finished", asks: "Open a PR?" });
    const core = toAgentSession(
      s,
      ctx({ distinctTitles: new Map([["k", "Fix it"]]), kinds: new Map([["k", ["asked_question"]]]) }),
    );
    expect(core.attention).toEqual({
      asks: ["asked_question"],
      question: "Open a PR?",
      stalled: false,
      displayTitle: "Fix it",
      lastActivityAt: s.lastActivityAt,
    });
    expect(toAgentSession(s, ctx()).attention?.displayTitle).toBe("Fix it");
  });
});
