import { describe, expect, it } from "vitest";
import { eventIdFor, newEventId } from "./events.js";
import { asSessionId } from "./types.js";

describe("event ids", () => {
  it("newEventId has the evt_ prefix and is unique", () => {
    const a = newEventId();
    expect(a.startsWith("evt_")).toBe(true);
    expect(newEventId()).not.toBe(a);
  });
  it("eventIdFor is deterministic and keyed on both inputs", () => {
    const s = asSessionId("s1");
    expect(eventIdFor(s, "k")).toBe(eventIdFor(s, "k"));
    expect(eventIdFor(s, "k").startsWith("evt_")).toBe(true);
    expect(eventIdFor(s, "k")).not.toBe(eventIdFor(s, "j"));
    expect(eventIdFor(s, "k")).not.toBe(eventIdFor(asSessionId("s2"), "k"));
  });
});
