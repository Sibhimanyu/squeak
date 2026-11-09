import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enabledAddons, loadAddons, NoConductorRoute } from "./addons.js";

const context = { conductorDbPath: "/nope/conductor.db", supportDir: "/nope" };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "addons-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function addon(name: string, body: string): string {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return pathToFileURL(file).href;
}

describe("enabledAddons", () => {
  it("reads SQUEAK_ADDONS and the older relay alias, once each, ignoring odd names", () => {
    expect(enabledAddons({})).toEqual([]);
    expect(enabledAddons({ SQUEAK_ADDONS: " A-one , b2,../x,, a-one" })).toEqual(["a-one", "b2"]);
    expect(enabledAddons({ SQUEAK_CONDUCTOR_RELAY: "on" })).toEqual(["conductor-relay"]);
    expect(enabledAddons({ SQUEAK_ADDONS: "conductor-relay", SQUEAK_CONDUCTOR_RELAY: "ON" })).toEqual([
      "conductor-relay",
    ]);
    expect(enabledAddons({ SQUEAK_CONDUCTOR_RELAY: "off" })).toEqual([]);
  });
});

describe("loadAddons", () => {
  it("loads nothing, and never touches the file system, when none is enabled", async () => {
    const loaded = await loadAddons(context, {}, () => {
      throw new Error("looked");
    });
    expect(loaded.names).toEqual([]);
    expect(loaded.conductorRoute).toBeInstanceOf(NoConductorRoute);
    expect(loaded.routes).toEqual([]);
  });

  it("skips an add-on that is missing or throws, and keeps the others", async () => {
    const entries: Record<string, string> = {
      good: addon(
        "good",
        `export default { activate: () => ({ routes: [{ method: "GET", path: "/control/x", handle: () => ({ status: 200, body: 1 }) }], stop: async () => { globalThis.__stopped = true; } }) };`,
      ),
      bad: addon("bad", `export default { activate: () => { throw new Error("boom"); } };`),
      shapeless: addon("shapeless", `export default 3;`),
    };
    const loaded = await loadAddons(
      context,
      { SQUEAK_ADDONS: "bad,gone,shapeless,good" },
      (name) => entries[name] ?? null,
    );
    expect(loaded.names).toEqual(["good"]);
    expect(loaded.routes.map((route) => route.path)).toEqual(["/control/x"]);
    expect(loaded.conductorRoute.isReady()).toBe(false);
    await loaded.stop();
    expect((globalThis as { __stopped?: boolean }).__stopped).toBe(true);
  });

  it("the stand-in route is never ready and refuses with a sentence", async () => {
    const route = new NoConductorRoute();
    expect(await route.send()).toEqual({ ok: false, reason: expect.stringContaining("isn't available") });
    expect(await route.startChat({ workspaceId: "w", agent: "claude", text: "t" })).toMatchObject({ ok: false });
  });
});
