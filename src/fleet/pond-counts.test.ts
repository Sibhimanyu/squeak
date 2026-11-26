import { describe, expect, it } from "vitest";
import { pondCounts } from "./pond-counts.js";

describe("pondCounts", () => {
  it("counts on duty, working, needs you and off duty, with the total", () => {
    const c = pondCounts([
      { duty: "on", working: true, needsYou: false },
      { duty: "on", working: false, needsYou: true },
      { duty: "on", working: false, needsYou: false },
      { duty: "off", working: false, needsYou: false },
      { duty: "off", working: true, needsYou: true },
    ]);
    // Needs you counts every duck the rule names, Off duty ones too: a failure there still waits for you.
    expect(c).toEqual({ onDuty: 3, working: 1, needsYou: 2, offDuty: 2, total: 5 });
  });

  it("does not count a duck that needs you as working, nor an off-duty duck as working", () => {
    expect(pondCounts([{ duty: "on", working: true, needsYou: true }])).toMatchObject({ working: 0, needsYou: 1 });
    expect(pondCounts([{ duty: "off", working: true, needsYou: true }])).toMatchObject({
      working: 0,
      needsYou: 1,
      offDuty: 1,
    });
    expect(pondCounts([])).toEqual({ onDuty: 0, working: 0, needsYou: 0, offDuty: 0, total: 0 });
  });
});
