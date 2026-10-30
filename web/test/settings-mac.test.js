import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { shape } from "../js/command-shapes.js";
import * as L from "../js/settings-mac-logic.js";
import * as vm from "../js/view-model.js";

describe("Keep awake math and words", () => {
  it("builds the awake input for each change and the Mac's reader accepts it", () => {
    expect(L.awakeInput.start({ minutes: 120 })).toEqual({ on: true, minutes: 120 });
    expect(L.awakeInput.start({ minutes: 60, lid: true })).toEqual({ on: true, minutes: 60, lid: true });
    expect(L.awakeInput.start({})).toEqual({ on: true });
    expect(L.awakeInput.extend(60)).toEqual({ on: true, extend: 60 });
    expect(L.awakeInput.end()).toEqual({ on: false });
    for (const change of [
      { kind: "start", minutes: 240, lid: true },
      { kind: "start", minutes: null },
      { kind: "extend", minutes: 60 },
      { kind: "end" },
    ]) {
      expect(() => shape("awake", L.inputForChange(change))).not.toThrow();
    }
    // A lid-closed session needs a time: the Mac's own rule.
    expect(() => shape("awake", L.inputForChange({ kind: "start", minutes: null, lid: true }))).toThrow();
  });

  it("offers 1h/2h/4h/8h", () => {
    expect(L.DURATIONS.map((d) => [d.id, d.minutes])).toEqual([
      ["1h", 60],
      ["2h", 120],
      ["4h", 240],
      ["8h", 480],
    ]);
  });

  it("counts minutes until a clock time, tomorrow when it has passed", () => {
    const now = new Date(2026, 9, 28, 14, 0, 0);
    expect(L.minutesUntil("15:30", now)).toBe(90);
    expect(L.minutesUntil("13:00", now)).toBe(23 * 60);
    expect(L.minutesUntil("14:00", now)).toBe(24 * 60);
    expect(L.minutesUntil("", now)).toBeNull();
    expect(L.minutesUntil("25:00", now)).toBeNull();
    expect(L.minutesUntil("14:00", new Date(2026, 9, 28, 13, 59, 40))).toBe(1);
  });

  it("says what is left", () => {
    const now = 1_000_000;
    expect(L.left(now + 83 * 60_000, now)).toBe("1h 23m");
    expect(L.left(now + 45 * 60_000, now)).toBe("45m");
    expect(L.left(now + 20_000, now)).toBe("under a minute");
  });

  it("words the safety rules from what the Mac sends, 40 and 10 only when it sends none", () => {
    expect(L.safetySentence(null)).toBe(
      "Low Power Mode comes on at 40% battery or when your Mac runs hot, and the session ends by itself at 10% or when it gets very hot.",
    );
    expect(L.safetySentence({ lowPowerPercent: 30, endPercent: 5, heat: false })).toBe(
      "Low Power Mode comes on at 30% battery, and the session ends by itself at 5%.",
    );
    const view = { awakeRules: { lowPowerPercent: 35, endPercent: 8 } };
    expect(vm.awakeRules(view)).toMatchObject({ lowPowerPercent: 35, endPercent: 8 });
  });

  it("reads the Mac's awake fields and the last end", () => {
    const view = {
      keepAwake: true,
      awakeUntil: "2026-10-28T15:00:00Z",
      awakeLid: "on",
      awakeLidReady: true,
      awakeSleepProblem: "x",
    };
    const a = L.readAwake(view);
    expect(a.offered).toBe(true);
    expect(a.mac.until).toBe(Date.parse("2026-10-28T15:00:00Z"));
    expect(a.mac.lid).toBe("on");
    expect(a.lidReady).toBe(true);
    expect(a.sleepProblem).toBe("x");
    expect(L.readAwake({}).offered).toBe(false);
    expect(L.readAwake({ keepAwake: false }).mac).toBeNull();
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(L.ended({ reason: "battery", at: "2026-10-28T10:00:00Z", why: "9%" }, now)).toBe(
      "The last session ended because the battery ran low (9%).",
    );
    expect(L.ended({ reason: "battery", at: "2026-10-27T10:00:00Z" }, now)).toBeNull();
    expect(L.ended({ reason: "ended" }, now)).toBeNull();
  });

  it("shows a tapped start until the Mac agrees, then the Mac's word", () => {
    const now = 5_000_000;
    const tap = {
      change: { kind: "start", lid: true },
      status: L.expectedStatus({ kind: "start", minutes: 60, lid: true }, null, now),
      at: now,
    };
    expect(L.awakeStatus(null, tap, now + 10_000)).toMatchObject({ pending: true, lid: "starting" });
    expect(L.awakeStatus(null, tap, now + 50_000)).toBeNull();
    const mac = { until: now + 3_600_000, lid: null, safety: null, pending: false };
    // The Mac runs it but not yet with the lid: still the tapped look.
    expect(L.awakeStatus(mac, tap, now + 10_000)?.pending).toBe(true);
    expect(L.awakeStatus({ ...mac, lid: "on" }, tap, now + 10_000)).toEqual({ ...mac, lid: "on" });
    // An end hides a running session for 20 s, then the Mac's word wins.
    const end = { change: { kind: "end" }, status: null, at: now };
    expect(L.awakeStatus(mac, end, now + 5_000)).toBeNull();
    expect(L.awakeStatus(mac, end, now + 21_000)).toBe(mac);
    // An extend shows the new end until the Mac catches up.
    const ext = {
      change: { kind: "extend", minutes: 60 },
      status: L.expectedStatus({ kind: "extend", minutes: 60 }, mac, now),
      at: now,
    };
    expect(L.awakeStatus(mac, ext, now + 5_000).until).toBe(mac.until + 3_600_000);
    expect(L.awakeStatus({ ...mac, until: mac.until + 3_600_000 }, ext, now + 5_000).until).toBe(mac.until + 3_600_000);
  });

  it("words the lid row and its footer", () => {
    expect(L.lidRowText("on")[0]).toBe("Lid closed is on");
    expect(L.lidRowText("starting")[1]).toBe("Keep the lid open for a few seconds.");
    expect(L.lidRowText("failed", "No sudo.")[1]).toBe("No sudo. The session still runs with the lid open.");
    expect(L.awakeFooter(null, false)).toContain("set that up once in Squeak on your Mac");
    expect(L.awakeFooter(null, true)).not.toContain("set that up once");
  });
});

describe("optimistic flips", () => {
  it("shows the tap until the Mac agrees or 20 s pass, and a drop puts the switch back", () => {
    const o = new L.Overlays();
    expect(o.read("a", false, 0)).toBe(false);
    o.tap("a", true, 0);
    expect(o.read("a", false, 1_000)).toBe(true);
    expect(o.pending("a", false, 1_000)).toBe(true);
    expect(o.read("a", true, 2_000)).toBe(true);
    expect(o.pending("a", true, 2_000)).toBe(false);
    o.tap("b", true, 0);
    expect(o.read("b", false, 21_000)).toBe(false);
    o.tap("c", true, 0);
    o.drop("c");
    expect(o.read("c", false, 1)).toBe(false);
  });

  it("lays the notify flips over the Mac's channel settings, quiet hours included", () => {
    const o = new L.Overlays();
    const mac = {
      muted: false,
      approval: true,
      question: true,
      stalled: true,
      quota: true,
      finished: "conductor",
      quiet: null,
    };
    o.tap("telegram.finished", "all", 0);
    o.tap("telegram.quiet", JSON.stringify({ from: "22:00", to: "07:00" }), 0);
    o.tap("cliq.muted", true, 0);
    const shown = L.notifyShown(o, "telegram", mac, 1_000);
    expect(shown.finished).toBe("all");
    expect(shown.quiet).toEqual({ from: "22:00", to: "07:00" });
    expect(shown.muted).toBe(false);
    o.drop("telegram.quiet");
    expect(L.notifyShown(o, "telegram", mac, 1_000).quiet).toBeNull();
  });
});

describe("notify and voice inputs", () => {
  it("builds one-key notify changes the Mac accepts, and checks quiet hours", () => {
    for (const [k, v] of [
      ["muted", true],
      ["approval", false],
      ["finished", "all"],
      ["quiet", { from: "22:00", to: "07:00" }],
      ["quiet", null],
    ]) {
      expect(() => shape("notify", L.notifyInput("telegram", k, v))).not.toThrow();
    }
    expect(L.quietValid({ from: "08:00", to: "08:00" })).toBe(false);
    expect(L.quietValid({ from: "22:00", to: "07:00" })).toBe(true);
    expect(L.quietValid({ from: "8:00", to: "09:00" })).toBe(false);
    expect(L.crossesMidnight({ from: "22:00", to: "07:00" })).toBe(true);
    expect(L.crossesMidnight({ from: "01:00", to: "07:00" })).toBe(false);
  });

  it("shows only configured channels the Mac sent settings for", () => {
    const view = { notify: { telegram: { muted: false }, cliq: { muted: false }, channels: { cliq: false } } };
    expect(L.shownChannels(vm.notify(view)).map((c) => c.id)).toEqual(["telegram"]);
    expect(L.shownChannels(vm.notify({ notify: { telegram: {} } })).map((c) => c.id)).toEqual(["telegram"]);
    expect(L.shownChannels(null)).toEqual([]);
  });

  it("checks the extension, pin and test-call words", () => {
    expect(L.isExtension("101")).toBe(true);
    expect(L.isExtension("1")).toBe(false);
    expect(L.isExtension("12a")).toBe(false);
    expect(L.normalizedExtension("  ")).toBeNull();
    expect(L.normalizedExtension(" 101 ")).toBe("101");
    expect(L.pinReady("1234", "5678", "5678")).toBe(true);
    expect(L.pinReady("1234", "5678", "5679")).toBe(false);
    expect(L.pinReady("1234", "1234", "1234")).toBe(false);
    expect(L.pinReady("12", "5678", "5678")).toBe(false);
    expect(() => shape("voice", { change: { pin: { current: "1234", next: "5678" } } })).not.toThrow();
    expect(L.testLine({ status: "answered", letter: "B" })).toBe(
      "You answered and pressed B. Nothing was sent anywhere.",
    );
    expect(L.testLine({ status: "failed" })).toBe("The call failed: no reason given");
    expect(L.testLine(null)).toBeNull();
    expect(L.modeLine({ mode: "gateway" })).toBe("Your Home Assistant add-on places the calls.");
  });

  it("checks the hotspot form like the Mac does", () => {
    expect(L.hotspotFormValid("My iPhone", "password1")).toBe(true);
    expect(L.hotspotFormValid("", "password1")).toBe(false);
    expect(L.hotspotFormValid("x", "short")).toBe(false);
    expect(L.hotspotFormValid("é".repeat(17), "password1")).toBe(false);
    expect(() =>
      shape("hotspot", { action: "configure", ssid: "My iPhone", password: "password1", enabled: true }),
    ).not.toThrow();
  });
});

describe("Mac controls", () => {
  it("builds exactly one key per change and the Mac's reader accepts each", () => {
    const cases = [
      ["volume", 40],
      ["brightness", 70],
      ["muted", true],
      ["screenAwake", false],
      ["fans", "max"],
      ["power", "low"],
      ["displaySleep", true],
      ["wakeScreen", true],
      ["lock", true],
      ["listApps", true],
      ["open", "com.apple.Safari"],
      ["quit", "com.apple.Safari"],
      ["space", "left"],
      ["media", "playPause"],
    ];
    for (const [key, value] of cases) {
      const input = L.controlInput(key, value);
      expect(Object.keys(input.change)).toEqual([key]);
      expect(() => shape("controls", input)).not.toThrow();
    }
    expect(() => shape("controls", { change: { volume: 1, muted: true } })).toThrow();
    expect(() => L.controlInput("", 1)).toThrow();
  });

  it("words fans and power, offering only the modes the Mac lists", () => {
    expect(L.fanSpeed([2300, 1900])).toBe("2,300 rpm");
    expect(L.fanSpeed([0])).toBe("Off");
    expect(L.fanSpeed([])).toBeNull();
    expect(L.fanNote({ available: false })).toContain("Set up fan control on the Mac first");
    expect(L.fanNote({ available: true, mode: "max", choice: "auto" })).toContain("full while your Mac is warm");
    expect(L.fanNote({ available: true, mode: "auto", choice: "auto" })).toBeNull();
    expect(L.powerModes({ available: ["low", "auto"] })).toEqual(["auto", "low"]);
    expect(L.powerModes({ available: ["auto", "low", "high"] })).toEqual(["auto", "low", "high"]);
    expect(L.powerNote({ ready: false })).toContain("Set up on the Mac");
    expect(L.powerNote({ ready: true, overridden: true })).toContain("Low Power");
    expect(L.powerNote({ ready: true, overridden: false })).toBeNull();
    expect(L.powerTitle("high")).toBe("High Power");
  });

  it("shows each control only when the Mac says it", () => {
    expect(L.controlsLayout(vm.macControls({}))).toBeNull();
    const layout = L.controlsLayout(
      vm.macControls({
        macControls: {
          volume: 30,
          muted: false,
          apps: [{ id: "a.b", name: "A", active: true }],
          media: { playing: true },
          power: { available: [] },
        },
      }),
    );
    expect(layout).toMatchObject({
      volume: true,
      brightness: false,
      mute: true,
      screenAwake: false,
      media: true,
      power: null,
    });
    expect(layout.apps).toHaveLength(1);
  });
});

describe("the slider", () => {
  it("follows the finger at once, ignores a stale reading for 2 s, and lets go when the Mac catches up", () => {
    const commits = [];
    const s = new L.SliderSync({ commit: (v) => commits.push(v) });
    expect(s.shown(30, 0)).toBe(30);
    s.drag(55, 10);
    expect(s.shown(30, 20)).toBe(55);
    s.release(60, 100);
    expect(commits).toEqual([60]);
    expect(s.shown(30, 1_000)).toBe(60); // a stale reading
    expect(s.shown(30, 2_099)).toBe(60);
    expect(s.shown(30, 2_100)).toBe(30); // 2 s passed
    s.drag(80, 3_000);
    s.release(80, 3_010);
    expect(s.shown(79, 3_500)).toBe(79); // the Mac caught up (within 1)
    expect(s.local).toBeNull();
  });

  it("sends live at most every 150 ms and only the newest while held back", () => {
    const live = [];
    const s = new L.SliderSync({ commit: () => {}, live: (v) => live.push(v) });
    s.drag(10, 0);
    s.drag(11, 50);
    s.drag(12, 100);
    expect(live).toEqual([10]);
    expect(s.flush(120)).toBe(false);
    expect(s.flush(150)).toBe(true);
    expect(live).toEqual([10, 12]);
    s.drag(13, 160);
    s.release(14, 170);
    expect(s.flush(400)).toBe(false); // the release sent the last value, nothing is held
  });
});

describe("the Mac card", () => {
  it("words battery, heat and the glance", () => {
    expect(L.batteryText({ percent: 64, onBattery: true, watts: 35 })).toBe("64% · on battery · 35 W");
    expect(L.batteryText({ percent: 100, onBattery: false })).toBe("100% · plugged in");
    expect(L.batteryText({})).toBeNull();
    expect(L.heatReading({ chip: 62, battery: 33, fansRpm: [2300], fansMax: false })).toBe(
      "Chip 62°C · battery 33°C · fans 2,300 rpm",
    );
    expect(L.heatReading({ chip: null, battery: null, fansRpm: [0] })).toBe("fans off");
    expect(L.heatReading(null)).toBeNull();
    const now = 1_000_000;
    expect(
      L.glance({
        awake: { until: now + 90 * 60_000 },
        power: { onBattery: true, lidClosed: true },
        heat: { level: "warm" },
        live: { kind: "answering" },
        now,
      }),
    ).toEqual({ text: "Awake · 1h 30m left · On battery · Lid closed · Running warm", warm: true });
    expect(L.glance({ awake: null, power: {}, heat: null, live: { kind: "silent", since: 0 }, now })).toBeNull();
    expect(L.routePill({ live: { kind: "silent" }, hasView: true }).text).toBe("Mac offline");
    expect(L.routePill({ live: { kind: "answering" }, hasView: false }).text).toBe("Connecting");
    expect(L.routePill({ live: { kind: "answering" }, hasView: true }).text).toBe("Connected");
  });

  it("hides every section a Mac does not have a field for", () => {
    const none = L.sectionsFor({ mac: "Studio" }, vm);
    expect(none).toMatchObject({
      mac: true,
      awake: false,
      notifications: false,
      hotspot: false,
      voice: false,
      macControls: false,
      telegramAvatar: false,
    });
    const all = L.sectionsFor(
      {
        mac: "Studio",
        keepAwake: false,
        awakeOpenActions: {},
        awakeLidActions: {},
        notify: { telegram: {} },
        hotspot: { configured: false },
        voice: { mode: "direct" },
        macControls: {},
        telegramAvatar: true,
      },
      vm,
    );
    expect(Object.values(all).every(Boolean)).toBe(true);
    expect(L.sectionsFor(null, vm).mac).toBe(false);
  });
});

describe("phone-call words and rules", () => {
  it("words the pause line from the Mac's end time", () => {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
    expect(L.pauseLine(null, now)).toBe("Calls are on");
    expect(L.pauseLine({ until: now - 1 }, now)).toBe("Calls are on");
    expect(L.pauseLine({ until: null }, now)).toBe("Paused until you turn it back on");
    expect(L.pauseLine({ until: now + 3_600_000 }, now)).toMatch(/^Paused until .*1.*:00/);
    expect(L.isPaused({ until: now + 5 }, now)).toBe(true);
    expect(L.PAUSE_OPTIONS.map((o) => o.title)).toEqual([
      "For 1 hour",
      "For 4 hours",
      "Until tomorrow morning",
      "Until I turn it back on",
    ]);
    expect(L.RESUME_OPTION).toEqual({ value: "resume", title: "Resume calls" });
  });

  it("says each PIN state as the iPhone does, and only loosening needs a confirmation", () => {
    expect(L.pinStatus("set").title).toBe("Calling PIN is set");
    expect(L.pinStatus("off").title).toBe("PIN protection is off");
    expect(L.pinStatus("none").title).toBe("No PIN set");
    expect(L.pinStatus("unknown").title).toBe("Checking PIN status");
    expect(L.pinDone("resetOff")).toBe("The PIN is off.");
    const ask = { outgoing: "ask", incoming: "ask" };
    expect(L.loosens(ask, "skip", "ask")).toBe(true);
    expect(L.loosens(ask, "ask", "skip")).toBe(true);
    expect(L.loosens({ outgoing: "skip", incoming: "ask" }, "skip", "ask")).toBe(false);
    expect(L.loosens({ outgoing: "skip", incoming: "skip" }, "ask", "skip")).toBe(false);
  });

  it("keeps quick workspaces to nine unique digits and sends only { n, workspace }", () => {
    const list = [
      { n: 1, workspace: "a", label: "A" },
      { n: 3, workspace: "b", label: "B" },
    ];
    const cands = [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "c", label: "C" },
    ];
    expect(L.favoritesAdded(list, cands)).toEqual(
      [...list, { n: 2, workspace: "c", label: "C" }].sort((x, y) => x.n - y.n),
    );
    expect(L.favoritesAdded(list, cands.slice(0, 2))).toBeNull();
    expect(L.availableDigits(list, 1)).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
    expect(L.favoritesRenumbered(list, 1, 3)).toBeNull();
    expect(L.favoritesRenumbered(list, 1, 2).map((f) => f.n)).toEqual([2, 3]);
    expect(L.favoritesRemoved(list, 1)).toEqual([list[1]]);
    expect(L.favoritesInput(list)).toEqual([
      { n: 1, workspace: "a" },
      { n: 3, workspace: "b" },
    ]);
    expect(() => shape("voice", { change: { favorites: L.favoritesInput(list) } })).not.toThrow();
  });

  it("words a call and its timeline, and Copy gets the plain text", () => {
    const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
    const at = new Date(2026, 9, 30, 14, 2, 7, 123).getTime();
    const call = {
      id: "a",
      at,
      kind: "agent",
      reason: "blocked_question",
      label: "squeak · main",
      outcome: "answered",
      letter: "B",
      sent: true,
      durationMs: 72_000,
      failure: null,
      events: [{ at, source: "add-on", kind: "said", text: "Which one?" }],
    };
    expect(L.callWhen(at, now)).toBe("Today 14:02");
    expect(L.callWhat(call)).toBe("squeak · main");
    expect(L.callWhat({ ...call, label: null })).toBe("A question was waiting");
    expect(L.callWhat({ ...call, kind: "test" })).toBe("Test call");
    expect(L.callOutcome(call)).toBe("Answered, pressed B · sent");
    expect(L.callOutcome({ ...call, outcome: "failed", failure: "no route" })).toBe("Could not be placed: no route");
    expect(L.callOutcome({ ...call, outcome: "unanswered" })).toBe("Not answered");
    expect(L.callDuration(72_000)).toBe("1 min 12 s");
    expect(L.callDuration(180_000)).toBe("3 min");
    expect(L.callDuration(400)).toBe("0 s");
    expect(L.eventTime(at)).toBe("14:02:07.123");
    expect(L.timelineExport(call)).toBe(
      "Outgoing · squeak · main · 1 min 12 s · Answered, pressed B · sent\n14:02:07.123 [Add-on] Squeak said: \u201CWhich one?\u201D",
    );
    expect(L.callSummary({ ...call, kind: "incoming", label: null })).toBe(
      "Incoming · 1 min 12 s · Message taken · sent to the chat",
    );
  });
});

/* ---------- the sections drawn, against a tiny fake DOM ---------- */

function fakeNode(tag) {
  return {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    style: { setProperty() {} },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    append(...kids) {
      this.children.push(...kids);
    },
  };
}
const text = (node) => (typeof node === "string" ? node : (node.children ?? []).map(text).join(" "));
const find = (node, pred, out = []) => {
  if (typeof node === "object" && node) {
    if (pred(node)) out.push(node);
    for (const c of node.children ?? []) find(c, pred, out);
  }
  return out;
};

describe("the sections as drawn", () => {
  let parts;
  let controlsView;
  beforeAll(async () => {
    globalThis.document = {
      createElement: fakeNode,
      createTextNode: (t) => String(t),
      getElementById: () => null,
    };
    parts = await import("../js/settings-mac-parts.js");
    controlsView = await import("../js/mac-controls-view.js");
  });
  afterEach(() => {
    parts.S.problems = {};
    parts.S.tap = null;
  });

  const ctxFor = (view, commands = {}) => ({
    view,
    commands,
    sync: { state: { aliveAt: Date.now(), streamUp: true }, wake() {} },
    navigate() {},
    touch() {},
  });

  it("draws nothing for a Mac that lacks the fields, and never throws", () => {
    const ctx = ctxFor({ mac: "Studio" });
    expect(parts.awakeSection(ctx)).toBeNull();
    expect(parts.notificationsSection(ctx)).toBeNull();
    expect(parts.hotspotSection(ctx)).toBeNull();
    expect(parts.voiceSection(ctx)).toBeNull();
    expect(parts.macSection(ctx)).not.toBeNull();
    expect(parts.macSection(ctxFor(null))).toBeNull();
  });

  it("draws Keep awake with the mode tabs only when the Mac sends its lid-open switches", () => {
    const base = { mac: "Studio", keepAwake: false, awakeLidActions: {}, awakeLidReady: true };
    const without = parts.awakeSection(ctxFor(base));
    expect(without.some((n) => find(n, (x) => x.tag === "button" && text(x) === "Lid closed").length > 0)).toBe(false);
    const withModes = parts.awakeSection(ctxFor({ ...base, awakeOpenActions: {} }));
    expect(withModes.some((n) => find(n, (x) => x.tag === "button" && text(x) === "Lid closed").length > 0)).toBe(true);
  });

  it("sends one-key control changes and one awake start through the commands", async () => {
    const sent = [];
    const commands = {
      awake: async (i) => (sent.push(["awake", i]), { ok: true }),
      controls: async (i) => (sent.push(["controls", i]), { ok: true }),
    };
    const view = {
      mac: "Studio",
      keepAwake: false,
      awakeLidReady: false,
      macControls: {
        volume: 20,
        muted: false,
        brightness: null,
        screenAwake: null,
        apps: [],
        media: { playing: false },
      },
    };
    const nodes = parts.awakeSection(ctxFor(view, commands));
    const button = nodes.flatMap((n) => find(n, (x) => x.tag === "button" && text(x) === "Keep Mac awake"))[0];
    button.listeners.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([["awake", { on: true, minutes: 120 }]]);

    const page = controlsView.render(ctxFor(view, commands))[0];
    const mute = find(page, (x) => x.tag === "button" && text(x) === "Mute")[0];
    mute.listeners.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[1]).toEqual(["controls", { change: { muted: true } }]);
    expect(Object.keys(sent[1][1].change)).toHaveLength(1);
  });

  it("puts a refused flip back and shows the Mac's reason", async () => {
    const commands = { notify: async () => ({ ok: false, reason: "Telegram isn't set up." }) };
    const view = {
      mac: "S",
      notify: {
        telegram: {
          muted: false,
          approval: true,
          question: true,
          stalled: true,
          quota: true,
          finished: "conductor",
          quiet: null,
        },
      },
    };
    const nodes = parts.notificationsSection(ctxFor(view, commands));
    const box = nodes.flatMap((n) =>
      find(n, (x) => x.tag === "input" && x.attrs["data-sm"] === "telegram-approval"),
    )[0];
    box.listeners.change({ target: { checked: false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(parts.S.overlays.read("telegram.approval", true)).toBe(true);
    expect(parts.S.problems.notify).toBe("Telegram isn't set up.");
  });

  describe("Phone calls", () => {
    const base = {
      mac: "S",
      voice: {
        mode: "gateway",
        callee: "101",
        pin: "set",
        policy: { outgoing: "ask", incoming: "ask" },
        pause: null,
        natural: { installed: true, enabled: true, voice: "af_heart", voices: [{ id: "af_heart", label: "Heart" }] },
        favorites: [{ n: 1, workspace: "w", label: "squeak" }],
        workspaces: [{ key: "w", label: "squeak" }],
      },
    };
    const buttons = (nodes, label) => nodes.flatMap((n) => find(n, (x) => x.tag === "button" && text(x) === label));
    const wait = () => new Promise((r) => setTimeout(r, 0));
    const reset = () => {
      Object.assign(parts.S.voice, {
        pinOpen: null,
        pinVerified: false,
        confirmPinOff: false,
        confirmForgot: false,
        policyAsk: null,
        callsOpen: false,
      });
      Object.assign(parts.S.voice.pins, { current: "", next: "", again: "" });
    };
    afterEach(reset);

    it("hides what an older Mac does not send", () => {
      const nodes = parts.voiceSection(ctxFor({ mac: "S", voice: { mode: "direct", callee: "101" } }));
      const all = nodes.map(text).join(" ");
      expect(all).not.toContain("Pause calls");
      expect(all).not.toContain("Quick workspaces");
      expect(all).not.toContain("Call history");
      expect(all).not.toContain("Calling PIN");
      expect(all).not.toContain("Speak with this Mac");
    });

    it("sends a pause choice as { pause } and offers Resume only while paused", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const nodes = parts.voiceSection(ctxFor(base, commands));
      const menu = nodes.flatMap((n) =>
        find(n, (x) => x.tag === "select" && x.attrs["aria-label"] === "Pause calls options"),
      )[0];
      expect(text(menu)).not.toContain("Resume calls");
      menu.listeners.change({ target: { value: "4h" } });
      await wait();
      expect(sent).toEqual([{ change: { pause: "4h" } }]);
      const paused = parts.voiceSection(
        ctxFor({ ...base, voice: { ...base.voice, pause: { until: null } } }, commands),
      );
      expect(paused.map(text).join(" ")).toContain("Paused until you turn it back on");
      expect(paused.map(text).join(" ")).toContain("Resume calls");
    });

    it("turns the PIN off only after a confirmation, then sends the reset with a null next", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const draw = () => parts.voiceSection(ctxFor(base, commands));
      buttons(draw(), "Turn PIN off")[0].listeners.click();
      expect(sent).toEqual([]);
      const confirm = draw();
      expect(confirm.map(text).join(" ")).toContain("Turn the PIN off?");
      expect(confirm.map(text).join(" ")).toContain("can't check it's you");
      buttons(confirm, "Turn PIN off")[0].listeners.click();
      await wait();
      expect(sent).toEqual([{ change: { pinAction: { action: "reset", next: null } } }]);
      expect(parts.S.voice.pinNote).toBe("The PIN is off.");
    });

    it("changes the PIN with the current one, keeps it off the page and clears it after", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const draw = () => parts.voiceSection(ctxFor(base, commands));
      buttons(draw(), "Change PIN")[0].listeners.click();
      Object.assign(parts.S.voice.pins, { current: "1234", next: "567890", again: "567890" });
      const go = buttons(draw(), "Save new PIN")[0];
      expect(go.attrs.disabled).toBeUndefined();
      go.listeners.click();
      await wait();
      expect(sent).toEqual([{ change: { pinAction: { action: "change", current: "1234", next: "567890" } } }]);
      expect(parts.S.voice.pins).toEqual({ current: "", next: "", again: "" });
      expect(draw().map(text).join(" ")).not.toContain("567890");
    });

    it("refuses a PIN that is too short or does not repeat", () => {
      const draw = () => parts.voiceSection(ctxFor(base, {}));
      buttons(draw(), "Change PIN")[0].listeners.click();
      Object.assign(parts.S.voice.pins, { current: "1234", next: "5678", again: "5679" });
      expect(buttons(draw(), "Save new PIN")[0].attrs.disabled).toBe("");
      Object.assign(parts.S.voice.pins, { current: "1234", next: "12", again: "12" });
      expect(buttons(draw(), "Save new PIN")[0].attrs.disabled).toBe("");
    });

    it("Forgot your PIN? asks to confirm it is you before any new PIN is chosen", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const draw = () => parts.voiceSection(ctxFor(base, commands));
      buttons(draw(), "Forgot your PIN?")[0].listeners.click();
      expect(draw().map(text).join(" ")).toContain("Reset your calling PIN?");
      expect(draw().map(text).join(" ")).not.toContain("Reset calling PIN");
      buttons(draw(), "Yes, it's me")[0].listeners.click();
      Object.assign(parts.S.voice.pins, { next: "135790", again: "135790" });
      buttons(draw(), "Save new PIN")[0].listeners.click();
      await wait();
      expect(sent).toEqual([{ change: { pinAction: { action: "reset", next: "135790" } } }]);
    });

    it("sets or turns on a PIN when none is set or it is off", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      for (const [pin, title] of [
        ["none", "Set a PIN"],
        ["off", "Turn PIN on"],
      ]) {
        reset();
        const draw = () => parts.voiceSection(ctxFor({ ...base, voice: { ...base.voice, pin } }, commands));
        Object.assign(parts.S.voice.pins, { next: "135790", again: "135790" });
        buttons(draw(), title)[0].listeners.click();
        await wait();
      }
      expect(sent).toEqual([
        { change: { pinAction: { action: "enable", next: "135790" } } },
        { change: { pinAction: { action: "enable", next: "135790" } } },
      ]);
    });

    it("loosening the PIN policy waits for a confirmation; tightening it does not", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const draw = (policy) => parts.voiceSection(ctxFor({ ...base, voice: { ...base.voice, policy } }, commands));
      const selects = (nodes) =>
        nodes
          .flatMap((n) => find(n, (x) => x.tag === "label" && text(x).includes("Calls Squeak makes to you")))
          .flatMap((l) => find(l, (x) => x.tag === "select"));
      selects(draw({ outgoing: "ask", incoming: "ask" }))[0].listeners.change({ target: { value: "skip" } });
      await wait();
      expect(sent).toEqual([]);
      expect(draw({ outgoing: "ask", incoming: "ask" }).map(text).join(" ")).toContain("Stop asking for the PIN?");
      buttons(draw({ outgoing: "ask", incoming: "ask" }), "Yes, stop asking")[0].listeners.click();
      await wait();
      expect(sent).toEqual([{ change: { pinAction: { action: "policy", outgoing: "skip", incoming: "ask" } } }]);
      selects(draw({ outgoing: "skip", incoming: "ask" }))[0].listeners.change({ target: { value: "ask" } });
      await wait();
      expect(sent[1]).toEqual({ change: { pinAction: { action: "policy", outgoing: "ask", incoming: "ask" } } });
    });

    it("sends the voice toggle and the whole quick-workspace list, one key each", async () => {
      const sent = [];
      const commands = { voice: async (i) => (sent.push(i), { ok: true }) };
      const nodes = parts.voiceSection(ctxFor(base, commands));
      const toggleBox = nodes.flatMap((n) => find(n, (x) => x.attrs?.["data-sm"] === "voice-natural"))[0];
      toggleBox.listeners.change({ target: { checked: false } });
      await wait();
      expect(sent[0]).toEqual({ change: { natural: { enabled: false } } });
      buttons(nodes, "Remove")[0].listeners.click();
      await wait();
      expect(sent[1]).toEqual({ change: { favorites: [] } });
      for (const input of sent) expect(() => shape("voice", input)).not.toThrow();
    });

    it("offers Play sample only when the Mac says it can send one", async () => {
      const withSample = (sample) => ({
        ...base,
        voice: { ...base.voice, natural: { ...base.voice.natural, ...(sample ? { sample: true } : {}) } },
      });
      expect(parts.voiceSection(ctxFor(base, {})).map(text).join(" ")).not.toContain("Play sample");
      const nodes = parts.voiceSection(ctxFor(withSample(true), {}));
      expect(nodes.map(text).join(" ")).toContain("Play sample");
      const button = nodes.flatMap((n) => find(n, (x) => x.attrs?.["data-sm"] === "voice-sample"))[0];
      expect(button.attrs["aria-label"]).toBe("Play sample of selected voice");
      // A Mac that left the realistic voice off shows no sample either.
      const off = withSample(true);
      off.voice.natural = { ...off.voice.natural, enabled: false };
      expect(parts.voiceSection(ctxFor(off, {})).map(text).join(" ")).not.toContain("Play sample");
    });

    it("hides the voice and the quick workspaces from a Mac without natural.voices", () => {
      const old = { ...base, voice: { ...base.voice, natural: { installed: true, enabled: true, voice: "af_heart" } } };
      const all = parts.voiceSection(ctxFor(old, {})).map(text).join(" ");
      expect(all).not.toContain("Quick workspaces");
      expect(all).not.toContain("Speak with this Mac");
      expect(all).not.toContain("Call history");
    });

    it("opening the call log asks for the calls cap, and shows the calls when they arrive", () => {
      const wanted = [];
      const ctx = (calls) => ({
        ...ctxFor({ ...base, voice: { ...base.voice, ...(calls ? { calls } : {}) } }, {}),
        sync: { state: { aliveAt: Date.now() }, wake() {}, wantCalls: (on) => wanted.push(on) },
      });
      const det = parts
        .voiceSection(ctx())
        .flatMap((n) => find(n, (x) => x.tag === "details" && text(x).includes("Call history")))[0];
      det.listeners.toggle({ target: { open: true } });
      expect(wanted).toEqual([true]);
      expect(parts.voiceSection(ctx()).map(text).join(" ")).toContain("Loading the calls");
      const calls = [
        {
          id: "a",
          at: Date.now(),
          kind: "agent",
          reason: null,
          label: "squeak · main",
          outcome: "answered",
          letter: "A",
          sent: true,
          durationMs: 4000,
          failure: null,
          events: [{ at: Date.now(), source: "mac", kind: "step", text: "Calling 101" }],
        },
      ];
      const drawn = parts.voiceSection(ctx(calls)).map(text).join(" ");
      expect(drawn).toContain("squeak · main");
      expect(drawn).toContain("Calling 101");
      expect(drawn).toContain("Copy");
      expect(parts.voiceSection(ctx([])).map(text).join(" ")).toContain("No calls yet");
      det.listeners.toggle({ target: { open: false } });
      expect(wanted.at(-1)).toBe(false);
    });
  });
});
