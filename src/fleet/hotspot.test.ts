import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeHandsJoin,
  HOTSPOT_FAILURES_TO_SWITCH,
  HOTSPOT_MANUAL_QUIET_MS,
  HOTSPOT_RETRY_BACKOFF_MS,
  HotspotFailover,
  probeInternet,
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
  let joinWorks = options.joinWorks !== false;
  let password: string | null = null;
  const calls: string[] = [];
  const system: HotspotSystem = {
    wifiDevice: async () => "en0",
    address: async () => address,
    online: async () => online,
    join: async (_device, ssid, pw) => {
      calls.push(`join ${ssid} ${pw}`);
      if (!joinWorks) return "is Personal Hotspot on? Open Personal Hotspot on the iPhone.";
      address = "172.20.10.3";
      online = true;
      return null;
    },
    prepare: async () => {
      calls.push("prepare");
    },
    cycle: async () => {
      calls.push("cycle");
      address = "192.168.1.20";
    },
    readPassword: async () => password,
    storePassword: async (pw) => {
      password = pw;
    },
    deletePassword: async () => {
      calls.push("deletePassword");
      password = null;
    },
  };
  return {
    system,
    calls,
    setOnline: (value: boolean) => {
      online = value;
    },
    setJoinWorks: (value: boolean) => {
      joinWorks = value;
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
    // Location Services is asked for now, while someone is at the Mac.
    expect(mac.calls).toEqual(["prepare"]);
  });

  it("clears the name and the Keychain password", async () => {
    const mac = fakeMac();
    const { hotspot, dir, onChange } = failover(mac);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    onChange.mockClear();
    const result = await hotspot.apply({ action: "clear" });
    expect(result).toMatchObject({ ok: true, state: { configured: false, ssid: null, enabled: false } });
    expect(mac.calls).toContain("deletePassword");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "hotspot.json"), "utf8"))).toEqual({ enabled: false, ssid: null });
    expect(onChange).toHaveBeenCalled();
    expect(await hotspot.apply({ action: "join" })).toMatchObject({ ok: false });
  });

  it("joins the hotspot after half a minute without internet, when something needs the Mac", async () => {
    const mac = fakeMac();
    const { hotspot, notify } = failover(mac);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    mac.calls.length = 0;
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
    expect([...off.calls, ...idle.calls.filter((call) => call !== "prepare")]).toEqual([]);
  });

  it("keeps trying on a short backoff through an outage, and says so once", async () => {
    let now = 1_000_000;
    const mac = fakeMac({ joinWorks: false, online: false });
    const { hotspot, notify } = failover(mac, true, () => now);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    mac.calls.length = 0;
    const joins = () => mac.calls.filter((call) => call.startsWith("join")).length;
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    expect(joins()).toBe(1);
    expect(hotspot.state.last).toMatchObject({ ok: false, note: expect.stringContaining("is Personal Hotspot on?") });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("keeps trying");
    // Not before the wait, then once per wait: 10, 20, 30, 30 s.
    await hotspot.tick();
    expect(joins()).toBe(1);
    for (const wait of [...HOTSPOT_RETRY_BACKOFF_MS, HOTSPOT_RETRY_BACKOFF_MS.at(-1)!]) {
      now += wait;
      await hotspot.tick();
    }
    expect(joins()).toBe(5);
    expect(notify).toHaveBeenCalledTimes(1);
    // The phone's hotspot comes up: joined, and that is said.
    mac.setJoinWorks(true);
    now += 60_000;
    await hotspot.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("says when the Mac is back online after a failed outage, once", async () => {
    const now = 1_000_000;
    const mac = fakeMac({ joinWorks: false, online: false });
    const { hotspot, notify } = failover(mac, true, () => now);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    mac.setOnline(true);
    await hotspot.tick();
    await hotspot.tick();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toBe("The Mac is back online.");
  });

  it("starts each outage's backoff afresh", async () => {
    let now = 1_000_000;
    const mac = fakeMac({ joinWorks: false, online: false });
    const { hotspot, notify } = failover(mac, true, () => now);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    mac.setOnline(true);
    await hotspot.tick();
    mac.setOnline(false);
    now += 1_000;
    for (let i = 0; i < HOTSPOT_FAILURES_TO_SWITCH; i += 1) await hotspot.tick();
    expect(mac.calls.filter((call) => call.startsWith("join"))).toHaveLength(2);
    // failure, back online, failure
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("leaves the network alone for a while after you switch by hand", async () => {
    let now = 1_000_000;
    const mac = fakeMac();
    const { hotspot } = failover(mac, true, () => now);
    await hotspot.apply({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    await hotspot.apply({ action: "join" });
    await hotspot.apply({ action: "leave" });
    mac.setOnline(false);
    for (let i = 0; i < 4; i += 1) await hotspot.tick();
    expect(mac.calls.filter((call) => call.startsWith("join"))).toHaveLength(1);
    now += HOTSPOT_MANUAL_QUIET_MS;
    await hotspot.tick();
    expect(mac.calls.filter((call) => call.startsWith("join"))).toHaveLength(2);
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
    expect(readHotspotRequest({ action: "clear" })).toEqual({ action: "clear" });
    expect(readHotspotRequest({ action: "delete" })).toBeNull();
    expect(validSsid("a".repeat(33))).toBe(false);
    expect(validSsid("bad\nname")).toBe(false);
    expect(validPassword("a".repeat(64))).toBe(false);
    expect(validPassword("ünicode!")).toBe(false);
  });
});

describe("Squeak Hands' Wi-Fi join", () => {
  it("turns each answer into what to do", () => {
    expect(describeHandsJoin({ ok: true, location: "allowed" })).toBeNull();
    expect(describeHandsJoin({ ok: false, error: "not-found", location: "allowed" })).toMatch(/Ask to join hotspots/);
    expect(describeHandsJoin({ ok: false, error: "not-found", location: "not-asked" })).toMatch(/Location Services/);
    expect(describeHandsJoin({ ok: false, error: "not-found", location: "denied" })).toMatch(/Privacy & Security/);
    expect(describeHandsJoin({ ok: false, error: "join-failed", detail: "bad key", location: "allowed" })).toMatch(
      /refused the join \(bad key\)/,
    );
  });
});

describe("probeInternet", () => {
  const answer = (status: number, body: string | null = null) => Promise.resolve(new Response(body, { status }));

  it("is online when only Apple's captive page is blocked, as on a managed network", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("captive.apple.com") ? Promise.reject(new Error("timeout")) : answer(204)) as typeof fetch;
    expect(await probeInternet(fetchImpl)).toBe(true);
  });

  it("is online on Apple's page alone", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("captive.apple.com")
        ? answer(200, "<HTML>Success</HTML>")
        : Promise.reject(new Error("x"))) as typeof fetch;
    expect(await probeInternet(fetchImpl)).toBe(true);
  });

  it("is offline only when every look fails", async () => {
    expect(await probeInternet((async () => Promise.reject(new Error("offline"))) as typeof fetch)).toBe(false);
  });
});
