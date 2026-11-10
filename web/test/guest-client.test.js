import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..", "..");

describe("the Catalyst client folder for the guest page", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "guest-client-"));
  execFileSync(path.join(root, "scripts", "build-guest-client.sh"), [out], { stdio: "pipe" });
  const files = (dir) =>
    fs
      .readdirSync(path.join(out, dir), { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => `${dir}/${f.name}`);

  it("holds the page, its styles, the duck and exactly the scripts it imports", () => {
    expect(fs.existsSync(path.join(out, "join.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "index.html"))).toBe(true);
    expect(files("css").sort()).toEqual([
      "css/app.css",
      "css/chat.css",
      "css/guest.css",
      "css/shell.css",
      "css/tokens.css",
    ]);
    expect(files("assets")).toEqual(["assets/squeak-duck.svg"]);
    expect(files("js")).toContain("js/guest-boot.js");
    expect(files("js")).toContain("js/guest-pond.js");
    // index.html is the entry that routes to the guest page or the owner app; both are in the folder.
    expect(fs.readFileSync(path.join(out, "index.html"), "utf8")).toContain("js/entry.js");
    expect(files("js")).toContain("js/entry.js");
    expect(files("js")).toContain("js/app.js");
    expect(files("js")).toContain("js/catalyst-db.js");
  });

  it("is self-contained: every relative import resolves inside the folder, and no test or phone-app file rides along", () => {
    for (const file of files("js")) {
      const source = fs.readFileSync(path.join(out, file), "utf8");
      for (const m of source.matchAll(/from\s+"\.\/([^"]+)"/g)) {
        expect(fs.existsSync(path.join(out, "js", m[1])), `${file} imports ${m[1]}`).toBe(true);
      }
    }
    // Dynamic imports too (entry.js loads the two apps).
    for (const file of files("js")) {
      const source = fs.readFileSync(path.join(out, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const m of source.matchAll(/import\(\s*"\.\/([^"]+)"/g)) {
        expect(fs.existsSync(path.join(out, "js", m[1])), `${file} imports ${m[1]}`).toBe(true);
      }
    }
    expect(files("js").join(" ")).not.toMatch(/\.test\.|fake-|guest-helpers/);
  });

  it("the pages' own references all exist", () => {
    for (const page of ["join.html", "index.html"]) {
      const html = fs.readFileSync(path.join(out, page), "utf8");
      for (const m of html.matchAll(/(?:href|src)="([^":]+)"/g)) {
        expect(fs.existsSync(path.join(out, m[1])), `${page}: ${m[1]}`).toBe(true);
      }
    }
  });

  it("the entry's styles and images, loaded by script, exist too", () => {
    const entry = fs.readFileSync(path.join(out, "js", "entry.js"), "utf8");
    for (const m of entry.matchAll(/"(css\/[a-z]+\.css)"/g))
      expect(fs.existsSync(path.join(out, m[1])), m[1]).toBe(true);
  });

  it("is a target of catalyst.json with a client-package.json", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "cloud", "catalyst-relay", "catalyst.json"), "utf8"));
    expect(config.client.source).toBe("client");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "cloud", "catalyst-relay", "client", "client-package.json"), "utf8"),
    );
    expect(pkg.homepage).toBe("/app/index.html");
  });
});
