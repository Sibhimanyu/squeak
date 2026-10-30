import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { generateChannel } from "../remote/remote-crypto.js";
import {
  AddonUpdater,
  cleanVersion,
  isNewer,
  LATEST_CONFIG_URL,
  parseConfigVersion,
  SUPERVISOR_UPDATE_URL,
  type FetchLike,
} from "./addon-update.js";
import { panelState } from "./addon-panel.js";
import { gatewayStatusNow } from "./addon-pairing.js";
import { VoiceGateway } from "./gateway.js";
import { readGatewayStatus, sealGatewayStatus } from "./gateway-status-protocol.js";
import { OLD_ADDON, RelayLine } from "./relay-line.js";
import {
  newCallId,
  readGatewayCommand,
  readResult,
  requestPath,
  sealBody,
  sealGatewayCommand,
  sealPinControl,
  sealResult,
  type GatewayCommandRequest,
} from "./relay-protocol.js";

const TOKEN = "CANARY-supervisor-token-9f3a";
const config = (version: string) => `name: Squeak Voice\nversion: "${version}"\nslug: squeak_voice\n`;

/** A fetch that answers the config look and the Supervisor call as told, and records every call. */
function fakeFetch(options: {
  latest?: string | Error | { status: number; body?: string };
  supervisor?: number | Error;
}) {
  const calls: Array<{ url: string; method: string | undefined; headers: Record<string, string> | undefined }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    if (url === LATEST_CONFIG_URL) {
      const latest = options.latest;
      if (latest instanceof Error) throw latest;
      if (typeof latest === "object") return { ok: false, status: latest.status, text: async () => latest.body ?? "" };
      return { ok: true, status: 200, text: async () => config(latest ?? "0.10.1") };
    }
    if (url === SUPERVISOR_UPDATE_URL) {
      const supervisor = options.supervisor ?? 200;
      if (supervisor instanceof Error) throw supervisor;
      return { ok: supervisor >= 200 && supervisor < 300, status: supervisor, text: async () => `body ${TOKEN}` };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchFn, calls };
}

describe("version helpers", () => {
  it("compares x.y.z numerically and strictly", () => {
    expect(isNewer("0.10.1", "0.10.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.5")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.10.0", "0.10.0")).toBe(false);
    expect(isNewer("0.9.9", "0.10.0")).toBe(false);
    for (const bad of ["", "unknown", "1.2", "1.2.3.4", "1.2.3-beta", "v1.2.3", "1.2.x", " 1.2.3", "1.2.3\n"]) {
      expect(isNewer(bad, "0.0.1")).toBe(false);
      expect(isNewer("9.9.9", bad)).toBe(false);
      expect(cleanVersion(bad)).toBeNull();
    }
    expect(isNewer(null, "1.0.0")).toBe(false);
    expect(isNewer("1.0.1", undefined)).toBe(false);
  });

  it("reads only a quoted version: line", () => {
    expect(parseConfigVersion(config("0.10.1"))).toBe("0.10.1");
    expect(parseConfigVersion("version: 0.10.1\n")).toBeNull();
    expect(parseConfigVersion('version: "latest"\n')).toBeNull();
    expect(parseConfigVersion('  version: "1.2.3"\n')).toBeNull();
    expect(parseConfigVersion("")).toBeNull();
  });
});

describe("AddonUpdater.look", () => {
  it("keeps the last good answer when a look fails or is garbage", async () => {
    const good = fakeFetch({ latest: "0.10.1" });
    const updater = new AddonUpdater({ version: "0.10.0", fetch: good.fetchFn });
    expect(await updater.look()).toBe("0.10.1");
    for (const latest of [new Error("offline"), { status: 500 }, "garbage"] as const) {
      const next = new AddonUpdater({ version: "0.10.0", fetch: fakeFetch({ latest }).fetchFn });
      expect(await next.look()).toBeNull();
    }
    const flaky = fakeFetch({ latest: new Error("offline") });
    (updater as unknown as { fetchFn: FetchLike }).fetchFn = flaky.fetchFn;
    expect(await updater.look()).toBe("0.10.1");
    expect(good.calls.map((c) => c.url)).toEqual([LATEST_CONFIG_URL]);
    expect(good.calls[0]?.headers).toBeUndefined();
  });

  it("never sends the token to the version look", async () => {
    const f = fakeFetch({});
    await new AddonUpdater({ version: "0.10.0", fetch: f.fetchFn, token: TOKEN }).look();
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
  });
});

describe("AddonUpdater.update", () => {
  async function ready(version: string, latest: string, supervisor: number | Error, token: string | null = TOKEN) {
    const f = fakeFetch({ latest, supervisor });
    const updater = new AddonUpdater({ version, fetch: f.fetchFn, token: token ?? undefined });
    await updater.look();
    return { updater, calls: f.calls };
  }

  it("asks the Supervisor only when the newest version it found is newer", async () => {
    for (const [running, latest] of [
      ["0.10.0", "0.10.0"],
      ["0.10.1", "0.10.0"],
      ["unknown", "0.10.0"],
    ] as const) {
      const { updater, calls } = await ready(running, latest, 200);
      const started = vi.fn();
      expect(await updater.update(started)).toEqual({ ok: false, reason: "Already on the newest version." });
      expect(started).not.toHaveBeenCalled();
      expect(calls.some((c) => c.url === SUPERVISOR_UPDATE_URL)).toBe(false);
    }
    // Never looked: nothing is known, so nothing is updated.
    const blind = new AddonUpdater({ version: "0.10.0", fetch: fakeFetch({}).fetchFn, token: TOKEN });
    expect((await blind.update(vi.fn())).ok).toBe(false);
    // Garbage in the config is not a version.
    const garbage = new AddonUpdater({
      version: "0.10.0",
      fetch: fakeFetch({ latest: "latest" }).fetchFn,
      token: TOKEN,
    });
    await garbage.look();
    expect((await garbage.update(vi.fn())).ok).toBe(false);
  });

  it("posts to the fixed Supervisor address with the token from its options, after `started`", async () => {
    const { updater, calls } = await ready("0.10.0", "0.10.1", 200);
    const order: string[] = [];
    const f = fakeFetch({ latest: "0.10.1", supervisor: 200 });
    const spy: FetchLike = async (url, init) => {
      if (url === SUPERVISOR_UPDATE_URL) order.push("supervisor");
      return f.fetchFn(url, init);
    };
    (updater as unknown as { fetchFn: FetchLike }).fetchFn = spy;
    expect(await updater.update(() => void order.push("started"))).toEqual({ ok: true });
    expect(order).toEqual(["started", "supervisor"]);
    void calls;
    const post = f.calls.find((c) => c.url === SUPERVISOR_UPDATE_URL)!;
    expect(post.method).toBe("POST");
    expect(post.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(SUPERVISOR_UPDATE_URL).toBe("http://supervisor/addons/self/update");
  });

  it.each([
    [401, /'manager' permission/],
    [403, /'manager' permission/],
    [500, /could not update the add-on/],
    [404, /could not update the add-on/],
  ])("turns a Supervisor %i into a plain sentence with no token and no body", async (status, pattern) => {
    const { updater } = await ready("0.10.0", "0.10.1", status);
    const outcome = await updater.update(vi.fn());
    expect(outcome.ok).toBe(false);
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toMatch(pattern);
    expect(reason).not.toContain(TOKEN);
    expect(reason).not.toContain("body");
  });

  it("says the update service did not answer when the Supervisor is unreachable", async () => {
    const { updater } = await ready("0.10.0", "0.10.1", new Error(`connect ECONNREFUSED ${TOKEN}`));
    const outcome = await updater.update(vi.fn());
    expect(outcome).toEqual({
      ok: false,
      reason: "Home Assistant's update service did not answer. Update it in Home Assistant.",
    });
  });

  it("refuses without a token, before replying or calling anything", async () => {
    const { updater, calls } = await ready("0.10.0", "0.10.1", 200, null);
    const started = vi.fn();
    expect(await updater.update(started)).toEqual({
      ok: false,
      reason: "This add-on can't reach Home Assistant's update service. Update it in Home Assistant.",
    });
    expect(started).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === SUPERVISOR_UPDATE_URL)).toBe(false);
    const empty = await ready("0.10.0", "0.10.1", 200, "");
    expect((await empty.updater.update(vi.fn())).ok).toBe(false);
  });

  it("does not run two updates at once", async () => {
    const { updater } = await ready("0.10.0", "0.10.1", 200);
    let release: () => void = () => undefined;
    const first = updater.update(() => new Promise<void>((resolve) => (release = resolve)));
    expect(await updater.update(vi.fn())).toEqual({ ok: false, reason: "The update is already under way." });
    release();
    expect(await first).toEqual({ ok: true });
  });
});

describe("gwcmd protocol", () => {
  const { key } = generateChannel();
  const now = 1_800_000_000_000;
  const request = (extra: Record<string, unknown> = {}, id = "abc"): GatewayCommandRequest =>
    ({
      v: 1,
      id,
      at: now,
      expiresAt: now + 25_000,
      kind: "gwcmd",
      action: "update",
      ...extra,
    }) as GatewayCommandRequest;

  it("round-trips and keeps the words out of the clear", () => {
    const doc = sealGatewayCommand(key, request());
    expect(JSON.stringify(doc)).not.toContain("update");
    expect(readGatewayCommand(key, "abc", doc, now)).toEqual({ ok: true, request: request() });
  });

  it("refuses another key, id, direction, extra keys, other actions, expiry and non-gwcmd bodies", () => {
    const doc = sealGatewayCommand(key, request());
    expect(readGatewayCommand(generateChannel().key, "abc", doc, now).ok).toBe(false);
    expect(readGatewayCommand(key, "other", doc, now).ok).toBe(false);
    const asResult = sealBody(key, "res", "abc", request(), now);
    expect(readGatewayCommand(key, "abc", asResult, now).ok).toBe(false);
    for (const bad of [
      request({ extra: 1 }),
      request({ action: "restart" }),
      request({ action: "" }),
      request({ action: undefined }),
      request({ kind: "pinctl" }),
      request({ v: 2 }),
      request({}, "different"),
    ]) {
      expect(readGatewayCommand(key, "abc", sealBody(key, "req", "abc", bad, now), now).ok).toBe(false);
    }
    const noAction: Record<string, unknown> = { ...request() };
    delete noAction.action;
    expect(readGatewayCommand(key, "abc", sealBody(key, "req", "abc", noAction, now), now).ok).toBe(false);
    expect(readGatewayCommand(key, "abc", doc, now + 60 * 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(
      readGatewayCommand(key, "abc", sealBody(key, "req", "abc", request({ at: now + 10 * 60_000 }), now), now).ok,
    ).toBe(false);
    // A pin control is not a gateway command, and the other way round.
    const pinctl = sealPinControl(key, {
      v: 1,
      id: "abc",
      at: now,
      expiresAt: now + 1000,
      kind: "pinctl",
      action: "status",
    });
    expect(readGatewayCommand(key, "abc", pinctl, now).ok).toBe(false);
  });

  it("reads a gwcmd result and clips the reason", () => {
    const seal = (body: Record<string, unknown>) =>
      sealBody(key, "res", "abc", { v: 1, id: "abc", at: now, ...body }, now);
    expect(readResult(key, "abc", seal({ status: "gwcmd", ok: true }), [])).toEqual({ status: "gwcmd", ok: true });
    const long = readResult(key, "abc", seal({ status: "gwcmd", ok: false, reason: "x".repeat(500) }), []);
    expect(long).toEqual({ status: "gwcmd", ok: false, reason: "x".repeat(200) });
    expect(readResult(key, "abc", seal({ status: "gwcmd", ok: false }), [])).toBeNull();
    expect(readResult(key, "abc", seal({ status: "gwcmd" }), [])).toBeNull();
    expect(sealResult(key, { v: 1, id: "abc", at: now, status: "gwcmd", ok: true })).toHaveProperty("box");
  });
});

describe("latestVersion in the status and the panel", () => {
  const { key } = generateChannel();
  const sources = (latest?: string | null) => ({
    version: "0.10.0",
    registration: () => ({ registered: true }),
    pin: () => "set" as const,
    ...(latest !== undefined ? { latestVersion: () => latest } : {}),
  });

  it("is reported only when it is a plain version, and read back strictly", () => {
    expect(gatewayStatusNow(sources("0.10.1"), 5)).toMatchObject({ latestVersion: "0.10.1" });
    expect(gatewayStatusNow(sources(null), 5)).not.toHaveProperty("latestVersion");
    expect(gatewayStatusNow(sources("junk"), 5)).not.toHaveProperty("latestVersion");
    expect(gatewayStatusNow(sources(), 5)).not.toHaveProperty("latestVersion");
    const now = 1_000_000;
    const read = (latestVersion: unknown) =>
      readGatewayStatus(
        key,
        sealBody(key, "res", "gwstatus", { ...gatewayStatusNow(sources(), now), latestVersion }, now),
        now,
      );
    expect(read("0.10.1")?.latestVersion).toBe("0.10.1");
    expect(read("0.10.1; rm -rf")).not.toHaveProperty("latestVersion");
    expect(read(5)).not.toHaveProperty("latestVersion");
    const doc = sealGatewayStatus(key, gatewayStatusNow(sources("0.10.2"), now));
    expect(readGatewayStatus(key, doc, now)?.latestVersion).toBe("0.10.2");
  });

  it("the panel says an update is available only when newer, and carries no token", () => {
    const panel = (latest: string | null) =>
      panelState({
        version: "0.10.0",
        latestVersion: () => latest,
        paired: () => true,
        code: () => null,
        registration: () => ({ registered: true }),
        pin: () => "set",
        log: () => [],
      });
    expect(panel("0.10.1").updateAvailable).toBe("0.10.1");
    expect(panel("0.10.0")).not.toHaveProperty("updateAvailable");
    expect(panel("0.9.0")).not.toHaveProperty("updateAvailable");
    expect(panel(null)).not.toHaveProperty("updateAvailable");
    expect(JSON.stringify(panel("0.10.1"))).not.toContain(TOKEN);
  });
});

describe("the Mac asking the add-on to update, through the relay", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  const { channelId: channel, key } = generateChannel();
  let gateway: VoiceGateway | null = null;
  const events: string[] = [];

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    events.length = 0;
  });
  afterEach(async () => {
    gateway?.stop();
    gateway = null;
    await db.stop();
  });

  async function start(updater: AddonUpdater | null | undefined) {
    gateway = new VoiceGateway({
      store,
      channel,
      key,
      callee: "101",
      pin: () => null,
      line: { call: async () => ({ status: "unanswered" }) },
      ...(updater !== undefined ? { updater } : {}),
      onEvent: (_level, text) => void events.push(text),
    });
    gateway.start();
    return new RelayLine({ store, channel, key });
  }

  async function updaterFor(version: string, latest: string, supervisor: number | Error, token = TOKEN) {
    const f = fakeFetch({ latest, supervisor });
    const updater = new AddonUpdater({ version, fetch: f.fetchFn, token });
    await updater.look();
    return { updater, calls: f.calls };
  }

  it("writes the reply BEFORE it asks the Supervisor, and the event log names the version", async () => {
    const f = fakeFetch({ latest: "0.10.1", supervisor: 200 });
    let replyWrittenWhenSupervisorCalled = false;
    const updater = new AddonUpdater({
      version: "0.10.0",
      token: TOKEN,
      fetch: async (url, init) => {
        if (url === SUPERVISOR_UPDATE_URL) {
          // The update kills the add-on here: by now the answer must already be in the database.
          const results = await store.list(`channels/${channel}/voiceresult`);
          replyWrittenWhenSupervisorCalled = results.some(({ doc }) => doc.box !== undefined);
        }
        return f.fetchFn(url, init);
      },
    });
    await updater.look();
    const line = await start(updater);
    expect(await line.gatewayCommand("update")).toEqual({ ok: true });
    expect(replyWrittenWhenSupervisorCalled).toBe(true);
    expect(events).toEqual(["Update to 0.10.1 requested from the Mac"]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("refuses an update when already newest, without a token, or when Home Assistant refuses first", async () => {
    const same = await updaterFor("0.10.1", "0.10.1", 200);
    expect(await (await start(same.updater)).gatewayCommand("update")).toEqual({
      ok: false,
      reason: "Already on the newest version.",
    });
    expect(same.calls.some((c) => c.url === SUPERVISOR_UPDATE_URL)).toBe(false);
    expect(events).toEqual(["Update refused: Already on the newest version."]);
  });

  it("with no token the reply is the plain refusal", async () => {
    const f = fakeFetch({ latest: "0.10.1" });
    const updater = new AddonUpdater({ version: "0.10.0", fetch: f.fetchFn });
    await updater.look();
    const line = await start(updater);
    expect(await line.gatewayCommand("update")).toEqual({
      ok: false,
      reason: "This add-on can't reach Home Assistant's update service. Update it in Home Assistant.",
    });
  });

  it("a Supervisor refusal after the reply is only noted in the event log", async () => {
    const t = await updaterFor("0.10.0", "0.10.1", 403);
    const line = await start(t.updater);
    expect(await line.gatewayCommand("update")).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(events.some((e) => e.startsWith("Update refused: Home Assistant refused"))).toBe(true),
    );
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("an add-on with no updater refuses, and one that never answers is reported as too old", async () => {
    const line = await start(null);
    expect(await line.gatewayCommand("update")).toEqual({
      ok: false,
      reason: "This add-on cannot update itself from an app.",
    });
    gateway?.stop();
    gateway = null;
    // Nothing answers: an add-on from before gwcmd.
    let clock = 1_800_000_000_000;
    const silent = {
      set: async () => undefined,
      get: async () => null,
      delete: async () => undefined,
      watch: (_path: string, onChange: () => void) => {
        const timer = setTimeout(() => {
          clock += 60_000;
          onChange();
        }, 5);
        return () => clearTimeout(timer);
      },
    } as unknown as ConstructorParameters<typeof RelayLine>[0]["store"];
    const quiet = new RelayLine({ store: silent, channel, key, now: () => clock });
    expect(await quiet.gatewayCommand("update")).toEqual({ ok: false, reason: OLD_ADDON });
  });

  it("drops a gwcmd with extra keys, a bad action, a stale time or the wrong key, and never calls the Supervisor", async () => {
    const t = await updaterFor("0.10.0", "0.10.1", 200);
    await start(t.updater);
    const at = Date.now();
    const other = generateChannel().key;
    const send = async (box: unknown, signKey = key) => {
      const id = newCallId();
      await store.set(requestPath(channel, id), sealBody(signKey, "req", id, { id, ...(box as object) }, at));
      return id;
    };
    const base = { v: 1, at, expiresAt: at + 25_000, kind: "gwcmd", action: "update" };
    await send({ ...base, extra: true });
    await send({ ...base, action: "restart" });
    await send({ ...base, expiresAt: at - 1000 });
    await send(base, other);
    await gateway!.pass();
    expect(t.calls.some((c) => c.url === SUPERVISOR_UPDATE_URL)).toBe(false);
    expect(events).toEqual([]);
  });

  it("a second copy of the same command id does not update twice", async () => {
    const t = await updaterFor("0.10.0", "0.10.1", 200);
    await start(t.updater);
    const id = newCallId();
    const at = Date.now();
    const doc = sealGatewayCommand(key, { v: 1, id, at, expiresAt: at + 25_000, kind: "gwcmd", action: "update" });
    await store.set(requestPath(channel, id), doc);
    await gateway!.pass();
    await store.set(requestPath(channel, id), doc);
    await gateway!.pass();
    expect(t.calls.filter((c) => c.url === SUPERVISOR_UPDATE_URL)).toHaveLength(1);
  });

  it("the token appears in no database document", async () => {
    const t = await updaterFor("0.10.0", "0.10.1", 200);
    const line = await start(t.updater);
    await line.gatewayCommand("update");
    await gateway!.pass();
    const docs = [
      ...(await store.list(`channels/${channel}/voiceresult`)),
      ...(await store.list(`channels/${channel}/voice`)),
    ];
    expect(JSON.stringify(docs)).not.toContain(TOKEN);
  });
});
