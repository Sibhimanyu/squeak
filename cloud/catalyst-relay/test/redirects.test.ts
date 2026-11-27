// The two forwards to Squeak for Web (#133): the Catalyst client page `/app/index.html` and Firebase's squeak-mac.web.app (`/join`
// and every other path). Both serve the one page in cloud/catalyst-relay/client; the script is run here as a browser would run
// it, at each address, and must land on https://squeak.onslate.in with an invite's code kept.
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const read = (rel: string) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const SCRIPT = read("cloud/catalyst-relay/client/redirect.js");

/** Runs the page's script at `href` the way a browser does; returns where it sent the browser and what the button points at. */
function visit(href: string): { replaced: string; button: string } {
  const u = new URL(href);
  const out = { replaced: "", button: "" };
  const go = { href: "" };
  const sandbox: Record<string, unknown> = {
    URLSearchParams,
    encodeURIComponent,
    document: { getElementById: (id: string) => (id === "go" ? go : null) },
    location: {
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      replace: (to: string) => void (out.replaced = to),
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SCRIPT, sandbox);
  out.button = go.href;
  return out;
}

const APP = "https://squeak-60083782173.development.catalystserverless.in/app/index.html";
const JOIN = "https://squeak-mac.web.app/join";

describe("/app/index.html on the relay's Catalyst domain", () => {
  it("is the one page Catalyst client hosting serves, and it loads the forward", () => {
    expect(JSON.parse(read("cloud/catalyst-relay/client/client-package.json")).homepage).toBe("index.html");
    // Catalyst refuses a client whose name differs from the one first deployed.
    expect(JSON.parse(read("cloud/catalyst-relay/client/client-package.json")).name).toBe("squeak-guest");
    expect(JSON.parse(read("cloud/catalyst-relay/catalyst.json")).client).toEqual({ source: "client" });
    expect(read("cloud/catalyst-relay/client/index.html")).toContain('<script src="redirect.js"></script>');
  });

  it("forwards a bare visit to the app", () => {
    expect(visit(APP).replaced).toBe("https://squeak.onslate.in/");
  });

  it("keeps an invite code, whichever way the link carries it", () => {
    for (const href of [`${APP}?code=inv_123`, `${APP}#inv_123`, `${APP}#code=inv_123`]) {
      expect(visit(href).replaced).toBe("https://squeak.onslate.in/invite?code=inv_123");
    }
  });

  it("keeps the query and fragment of anything else (a hand-back, a photo result)", () => {
    expect(visit(`${APP}#zoho-photo=ready`).replaced).toBe("https://squeak.onslate.in/#zoho-photo=ready");
    expect(visit(`${APP}?x=1#a=b`).replaced).toBe("https://squeak.onslate.in/?x=1#a=b");
  });
});

describe("squeak-mac.web.app/join", () => {
  it("forwards /join and the older link shapes to the app, invite codes kept as /invite?code=", () => {
    expect(visit("https://squeak-mac.web.app/").replaced).toBe("https://squeak.onslate.in/");
    expect(visit(JOIN).replaced).toBe("https://squeak.onslate.in/");
    expect(visit(`${JOIN}#Abc-9_z`).replaced).toBe("https://squeak.onslate.in/invite?code=Abc-9_z");
    expect(visit(`${JOIN}?code=Abc-9_z`).replaced).toBe("https://squeak.onslate.in/invite?code=Abc-9_z");
    expect(visit(`${JOIN}/Abc-9_z`).replaced).toBe("https://squeak.onslate.in/invite?code=Abc-9_z");
  });

  it("puts the same address behind the button, for a browser that blocks the redirect", () => {
    expect(visit(`${JOIN}?code=inv_1`).button).toBe("https://squeak.onslate.in/invite?code=inv_1");
  });

  it("never lets a code carry anything but its own characters into the address", () => {
    const sent = visit(`${JOIN}?code=${encodeURIComponent("x&y=1#/../evil")}`).replaced;
    // Not a code: it is not made into an invite address; it travels as the inert query it came as.
    expect(sent.startsWith("https://squeak.onslate.in/?code=")).toBe(true);
    expect(sent).not.toContain("/invite");
    expect(visit(`${JOIN}#a<script>`).replaced.startsWith("https://squeak.onslate.in/#")).toBe(true);
  });

  it("is deployed from the same page, with the script reachable at any path", () => {
    const firebase = JSON.parse(read("firebase/firebase.json"));
    const site = firebase.hosting.find((h: { site: string }) => h.site === "squeak-mac");
    expect(site.rewrites).toEqual([
      { source: "**/redirect.js", destination: "/redirect.js" },
      { source: "**", destination: "/index.html" },
    ]);
    const deploy = read("firebase/deploy-redirects.sh");
    expect(deploy).toContain(
      "../cloud/catalyst-relay/client/index.html ../cloud/catalyst-relay/client/redirect.js web-public/",
    );
    expect(deploy).not.toContain("redirects/web");
  });
});
