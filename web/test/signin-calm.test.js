import { beforeAll, describe, expect, it } from "vitest";

import { EMBED_CSS, EMBED_ID, embedConfig, mountEmbeddedLogin } from "../js/embedded-login.js";
import { errorPage, signedInScreen, signedOutScreen } from "../js/signin-view.js";
import { all, click, installDom, text } from "./fake-dom.js";

beforeAll(installDom);
const buttons = (n) => all(n).filter((x) => x.tag === "button");
const noop = () => undefined;

describe("the calm sign-in pages", () => {
  it("signed out: title, the form's hosted button, and the Mac variant's words", () => {
    let hosted = 0;
    const page = signedOutScreen({ mode: "mac", signIn: () => hosted++ });
    const words = text(page);
    expect(words).toContain("Sign in to Squeak");
    expect(words).toContain("Signing in for your Mac");
    expect(words).toContain("sent back to Squeak");
    expect(words).toContain("A pager for your coding agents");
    click(buttons(page)[0]);
    expect(hosted).toBe(1);
    expect(text(signedOutScreen({ mode: "app", signIn: noop }))).toContain("Squeak on iPhone");
  });

  it("signed in: You're in, who, Open Squeak and Sign out call back", () => {
    const calls = [];
    const page = signedInScreen({
      user: { name: "Pat", email: "pat@x.co" },
      busy: false,
      onContinue: () => calls.push("go"),
      onSignOut: () => calls.push("out"),
    });
    expect(text(page)).toContain("You’re in");
    expect(text(page)).toContain("pat@x.co");
    const [open, out] = buttons(page);
    expect(text(open)).toContain("Open Squeak");
    click(open);
    click(out);
    expect(calls).toEqual(["go", "out"]);
  });

  it("error: the sentence in a red alert row", () => {
    const page = signedOutScreen({ mode: "mac", signIn: noop, error: "Could not reach Squeak." });
    expect(all(page).some((n) => n.attrs?.role === "alert" && text(n).includes("Could not reach"))).toBe(true);
    expect(text(errorPage("This link is not complete."))).toContain("not complete");
  });
});

describe("the embedded login", () => {
  const box = (frame) => ({ querySelector: () => (frame() ? {} : null) });
  const win = (extra = {}) => ({
    location: { origin: "https://squeak.example.in" },
    document: { createElement: () => ({}), head: { append: (s) => queueMicrotask(() => s.onload?.()) } },
    ...extra,
  });

  it("signs in into #squeak-login with our stylesheet and returns to the app page", async () => {
    const calls = [];
    let frame = false;
    const w = win({
      catalyst: {
        auth: {
          signIn: (id, cfg) => {
            calls.push([id, cfg]);
            frame = true;
          },
        },
      },
    });
    const states = [];
    expect(
      await mountEmbeddedLogin(
        box(() => frame),
        (s) => states.push(s),
        { win: w, pollMs: 1 },
      ),
    ).toBe("embedded");
    expect(calls).toEqual([[EMBED_ID, embedConfig("https://squeak.example.in")]]);
    expect(calls[0][1]).toEqual({
      redirect_url: "/app/index.html",
      css_url: `https://squeak.example.in${EMBED_CSS}`,
    });
    expect(states).toEqual(["embedded"]);
  });

  it("fails soft when no frame appears (project still on hosted login) or the SDK is missing", async () => {
    const hostedMode = win({ catalyst: { auth: { signIn: noop } } });
    expect(
      await mountEmbeddedLogin(
        box(() => false),
        noop,
        { win: hostedMode, timeoutMs: 20, pollMs: 5 },
      ),
    ).toBe("failed");
    const broken = win({ document: { createElement: () => ({}), head: { append: (s) => s.onerror() } } });
    expect(
      await mountEmbeddedLogin(
        box(() => false),
        noop,
        { win: broken },
      ),
    ).toBe("failed");
    expect(
      await mountEmbeddedLogin(
        box(() => false),
        noop,
        { win: { location: { origin: "null" } } },
      ),
    ).toBe("failed");
  });
});
