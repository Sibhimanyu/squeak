import { describe, expect, it } from "vitest";

import { CallPolicy } from "./policy.js";

const at = (clock: string) => new Date(`2026-10-28T${clock}:00`).getTime();

describe("CallPolicy", () => {
  it("calls an episode once", () => {
    const policy = new CallPolicy({ minGapMs: 0, quiet: null });
    expect(policy.refusal("a", at("12:00"))).toBeNull();
    policy.record("a", at("12:00"));
    expect(policy.refusal("a", at("13:00"))).toBe("already called for this");
    expect(policy.refusal("b", at("13:00"))).toBeNull();
  });

  it("spaces calls apart", () => {
    const policy = new CallPolicy({ minGapMs: 5 * 60_000, quiet: null });
    policy.record("a", at("12:00"));
    expect(policy.refusal("b", at("12:03"))).toBe("called a moment ago");
    expect(policy.refusal("b", at("12:06"))).toBeNull();
  });

  it("never rings in quiet hours, even across midnight", () => {
    const policy = new CallPolicy({ minGapMs: 0, quiet: { from: "22:00", to: "07:00" } });
    expect(policy.refusal("a", at("23:30"))).toBe("quiet hours");
    expect(policy.refusal("a", at("03:00"))).toBe("quiet hours");
    expect(policy.refusal("a", at("12:00"))).toBeNull();
  });
});
