import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const dir = new URL("../../firebase/redirects/web/", import.meta.url);
const load = () => {
  const ctx = { location: { search: "", hash: "" } };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL("redirect.js", dir), "utf8"), ctx);
  return ctx.squeakRedirect;
};

describe("squeak-mac.web.app forwarder", () => {
  const { forwardUrl, TARGET } = load();
  it("sends every path to the Catalyst app, keeping query and fragment", () => {
    expect(TARGET).toMatch(/\/app\/index\.html$/);
    expect(forwardUrl({ pathname: "/join/x", search: "?a=1", hash: "#abc" })).toBe(`${TARGET}?a=1#abc`);
    expect(forwardUrl({ pathname: "/join", search: "", hash: "#abc" })).toBe(`${TARGET}#abc`);
    expect(forwardUrl({ pathname: "/", search: "", hash: "" })).toBe(TARGET);
  });
  it("loads its script by absolute path so deep paths work", () => {
    const html = fs.readFileSync(new URL("index.html", dir), "utf8");
    expect(html).toContain('<script src="/redirect.js">');
    expect(html).not.toContain('src="redirect.js"');
  });
});
