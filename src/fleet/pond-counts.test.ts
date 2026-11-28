import { describe, expect, it } from "vitest";
import { pondCounts } from "./pond-counts.js";

describe("pondCounts", () => {
  it("counts open, working, needs you and closed, with the total", () => {
    const c = pondCounts([
      { open: true, working: true, needsYou: false },
      { open: true, working: false, needsYou: true },
      { open: true, working: false, needsYou: false },
      { open: false, working: false, needsYou: false },
      { open: false, working: true, needsYou: true },
    ]);
    // Needs you counts every duck the rule names, Closed ones too: a failure there still waits for you.
    expect(c).toEqual({ open: 3, working: 1, needsYou: 2, closed: 2, total: 5 });
  });

  it("does not count a duck that needs you as working, nor a closed duck as working", () => {
    expect(pondCounts([{ open: true, working: true, needsYou: true }])).toMatchObject({ working: 0, needsYou: 1 });
    expect(pondCounts([{ open: false, working: true, needsYou: true }])).toMatchObject({
      working: 0,
      needsYou: 1,
      closed: 1,
    });
    expect(pondCounts([])).toEqual({ open: 0, working: 0, needsYou: 0, closed: 0, total: 0 });
  });
});
