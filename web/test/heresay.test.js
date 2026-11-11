// heresay.js: every call is safe with no SDK, and talks to window.Heresay when it is there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  available,
  identify,
  introduce,
  nudge,
  reportButton,
  reportFailure,
  resetHeresay,
  setScreen,
} from "../js/heresay.js";

const sdk = () => ({ setScreen: vi.fn(), identify: vi.fn(), introduce: vi.fn(), nudge: vi.fn(), open: vi.fn() });

beforeEach(() => {
  resetHeresay();
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, addEventListener() {}, append() {} }),
    createTextNode: (t) => t,
  };
});
afterEach(() => {
  delete globalThis.Heresay;
  delete globalThis.document;
});

describe("without the SDK (blocked, or not loaded yet)", () => {
  it("does nothing and never throws", () => {
    expect(() => {
      setScreen("Sessions");
      identify({ userId: "u1", email: "a@b.c" });
      introduce();
      nudge();
      reportFailure("x");
    }).not.toThrow();
    expect(available()).toBe(false);
    expect(reportButton("x")).toBeNull();
  });

  it("swallows an SDK that throws", () => {
    globalThis.Heresay = {
      setScreen: () => {
        throw new Error("boom");
      },
      open: () => {},
    };
    expect(() => setScreen("Pair")).not.toThrow();
  });
});

describe("with the SDK", () => {
  it("names a screen once until it changes", () => {
    const hs = (globalThis.Heresay = sdk());
    setScreen("Your Macs");
    setScreen("Your Macs");
    setScreen("Pair");
    expect(hs.setScreen.mock.calls).toEqual([["Your Macs"], ["Pair"]]);
  });

  it("identifies the signed-in account with the fields it has, once, and clears on sign-out", () => {
    const hs = (globalThis.Heresay = sdk());
    identify({ userId: "u1", name: "Asha", email: "asha@example.com" });
    identify({ userId: "u1", name: "Asha", email: "asha@example.com" });
    identify({ userId: "u2", email: "" });
    identify(null);
    identify(null);
    expect(hs.identify.mock.calls).toEqual([
      [{ id: "u1", label: "Asha", email: "asha@example.com" }],
      [{ id: "u2" }],
      [],
    ]);
  });

  it("introduces once", () => {
    const hs = (globalThis.Heresay = sdk());
    introduce();
    introduce();
    expect(hs.introduce).toHaveBeenCalledTimes(1);
  });

  it("opens the form as Broken with the failure sentence, and nudges", () => {
    const hs = (globalThis.Heresay = sdk());
    reportFailure("Could not reach Squeak's server.");
    nudge();
    expect(hs.open).toHaveBeenCalledWith({ type: "broken", text: "Could not reach Squeak's server." });
    expect(hs.nudge).toHaveBeenCalledTimes(1);
    expect(available()).toBe(true);
  });
});
