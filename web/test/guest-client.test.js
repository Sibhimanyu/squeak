import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..", "..");

describe("the Catalyst client folder for the guest page", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "guest-client-"));
  execFileSync(path.join(root, "scripts", "build-guest-client.sh"), [out], { stdio: "pipe" });
  const files = (dir) => fs.readdirSync(path.join(out, dir)).map((f) => `${dir}/${f}`);

  it("holds the page, its styles, the duck and exactly the scripts it imports", () => {
    expect(fs.existsSync(path.join(out, "join.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "index.html"))).toBe(true);
    expect(files("css").sort()).toEqual(["css/guest.css", "css/tokens.css"]);
    expect(files("assets")).toEqual(["assets/squeak-duck.svg"]);
    expect(files("js")).toContain("js/guest-boot.js");
    expect(files("js")).toContain("js/guest-pond.js");
  });

  it("is self-contained: every relative import resolves inside the folder, and no test or phone-app file rides along", () => {
    for (const file of files("js")) {
      const source = fs.readFileSync(path.join(out, file), "utf8");
      for (const m of source.matchAll(/from\s+"\.\/([^"]+)"/g)) {
        expect(fs.existsSync(path.join(out, "js", m[1])), `${file} imports ${m[1]}`).toBe(true);
      }
    }
    const names = files("js").join(" ");
    expect(names).not.toMatch(/sync\.js|channel\.js|sends\.js|app\.js|pairing/);
  });

  it("the page's own references all exist", () => {
    const html = fs.readFileSync(path.join(out, "join.html"), "utf8");
    for (const m of html.matchAll(/(?:href|src)="([^":]+)"/g)) {
      expect(fs.existsSync(path.join(out, m[1])), m[1]).toBe(true);
    }
  });

  it("is a target of catalyst.json with a client-package.json", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "cloud", "catalyst-relay", "catalyst.json"), "utf8"));
    expect(config.client.source).toBe("client");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "cloud", "catalyst-relay", "client", "client-package.json"), "utf8"),
    );
    expect(pkg.homepage).toBe("/app/join.html");
  });
});
