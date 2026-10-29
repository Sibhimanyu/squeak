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
    expect(keeper.change("4821", "135790")).toEqual({ ok: true, state: "set" });
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
    expect(keeper.change("4821", "135790")).toEqual({ ok: true, state: "set" });
  });

  it("has nothing to change when no pin exists", () => {
    expect(setup(null).make().change("4821", "135790")).toMatchObject({ ok: false });
  });

  it("ignores a hand-edited file with a bad pin", () => {
    const t = setup();
    fs.writeFileSync(t.file, '{"pin":"abc"}');
    expect(t.make().current()).toBe("4821");
  });

  it("reports status, answerable and requiresPin for set, off and none", () => {
    const t = setup();
    const keeper = t.make();
    expect([keeper.status(), keeper.answerable(), keeper.requiresPin()]).toEqual(["set", true, true]);
    expect(keeper.disable("4821")).toEqual({ ok: true, state: "off" });
    expect([keeper.status(), keeper.answerable(), keeper.requiresPin(), keeper.current()]).toEqual([
      "off",
      true,
      false,
      null,
    ]);
    const none = setup(null).make();
    expect([none.status(), none.answerable(), none.requiresPin(), none.current()]).toEqual([
      "none",
      false,
      false,
      null,
    ]);
  });

  it("turning off needs the current pin, shares the lockout, and survives a restart over the option", () => {
    const t = setup();
    const keeper = t.make();
    expect(keeper.disable("0000")).toEqual({ ok: false, reason: "That is not your current pin." });
    expect(keeper.status()).toBe("set");
    expect(keeper.disable("4821")).toEqual({ ok: true, state: "off" });
    expect(JSON.parse(fs.readFileSync(t.file, "utf8"))).toEqual({ off: true });
    expect(new PinKeeper("4821", t.file).status()).toBe("off");
    expect(keeper.disable("4821")).toMatchObject({ ok: false });
  });

  it("wrong guesses across change and disable share one lockout", () => {
    const t = setup();
    const keeper = t.make();
    for (let i = 0; i < 3; i++) keeper.change("0000", "135790");
    for (let i = 0; i < 2; i++) keeper.disable("0000");
    expect(keeper.disable("4821")).toEqual({ ok: false, reason: "Too many wrong pins. Try again in ten minutes." });
  });

  it("turns back on from off or none, never over a pin that is already on", () => {
    const t = setup();
    const keeper = t.make();
    expect(keeper.enable("2468")).toEqual({ ok: false, reason: "A pin is already on." });
    keeper.disable("4821");
    expect(keeper.enable("12")).toEqual({ ok: false, reason: "A pin is 4 to 12 digits." });
    expect(keeper.enable("2468")).toEqual({ ok: true, state: "set" });
    expect(keeper.current()).toBe("2468");
    const none = setup(null).make();
    expect(none.enable("1357")).toEqual({ ok: true, state: "set" });
  });

  it("reset needs no current pin and ignores the lockout; null turns the requirement off", () => {
    const t = setup();
    const keeper = t.make();
    for (let i = 0; i < 5; i++) keeper.change("0000", "135790");
    expect(keeper.change("4821", "135790")).toMatchObject({ ok: false });
    expect(keeper.reset("97531")).toEqual({ ok: true, state: "set" });
    expect(keeper.current()).toBe("97531");
    // The lockout is cleared by a reset, and the new pin works for a change.
    expect(keeper.change("97531", "2468")).toEqual({ ok: true, state: "set" });
    expect(keeper.reset("abc")).toEqual({ ok: false, reason: "A pin is 4 to 12 digits." });
    expect(keeper.reset(null)).toEqual({ ok: true, state: "off" });
    expect(keeper.status()).toBe("off");
    expect(setup(null).make().reset("1357")).toEqual({ ok: true, state: "set" });
  });

  it("never writes a pin into a log line or an error", () => {
    const t = setup();
    const keeper = t.make();
    const results = [keeper.change("0000", "135790"), keeper.disable("0000"), keeper.enable("135790")];
    for (const r of results) expect(JSON.stringify(r)).not.toMatch(/4821|135790|0000/);
  });
});
