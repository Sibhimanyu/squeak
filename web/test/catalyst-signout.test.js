// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RETURN_PATH, SDK_CDN, SDK_PATH, sdkSignOut, signOutFailure } from "../js/catalyst-session.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A window whose appended scripts "load" as the real platform does: init.js throws without the CDN bundle (no `catalyst`).
function rig({ failing = [] } = {}) {
  const loaded = [];
  const signOuts = [];
  const win = {
    catalyst: undefined,
    document: {
      createElement: () => ({}),
      head: {
        append(script) {
          loaded.push(script.src);
          queueMicrotask(() => {
            if (failing.includes(script.src)) return script.onerror();
            if (script.src === SDK_CDN) win.catalyst = { auth: { signOut: (url) => signOuts.push(url) } };
            script.onload();
          });
        },
      },
    },
  };
  return { win, loaded, signOuts };
}

describe("sdkSignOut", () => {
  it("loads the SDK bundle before init.js, then signs out back to the app page", async () => {
    const r = rig();
    await sdkSignOut(r.win);
    expect(r.loaded).toEqual([SDK_CDN, SDK_PATH]);
    expect(r.signOuts).toEqual([RETURN_PATH]);
  });

  it("does not reload the SDK when it is already there", async () => {
    const r = rig();
    r.win.catalyst = { auth: { signOut: (u) => r.signOuts.push(u) } };
    await sdkSignOut(r.win);
    expect(r.loaded).toEqual([]);
    expect(r.signOuts).toEqual([RETURN_PATH]);
  });

  it("a script that will not load rejects as a connection problem", async () => {
    const r = rig({ failing: [SDK_CDN] });
    const error = await sdkSignOut(r.win).catch((e) => e);
    expect(signOutFailure(error)).toMatch(/Check your connection/);
    expect(r.signOuts).toEqual([]);
  });

  it("any other failure does not claim the network is down", () => {
    expect(signOutFailure(new TypeError("x"))).toBe("Couldn't sign you out. Reload the page and try again.");
  });
});

describe("entry.html's policy lets sign-out work", () => {
  const html = fs.readFileSync(path.join(root, "entry.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  it("allows the SDK bundle's origin for script and this origin for init.js", () => {
    const script = csp.match(/script-src ([^;]+)/)[1].split(" ");
    expect(script).toContain("'self'");
    expect(script).toContain(new URL(SDK_CDN).origin);
  });
});
