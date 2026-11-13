// The page's own rules, held by tests: what must never appear in the code, and
// what the hosting config must say about it (firebase/firebase.json).

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
const served = [path.join(root, "index.html"), ...files(path.join(root, "js")), ...files(path.join(root, "css"))];

// Heresay's Report button (docs/web-app.md, "Heresay"): the one remote script, and the one host the policy opens for it.
const HERESAY = "https://heresay-sibhi.web.app";
const heresayTag = new RegExp(
  `<script src="${HERESAY.replace(/\./g, "\\.")}/sdk/v1\\.js" data-key="pk_[A-Za-z0-9_-]+" defer></script>`,
);
const withoutHeresay = (html) => html.replace(heresayTag, "");

const guestExceptions = {
  "private-key export": [path.join("js", "guest-crypto.js")],
  "a network call outside the database client": [path.join("js", "guest-relay.js")],
  // The app sign-in page parks {mode, state, at} (no secret) across the hosted login's redirect, 10 minutes at most.
  "web storage and cookies": [path.join("js", "app-signin.js")],
};

describe("the served code", () => {
  const sources = served.map((file) => [path.relative(root, file), fs.readFileSync(file, "utf8")]);

  it.each([
    ["innerHTML", /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/],
    ["eval", /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'`]/],
    ["web storage and cookies", /localStorage|sessionStorage|document\.cookie/],
    ["private-key export", /exportKey\(\s*["'](?:pkcs8|jwk)/],
    ["logging", /console\.(log|info|debug|warn|error)/],
    ["a network call outside the database client", /XMLHttpRequest|WebSocket|sendBeacon|importScripts/],
  ])("has no %s", (_name, pattern) => {
    for (const [name, text] of sources) {
      // The guest page (docs/web-app.md, "Web guests") has three named exceptions, each in one file and pinned below.
      if (guestExceptions[_name]?.includes(name)) continue;
      expect(text, name).not.toMatch(pattern);
    }
  });

  it("keeps the guest page's exceptions to the one file that needs each, and nowhere else", () => {
    const text = (name) => fs.readFileSync(path.join(root, "js", name), "utf8");
    // The relay client and its Data Streams socket are the guest's whole network layer.
    expect(text("guest-relay.js")).toMatch(/new WebSocket\(url\)/);
    expect(text("guest-relay.js").match(/WebSocket/g).length).toBeGreaterThan(0);
    // The member key is one point for ECDSA and ECDH: made extractable once, its private half exported once, imported as two
    // non-extractable keys, and the bytes zeroed. Nothing exports a private key anywhere else, and nothing stores it.
    const crypto = text("guest-crypto.js");
    expect(crypto.match(/exportKey\("pkcs8"/g)).toHaveLength(1);
    expect(crypto).not.toMatch(/exportKey\("jwk"/);
    expect(crypto).toMatch(/importKey\("pkcs8", pkcs8, \{ name: "ECDSA", namedCurve: "P-256" \}, false/);
    expect(crypto).toMatch(/importKey\("pkcs8", pkcs8, \{ name: "ECDH", namedCurve: "P-256" \}, false/);
    expect(crypto).toMatch(/pkcs8\.fill\(0\)/);
    // The guest page's HTML has no inline script, style or handler and loads nothing remote.
    const html = withoutHeresay(fs.readFileSync(path.join(root, "join.html"), "utf8"));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=|<style/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
  });

  it("makes no raw fetch outside rtdb.js", () => {
    for (const [name, text] of sources) {
      if (name !== path.join("js", "rtdb.js") && name !== path.join("js", "guest-relay.js"))
        expect(text, name).not.toMatch(/\bfetch\(/);
    }
  });

  it("has no inline script, inline style, handler attribute or remote file in the page", () => {
    const html = withoutHeresay(fs.readFileSync(path.join(root, "index.html"), "utf8"));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=|<style/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
  });

  it("extracts the channel secret into a key and exports no raw bytes of it", () => {
    const text = fs.readFileSync(path.join(root, "js", "channel-crypto.js"), "utf8");
    expect(text).toMatch(/importKey\("raw", raw, \{ name: "AES-GCM" \}, false/);
    expect(text).toMatch(/generateKey\(\{ name: "ECDSA", namedCurve: "P-256" \}, false/);
  });
});

// The Catalyst relay (src/cloud/location.ts `CATALYST_HOST`) and its Data Streams sockets, every region.
const REGIONS = ["in", "com", "eu", "com.au", "jp", "ca", "sa"];
const CATALYST_CONNECT = [
  ...REGIONS.map((r) => `https://*.catalystserverless.${r}`),
  ...REGIONS.map((r) => `https://*.catalystappsail.${r}`),
  ...REGIONS.map((r) => `wss://*.zoho.${r}`),
].join(" ");
// Catalyst's embedded login: the platform's SDK from its CDN, and the login frame from the app's own domain or Zoho accounts.
const ZOHO_CDN = "https://static.zohocdn.com";
const FRAME_SRC = [
  ...REGIONS.map((r) => `https://*.catalystserverless.${r}`),
  ...REGIONS.map((r) => `https://accounts.zoho.${r}`),
].join(" ");

describe("entry.html's policy (Catalyst cannot send headers)", () => {
  const html = fs.readFileSync(path.join(root, "entry.html"), "utf8");
  const csp = Object.fromEntries(
    html
      .match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1]
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...values]) => [name, values.join(" ")]),
  );

  it("sends the strict policy", () => {
    expect(csp).toEqual({
      "default-src": "'none'",
      "script-src": `'self' ${HERESAY} ${ZOHO_CDN}`,
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data: blob:",
      "media-src": "blob:",
      "frame-src": `'self' ${FRAME_SRC}`,
      "connect-src": `'self' ${HERESAY} https://*.firebasedatabase.app https://*.firebaseio.com ${CATALYST_CONNECT}`,
      "base-uri": "'none'",
      "form-action": "'none'",
    });
  });

  it("sends no referrer", () => {
    expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
  });

  it("refuses to run inside a frame (no X-Frame-Options or frame-ancestors from Catalyst)", () => {
    const entry = fs.readFileSync(path.join(root, "js", "entry.js"), "utf8");
    expect(entry).toMatch(/win\.top !== win\.self/);
    expect(entry).toMatch(/if \(framed\(\)\) \{[\s\S]*\} else \{\s*void startEntry\(\);/);
  });
});

describe("Heresay on every entry page", () => {
  const page = (name) => fs.readFileSync(path.join(root, name), "utf8");
  const csp = (html) =>
    Object.fromEntries(
      html
        .match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1]
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values]),
    );

  it.each(["entry.html", "index.html", "join.html"])("%s loads the tag once, deferred, and sets no look", (name) => {
    const html = page(name);
    expect(html.match(heresayTag)).toHaveLength(1);
    expect(html).not.toMatch(/data-(?:intro|nudge|accent|position|button)=/);
  });

  it.each(["entry.html", "join.html"])("%s's policy opens Heresay for script and connect only", (name) => {
    const policy = csp(page(name));
    expect(policy["script-src"]).toEqual(name === "entry.html" ? ["'self'", HERESAY, ZOHO_CDN] : ["'self'", HERESAY]);
    expect(policy["connect-src"]).toContain(HERESAY);
    // The widget draws in a shadow root with its own <style>, which style-src 'self' would block.
    expect(policy["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    for (const other of ["default-src", "img-src", "base-uri", "form-action"]) {
      expect(policy[other].join(" ")).not.toContain("heresay");
    }
  });
});
