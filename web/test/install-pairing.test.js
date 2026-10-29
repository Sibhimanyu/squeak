import { describe, expect, it } from "vitest";

import { installHint, isStandalone, mobileKind, wasDismissed } from "../js/install-hint.js";
import { PairingError, parsePairingLink, takePairingFragment } from "../js/pairing-link.js";

const key = Buffer.alloc(32, 5).toString("base64");
const payload = { v: 1, p: "squeak-5c9gvo", c: "p1pYhre8xC41Wr3hbYtgCg", k: key, n: "Sibhi's Mac" };
const d = Buffer.from(JSON.stringify(payload)).toString("base64url");

function page(hash) {
  const calls = [];
  return {
    location: { hash, pathname: "/", search: "" },
    history: { state: null, replaceState: (...args) => calls.push(args) },
    calls,
  };
}

describe("takePairingFragment", () => {
  it("reads a valid payload, validates like a pasted link, and strips the hash", () => {
    const { location, history, calls } = page(`#pair=${d}`);
    const text = takePairingFragment(location, history);
    expect(text).toBe(`squeak://pair?d=${d}`);
    expect(parsePairingLink(text).channelId).toBe(payload.c);
    expect(calls).toEqual([[null, "", "/"]]);
  });

  it("does nothing when there is no pairing fragment", () => {
    for (const hash of ["", "#", "#chat=1", "#xpair=abc"]) {
      const { location, history, calls } = page(hash);
      expect(takePairingFragment(location, history)).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("strips junk too, and hands back text that fails validation", () => {
    for (const hash of ["#pair=", "#pair=%%%", "#pair=a&b=c", "#pair=abc def"]) {
      const { location, history, calls } = page(hash);
      const text = takePairingFragment(location, history);
      expect(calls).toHaveLength(1);
      expect(() => parsePairingLink(text)).toThrow(PairingError);
    }
  });

  it("rejects a well-formed fragment whose payload is not a pairing", () => {
    const bad = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
    const { location, history } = page(`#pair=${bad}`);
    expect(() => parsePairingLink(takePairingFragment(location, history))).toThrow(PairingError);
  });
});

describe("home-screen hint", () => {
  const base = { paired: true, kind: "ios", standalone: false, dismissed: false, canInstall: false };

  it("shows Share instructions on iPhone Safari and the menu on Android", () => {
    expect(installHint(base).text).toMatch(/Share, then Add to Home Screen/);
    expect(installHint({ ...base, kind: "android" })).toMatchObject({ install: false });
    expect(installHint({ ...base, kind: "android" }).text).toMatch(/Add to Home screen/);
  });

  it("offers an Install button on Android once Chrome allows it", () => {
    expect(installHint({ ...base, kind: "android", canInstall: true })).toMatchObject({ install: true });
  });

  it("hides when unpaired, on desktop, already installed, or dismissed", () => {
    expect(installHint({ ...base, paired: false })).toBeNull();
    expect(installHint({ ...base, kind: null })).toBeNull();
    expect(installHint({ ...base, standalone: true })).toBeNull();
    expect(installHint({ ...base, dismissed: true })).toBeNull();
  });

  it("tells phones from desktops", () => {
    expect(mobileKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(mobileKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(mobileKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBeNull();
    expect(mobileKind("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(mobileKind("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
  });

  it("detects standalone on iOS and by display-mode", () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(isStandalone({ navigator: {} })).toBe(false);
  });

  it("reads the dismissal from the saved prefs", () => {
    expect(wasDismissed({})).toBe(false);
    expect(wasDismissed(undefined)).toBe(false);
    expect(wasDismissed({ installHintDismissed: true })).toBe(true);
  });
});
