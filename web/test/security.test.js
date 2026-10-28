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
    for (const [name, text] of sources) expect(text, name).not.toMatch(pattern);
  });

  it("makes no raw fetch outside rtdb.js", () => {
    for (const [name, text] of sources) {
      if (name !== path.join("js", "rtdb.js")) expect(text, name).not.toMatch(/\bfetch\(/);
    }
  });

  it("has no inline script, inline style, handler attribute or remote file in the page", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
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

describe("firebase.json for squeak-mac.web.app", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "..", "firebase", "firebase.json"), "utf8"));
  const site = config.hosting.find((entry) => entry.site === "squeak-mac");
  const rules = site.headers;
  const header = (rule, key) => rule.headers.find((h) => h.key === key)?.value;

  it("covers every path on the site", () => {
    expect(site.public).toBe("web-public");
    expect(rules.map((rule) => rule.source)).toEqual(["**"]);
  });

  it("sends the old /app address to the new site", () => {
    const main = config.hosting.find((entry) => entry.site === "squeak-5c9gvo");
    expect(main.redirects.map((r) => [r.source, r.destination])).toEqual([
      ["/app", "https://squeak-mac.web.app/"],
      ["/app/**", "https://squeak-mac.web.app/"],
    ]);
  });

  it("sends the strict policy", () => {
    for (const rule of rules) {
      const csp = Object.fromEntries(
        header(rule, "Content-Security-Policy")
          .split(";")
          .map((part) => part.trim().split(/\s+/))
          .map(([name, ...values]) => [name, values.join(" ")]),
      );
      expect(csp).toEqual({
        "default-src": "'none'",
        "script-src": "'self'",
        "style-src": "'self'",
        "img-src": "'self' data:",
        "media-src": "blob:",
        "connect-src": "https://*.firebasedatabase.app https://*.firebaseio.com",
        "frame-ancestors": "'none'",
        "base-uri": "'none'",
        "form-action": "'none'",
      });
      expect(header(rule, "Referrer-Policy")).toBe("no-referrer");
      expect(header(rule, "X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("leaves the existing rule for JSON alone", () => {
    expect(config.hosting.find((entry) => entry.site === "squeak-5c9gvo").headers).toEqual([
      {
        source: "**/*.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ]);
  });
});
