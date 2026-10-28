import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PinKeeper } from "./pin-keeper.js";

function setup(optionPin: string | null = "4821") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-keeper-"));
  const file = path.join(dir, "voice-pin.json");
  let clock = 1_800_000_000_000;
  return {
    dir,
    file,
    clock: () => clock,
    tick: (ms: number) => (clock += ms),
    make: () => new PinKeeper(optionPin, file, () => clock),
  };
}

describe("PinKeeper", () => {
  it("starts as the add-on's option and changes only with the current pin", () => {
    const t = setup();
    const keeper = t.make();
    expect(keeper.current()).toBe("4821");
    expect(keeper.change("0000", "135790")).toEqual({ ok: false, reason: "That is not your current pin." });
    expect(keeper.current()).toBe("4821");
    expect(keeper.change("4821", "135790")).toEqual({ ok: true });
    expect(keeper.current()).toBe("135790");
  });

  it("keeps a changed pin across a restart, privately, and it beats the option", () => {
    const t = setup();
    t.make().change("4821", "135790");
    expect(fs.statSync(t.file).mode & 0o777).toBe(0o600);
    expect(new PinKeeper("4821", t.file).current()).toBe("135790");
    // The old option no longer opens a change: the new pin is the one in force.
    expect(new PinKeeper("4821", t.file).change("4821", "2468")).toMatchObject({ ok: false });
  });

  it("refuses a new pin that a keypad cannot enter, and keeps the old one", () => {
    const keeper = setup().make();
    for (const bad of ["123", "12ab", "", "1234567890123", "12 34"]) {
      expect(keeper.change("4821", bad)).toEqual({ ok: false, reason: "A pin is 4 to 12 digits." });
    }
    expect(keeper.current()).toBe("4821");
  });

  it("locks changes for ten minutes after five wrong guesses, even for the right pin", () => {
    const t = setup();
    const keeper = t.make();
    for (let i = 0; i < 5; i++) keeper.change("0000", "135790");
    expect(keeper.change("4821", "135790")).toEqual({
      ok: false,
      reason: "Too many wrong pins. Try again in ten minutes.",
    });
    t.tick(11 * 60_000);
    expect(keeper.change("4821", "135790")).toEqual({ ok: true });
  });

  it("has nothing to change when no pin exists", () => {
    expect(setup(null).make().change("4821", "135790")).toMatchObject({ ok: false });
  });

  it("ignores a hand-edited file with a bad pin", () => {
    const t = setup();
    fs.writeFileSync(t.file, '{"pin":"abc"}');
    expect(t.make().current()).toBe("4821");
  });
});
