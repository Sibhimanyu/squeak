import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOTSPOT_FAILURES_TO_SWITCH,
  HOTSPOT_RETRY_GAP_MS,
  HotspotFailover,
  type HotspotSystem,
  readHotspotRequest,
  validPassword,
  validSsid,
} from "./hotspot.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A Mac whose network the test drives: on home Wi-Fi until it joins the hotspot. */
function fakeMac(options: { joinWorks?: boolean; online?: boolean } = {}) {
  let address = "192.168.1.20";
  let online = options.online ?? true;
  let password: string | null = null;
  const calls: string[] = [];
  const system: HotspotSystem = {
    wifiDevice: async () => "en0",
    address: async () => address,
    online: async () => online,
    join: async (_device, ssid, pw) => {
      calls.push(`join ${ssid} ${pw}`);
      if (options.joinWorks === false) return "Could not find network Sibhi's iPhone.";
      address = "172.20.10.3";
      online = true;
      return null;
    },
    cycle: async () => {
      calls.push("cycle");
      address = "192.168.1.20";
    },
    readPassword: async () => password,
    storePassword: async (pw) => {
      password = pw;
    },
  };
  return {
    system,
    calls,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

function failover(mac: ReturnType<typeof fakeMac>, wanted = true, now = () => 1_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-"));
  dirs.push(dir);
  const notify = vi.fn();
  const onChange = vi.fn();
  const hotspot = new HotspotFailover({
    settingsPath: path.join(dir, "hotspot.json"),
    system: mac.system,
    wanted: () => wanted,
    notify,
    onChange,
    now,
    sleep: async () => undefined,
  });
  return { hotspot, notify, onChange, dir };
}

describe("HotspotFailover", () => {
  it("keeps the name in its file and the password only in the Keychain", async () => {
    const mac = fakeMac();
    const { hotspot, dir } = failover(mac);
    await hotspot.start();
    hotspot.stop();
    expect(hotspot.state.configured).toBe(false);
    const result = await hotspot.apply({
      action: "configure",
      ssid: "Sibhi's iPhone",
      password: "secret-pass",
      enabled: true,
    });
    expect(result).toMatchObject({ ok: true, state: { configured: true, ssid: "Sibhi's iPhone", enabled: true } });
    const file = fs.readFileSync(path.join(dir, "hotspot.json"), "utf8");
    expect(file).not.toContain("secret-pass");
    expect(JSON.parse(file)).toEqual({ enabled: true, ssid: "Sibhi's iPhone" });
  });

  it("joins the hotspot after half a minute without internet, when something needs the Mac", async () => {
    const mac = fakeMac();
    const { hotspot, notify } = failover(mac);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    mac.setOnline(false);
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH - 1; i += 1) await hotspot.tick();
    expect(mac.calls).toEqual([]);
    await hotspot.tick();
    expect(mac.calls).toEqual(["join Phone secret-pass"]);
    expect(hotspot.state).toMatchObject({ onHotspot: true, last: { to: "hotspot", ok: true, automatic: true } });
    expect(notify).toHaveBeenCalledWith("The Mac's Wi-Fi dropped, so it joined Phone.");
  });

  it("does nothing when switched off, unset, or nothing relies on the Mac", async () => {
    const off = fakeMac({ online: false });
    const a = failover(off);
    await a.hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: false });
    for (let i = 0; i < 5; i += 1) await a.hotspot.tick();
    const idle = fakeMac({ online: false });
    const b = failover(idle, false);
    await b.hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    for (let i = 0; i < 5; i += 1) await b.hotspot.tick();
    expect([...off.calls, ...idle.calls]).toEqual([]);
  });

  it("says what to do when the hotspot isn't there, and waits before trying again", async () => {
    let now = 1_000_000;
    const mac = fakeMac({ joinWorks: false, online: false });
    const { hotspot, notify } = failover(mac, true, () => now);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    expect(hotspot.state.last).toMatchObject({ ok: false, note: expect.stringContaining("is Personal Hotspot on?") });
    expect(notify).toHaveBeenCalledTimes(1);
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH * 2; i += 1) await hotspot.tick();
    expect(mac.calls).toHaveLength(1);
    now += HOTSPOT_RETRY_GAP_MS;
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    expect(mac.calls).toHaveLength(2);
  });

  it("switches on request, and back to the usual Wi-Fi by turning Wi-Fi off and on", async () => {
    const mac = fakeMac();
    const { hotspot, notify } = failover(mac);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: false });
    expect(await hotspot.apply({ action: "join" })).toMatchObject({ ok: true, state: { onHotspot: true } });
    expect(await hotspot.apply({ action: "leave" })).toMatchObject({ ok: true, state: { onHotspot: false } });
    expect(mac.calls).toEqual(["join Phone secret-pass", "cycle"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses to join before it is set up, and a new name without its password", async () => {
    const { hotspot } = failover(fakeMac());
    expect(await hotspot.apply({ action: "join" })).toMatchObject({ ok: false, reason: /Set up/ });
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    expect(await hotspot.apply({ action: "configure", ssid: "Other", enabled: true })).toMatchObject({
      ok: false,
      reason: /password/,
    });
    expect(await hotspot.apply({ action: "configure", ssid: "Phone", enabled: false })).toMatchObject({ ok: true });
  });
});

describe("hotspot requests", () => {
  it("reads only the shapes there are", () => {
    expect(readHotspotRequest({ action: "join" })).toEqual({ action: "join" });
    expect(readHotspotRequest({ action: "configure", ssid: "Phone", password: "12345678", enabled: true })).toEqual({
      action: "configure",
      ssid: "Phone",
      password: "12345678",
      enabled: true,
    });
    expect(readHotspotRequest({ action: "configure", ssid: "Phone", password: "short", enabled: true })).toBeNull();
    expect(readHotspotRequest({ action: "configure", ssid: "", enabled: true })).toBeNull();
    expect(readHotspotRequest({ action: "delete" })).toBeNull();
    expect(validSsid("a".repeat(33))).toBe(false);
    expect(validSsid("bad\nname")).toBe(false);
    expect(validPassword("a".repeat(64))).toBe(false);
    expect(validPassword("ünicode!")).toBe(false);
  });
});
