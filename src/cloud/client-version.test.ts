import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CatalystStore } from "./catalyst-store.js";
import {
  CLIENT_HEADER,
  UPDATE_LINE,
  loadMacVersion,
  macClientHeaders,
  setMacVersion,
  updateGate,
} from "./client-version.js";
import { RECONNECTING_LINE, connectionOf, overallConnection } from "../flotilla/connection.js";

afterEach(() => {
  updateGate.reset();
  setMacVersion("dev");
});

describe("the client header (#133)", () => {
  it("says mac/<version> from the app's claim file, and mac/dev without one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-cv-"));
    try {
      expect(loadMacVersion(dir)).toBe("dev");
      expect(macClientHeaders()).toEqual({ [CLIENT_HEADER]: "mac/dev" });
      fs.writeFileSync(path.join(dir, "app-install.json"), JSON.stringify({ v: 1, version: "2.35.0" }));
      loadMacVersion(dir);
      expect(macClientHeaders()).toEqual({ "x-squeak-client": "mac/2.35.0" });
      fs.writeFileSync(path.join(dir, "app-install.json"), JSON.stringify({ v: 1, version: "bad value\n" }));
      loadMacVersion(dir);
      expect(macClientHeaders()["x-squeak-client"]).toBe("mac/2.35.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is on every call the Catalyst store makes, and a 426 turns the connection into the update line", async () => {
    setMacVersion("2.34.8");
    const seen: Array<Record<string, string>> = [];
    let changed = 0;
    updateGate.onChange(() => changed++);
    const store = new CatalystStore({
      baseUrl: "https://relay.catalystappsail.in",
      macKey: "m".repeat(43),
      fetch: async (_url, init) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify({ error: "update-required", message: UPDATE_LINE }), { status: 426 });
      },
    });
    await expect(store.get("channels/PPPPPPPPPPPPPPPPPPPPPPPP/room/x")).rejects.toThrow(/426/);
    expect(seen[0]).toMatchObject({ "x-squeak-mac-key": "m".repeat(43), "x-squeak-client": "mac/2.34.8" });
    expect(updateGate.required).toBe(true);
    expect(changed).toBe(1);
    expect(connectionOf({ stream: "live", reachable: false, owner: true, updateRequired: true })).toEqual({
      state: "update-required",
      line: "Update Squeak to keep using shared Ponds",
    });
    expect(UPDATE_LINE).toBe("Update Squeak to keep using shared Ponds");
  });

  it("only a 426 marks the gate", () => {
    for (const status of [200, 401, 403, 429, 500]) updateGate.see({ status });
    expect(updateGate.required).toBe(false);
    updateGate.see({ status: 426 });
    expect(updateGate.required).toBe(true);
  });

  it("the whole Mac says the update line when any Pond does, ahead of Reconnecting", () => {
    const update = { state: "update-required" as const, line: UPDATE_LINE };
    const re = { state: "reconnecting" as const, line: RECONNECTING_LINE };
    expect(
      overallConnection([
        { owner: true, connection: re },
        { owner: false, connection: update },
      ]),
    ).toEqual(update);
  });
});
