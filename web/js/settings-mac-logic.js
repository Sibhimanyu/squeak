// The pure part of the Mac, Keep awake, Notifications, Hotspot and Voice settings (and the Mac controls page):
// words, time math, what the Mac's view says, optimistic taps and the slider's coalescing. No DOM here, so
// node can test it. The iPhone is the reference (SettingsView.swift, MacControlsView.swift, AwakeFormat.swift,
// NotificationsView.swift, VoiceSettingsView.swift); the Mac decides every number and every end, this only words it.

import { awakeFrom, ended, left } from "./mac-strip.js";

export { ended, left };

/* ---------- Keep awake ---------- */

export const DURATIONS = Object.freeze([
  { id: "1h", label: "1 hour", minutes: 60 },
  { id: "2h", label: "2 hours", minutes: 120 },
  { id: "4h", label: "4 hours", minutes: 240 },
  { id: "8h", label: "8 hours", minutes: 480 },
]);
export const DEFAULT_MINUTES = 120;

/** What older Macs enforce and say nothing about (AwakeFormat.defaultRules). */
export const DEFAULT_RULES = Object.freeze({ lowPowerPercent: 40, endPercent: 10, heat: true });

export const OPEN_ACTION_INFOS = Object.freeze([
  {
    key: "screenOn",
    title: "Keep the screen on",
    detail: "The display stays on, so the Mac doesn't lock while you're away.",
  },
  {
    key: "mute",
    title: "Mute the sound",
    detail: "Only if it wasn't muted already, and unmuted when the session ends.",
  },
  { key: "lowPower", title: "Use Low Power Mode", detail: "Saves battery for the whole session." },
  {
    key: "freezeApps",
    title: "Pause chat apps",
    detail: "Slack, WhatsApp, Discord and Telegram stop until the session ends.",
  },
]);

export const LID_ACTION_INFOS = Object.freeze([
  { key: "displayOff", title: "Turn off the display", detail: "The screen goes dark when the lid closes." },
  { key: "mute", title: "Mute the sound", detail: "Only if it wasn't muted already, and unmuted when the lid opens." },
  { key: "lowPower", title: "Use Low Power Mode", detail: "Saves battery while the lid is shut." },
  {
    key: "freezeApps",
    title: "Pause chat apps",
    detail: "Slack, WhatsApp, Discord and Telegram stop until the lid opens.",
  },
]);

/** "Low Power Mode comes on at 40% battery or when your Mac runs hot, and the session ends by itself at 10% or when it gets very hot." */
export function safetySentence(rules) {
  const r = rules ?? DEFAULT_RULES;
  const heat = r.heat !== false;
  return (
    `Low Power Mode comes on at ${r.lowPowerPercent}% battery${heat ? " or when your Mac runs hot" : ""}, ` +
    `and the session ends by itself at ${r.endPercent}%${heat ? " or when it gets very hot" : ""}.`
  );
}

/** Minutes until the next time the clock shows "HH:MM" (tomorrow if it has passed today); at least 1. Null for a bad clock. */
export function minutesUntil(clock, now = new Date()) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(typeof clock === "string" ? clock : "");
  if (!match) return null;
  const target = new Date(now);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
}

/** The `awake` command's input for each change (checked again by command-shapes). */
export const awakeInput = {
  start: ({ minutes = null, lid = false } = {}) => ({
    on: true,
    ...(minutes === null ? {} : { minutes }),
    ...(lid ? { lid: true } : {}),
  }),
  extend: (minutes) => ({ on: true, extend: minutes }),
  end: () => ({ on: false }),
};

/** A clock for the running session's end ("3:40 PM"), in the browser's own style. */
export function clockText(ms, locale) {
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** What the Mac says about awake sessions: `offered` only when it sends `keepAwake`. */
export function readAwake(view) {
  const v = view && typeof view === "object" ? view : {};
  const offered = typeof v.keepAwake === "boolean";
  return {
    offered,
    mac: awakeFrom(v) && {
      ...awakeFrom(v),
      lidProblem: typeof v.awakeLidProblem === "string" ? v.awakeLidProblem : null,
    },
    lidReady: v.awakeLidReady === true,
    sleepProblem: typeof v.awakeSleepProblem === "string" && v.awakeSleepProblem !== "" ? v.awakeSleepProblem : null,
    lastEnd: v.awakeLastEnd ?? null,
  };
}

/**
 * The running session as drawn: what this browser just asked for shows only until the Mac's own view has caught
 * up, then the Mac's word is what is shown (AppModel.awake). `tap` is `{ change, status, at }`:
 * change `{ kind: "start", lid }`, `{ kind: "extend" }` or `{ kind: "end" }`; `status` what it should look like.
 */
export function awakeStatus(mac, tap, now = Date.now()) {
  if (!tap) return mac;
  const age = now - tap.at;
  switch (tap.change.kind) {
    case "start":
      if (mac && (!tap.change.lid || mac.lid)) return mac;
      return age < 45_000 ? tap.status : mac;
    case "extend":
      if (mac && mac.until !== null && tap.status?.until != null && mac.until >= tap.status.until - 90_000) return mac;
      return age < 20_000 ? tap.status : mac;
    case "end":
      if (!mac) return null;
      return age < 20_000 ? null : mac;
    default:
      return mac;
  }
}

/** What a tapped change should look like until the Mac agrees. */
export function expectedStatus(change, current, now = Date.now()) {
  switch (change.kind) {
    case "start":
      return {
        until: change.minutes == null ? null : now + change.minutes * 60_000,
        lid: change.lid ? "starting" : null,
        safety: null,
        lidProblem: null,
        pending: true,
      };
    case "extend":
      return current
        ? { ...current, until: current.until === null ? null : Math.max(current.until, now) + change.minutes * 60_000 }
        : null;
    default:
      return null;
  }
}

/** The command input for a change as the awake section sends it. */
export function inputForChange(change) {
  if (change.kind === "start") return awakeInput.start({ minutes: change.minutes ?? null, lid: change.lid === true });
  if (change.kind === "extend") return awakeInput.extend(change.minutes);
  return awakeInput.end();
}

/** The words of the lid row: `[title, detail]` for the Mac's `awakeLid` ("on", "starting", else failed). */
export function lidRowText(lid, problem) {
  if (lid === "on") {
    return ["Lid closed is on", "Safe to close the lid. Keep your Mac on a hard, open surface, never in a bag."];
  }
  if (lid === "starting") return ["Getting ready for a closed lid", "Keep the lid open for a few seconds."];
  return ["Lid closed didn't turn on", `${problem ? `${problem} ` : ""}The session still runs with the lid open.`];
}

/** The footer: what keeping awake does, plus the rules, plus the one-time lid setup when the Mac cannot yet. */
export function awakeFooter(rules, lidReady) {
  const base = "Stops your Mac sleeping, on battery too, so this browser's paired phone and this page can reach it.";
  const safety = safetySentence(rules);
  return lidReady
    ? `${base} ${safety}`
    : `${base} To keep it awake with the lid closed, set that up once in Squeak on your Mac, under Settings, Keep awake. ${safety}`;
}

/* ---------- optimistic taps ---------- */

export const TAP_MS = 20_000;

/**
 * Switches this browser just flipped, shown over what the Mac says until the Mac agrees or `ttl` passes. A refusal
 * puts the switch back (`drop`) and the Mac's reason is shown by the caller.
 */
export class Overlays {
  constructor(ttl = TAP_MS) {
    this.ttl = ttl;
    this.taps = new Map();
  }

  tap(key, value, now = Date.now()) {
    this.taps.set(key, { value, at: now });
  }

  drop(key) {
    this.taps.delete(key);
  }

  /** The value to draw: the tap while it is young and the Mac has not agreed; else what the Mac says. */
  read(key, reported, now = Date.now()) {
    const tap = this.taps.get(key);
    if (!tap) return reported;
    if (now - tap.at >= this.ttl || reported === tap.value) {
      this.taps.delete(key);
      return reported;
    }
    return tap.value;
  }

  /** Whether a flip is still waiting on the Mac. */
  pending(key, reported, now = Date.now()) {
    const tap = this.taps.get(key);
    return Boolean(tap) && now - tap.at < this.ttl && reported !== tap.value;
  }
}

/* ---------- Mac controls ---------- */

/** `{ change: { [key]: value } }`: exactly one key, as the Mac's `readControlChange` requires. */
export function controlInput(key, value) {
  if (typeof key !== "string" || key === "") throw new TypeError("A control change names one control.");
  return { change: { [key]: value } };
}

export const FAN_MODE_TITLES = Object.freeze([
  { mode: "auto", title: "Auto" },
  { mode: "40", title: "40%" },
  { mode: "60", title: "60%" },
  { mode: "80", title: "80%" },
  { mode: "max", title: "Full" },
]);

/** "2,300 rpm" from the fastest fan, "Off" when stopped, null when unread. */
export function fanSpeed(rpm) {
  const list = Array.isArray(rpm) ? rpm.filter((n) => Number.isFinite(n)) : [];
  if (list.length === 0) return null;
  const fastest = Math.max(...list);
  return fastest === 0 ? "Off" : `${fastest.toLocaleString("en-US")} rpm`;
}

export function powerTitle(mode) {
  return mode === "low" ? "Low Power" : mode === "high" ? "High Power" : "Automatic";
}

/** The energy modes to offer, in order, only those this Mac lists. */
export function powerModes(power) {
  return ["auto", "low", "high"].filter((mode) => power?.available?.includes(mode));
}

export function powerNote(power) {
  if (!power.ready) return "Set up on the Mac: Squeak › Settings › Keep awake.";
  if (power.overridden) return "On Low Power while your Mac is warm or its battery is low. Your pick returns after.";
  return null;
}

export function fanNote(fans) {
  if (!fans.available) return "Set up fan control on the Mac first: Squeak › Settings › Keep awake.";
  if (fans.mode === "max" && fans.choice !== "max") {
    return "On full while your Mac is warm. They go back to your pick once it cools.";
  }
  return null;
}

/** Whether the page shows each control, as the Mac's `macControls` allows (null members are hidden). */
export function controlsLayout(controls) {
  if (!controls) return null;
  return {
    volume: controls.volume !== null,
    brightness: controls.brightness !== null,
    mute: controls.muted !== null,
    screenAwake: controls.screenAwake !== null,
    apps: controls.apps ?? [],
    media: controls.media?.playing === true,
    fans: controls.fans ?? null,
    power: controls.power && controls.power.available.length > 0 ? controls.power : null,
  };
}

/**
 * A slider that moves with the finger at once (the value is local), tells the Mac at most every `liveMs` while
 * dragging when a live route exists, once more on release (`commit`), and ignores what the Mac reports until the
 * drag is over and `holdMs` has passed or the Mac has caught up, so a stale reading never snaps it back.
 */
export class SliderSync {
  constructor({ commit, live = null, liveMs = 150, holdMs = 2000 }) {
    this.commit = commit;
    this.live = live;
    this.liveMs = liveMs;
    this.holdMs = holdMs;
    this.local = null;
    this.dragging = false;
    this.releasedAt = 0;
    this.lastLiveAt = -Infinity;
    this.pendingLive = null;
  }

  /** The value to draw. */
  shown(reported, now = Date.now()) {
    if (this.local === null) return reported;
    if (this.dragging) return this.local;
    if (reported === null || Math.abs(reported - this.local) <= 1 || now - this.releasedAt >= this.holdMs) {
      this.local = null;
      return reported;
    }
    return this.local;
  }

  drag(value, now = Date.now()) {
    this.dragging = true;
    this.local = value;
    if (!this.live) return;
    if (now - this.lastLiveAt >= this.liveMs) {
      this.lastLiveAt = now;
      this.pendingLive = null;
      this.live(value);
    } else {
      this.pendingLive = value;
    }
  }

  /** The newest value held back by the cadence, sent once it is due. Returns whether one went. */
  flush(now = Date.now()) {
    if (this.pendingLive === null || !this.live || now - this.lastLiveAt < this.liveMs) return false;
    const value = this.pendingLive;
    this.pendingLive = null;
    this.lastLiveAt = now;
    this.live(value);
    return true;
  }

  release(value, now = Date.now()) {
    this.dragging = false;
    this.local = value;
    this.releasedAt = now;
    this.pendingLive = null;
    this.commit(value);
  }
}

/* ---------- Notifications ---------- */

export const NOTIFY_CHANNEL_LIST = Object.freeze([
  { id: "telegram", title: "Telegram" },
  { id: "cliq", title: "Cliq" },
]);
export const FINISHED_MODE_LIST = Object.freeze([
  { id: "conductor", title: "Conductor chats" },
  { id: "all", title: "All agents" },
  { id: "off", title: "Off" },
]);
export const DEFAULT_QUIET = Object.freeze({ from: "22:00", to: "07:00" });
export const QUIET_FOOTNOTE =
  "Quiet hours hold back finishes, questions asked and stalls. A blocked approval and quota alerts still come through. What's held back is dropped, not sent later.";

/** The channels to show: configured ones whose settings the Mac sent. */
export function shownChannels(notify) {
  if (!notify) return [];
  return NOTIFY_CHANNEL_LIST.filter((c) => notify.configured[c.id] && notify[c.id] !== null);
}

export function clockMinutes(clock) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof clock === "string" ? clock : "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function quietValid(quiet) {
  const a = clockMinutes(quiet?.from);
  const b = clockMinutes(quiet?.to);
  return a !== null && b !== null && a !== b;
}

export function crossesMidnight(quiet) {
  const a = clockMinutes(quiet?.from);
  const b = clockMinutes(quiet?.to);
  return a !== null && b !== null && b < a;
}

/** One `notify` command input; `change` has exactly one key. */
export const notifyInput = (channel, key, value) => ({ channel, change: { [key]: value } });

/** Channel settings with this browser's unconfirmed flips laid over the Mac's; keys are "<channel>.<setting>". */
export function notifyShown(overlays, channelId, settings, now = Date.now()) {
  const out = { ...settings };
  for (const key of ["muted", "approval", "question", "stalled", "quota", "finished"]) {
    out[key] = overlays.read(`${channelId}.${key}`, settings[key], now);
  }
  const quietKey = `${channelId}.quiet`;
  const reportedQuiet = JSON.stringify(settings.quiet);
  const read = overlays.read(quietKey, reportedQuiet, now);
  out.quiet = read === reportedQuiet ? settings.quiet : JSON.parse(read);
  return out;
}

/* ---------- Voice ---------- */

export const isExtension = (text) => /^[0-9]{2,6}$/.test(text);
export const isPin = (text) => /^[0-9]{4,12}$/.test(text);

/** The typed text, trimmed; null when empty (which clears the setting). */
export function normalizedExtension(typed) {
  const t = typeof typed === "string" ? typed.trim() : "";
  return t === "" ? null : t;
}

export function testLine(test) {
  if (!test) return null;
  switch (test.status) {
    case "ringing":
      return "Ringing your phone…";
    case "answered":
      return test.letter
        ? `You answered and pressed ${test.letter}. Nothing was sent anywhere.`
        : "You answered. No key was pressed.";
    case "unanswered":
      return "Nobody picked up.";
    case "failed":
      return `The call failed: ${test.reason ?? "no reason given"}`;
    default:
      return null;
  }
}

export function modeLine(voice) {
  if (voice.mode === "gateway") return "Your Home Assistant add-on places the calls.";
  if (voice.mode === "direct") return "Your Mac places the calls.";
  return "Phone calls are not set up on your Mac.";
}

/** Whether a pin change can be sent: both pins well-formed, repeated the same, and not the old one. */
export function pinReady(current, next, again) {
  return isPin(current) && isPin(next) && next === again && next !== current;
}

/* ---------- Telegram bot picture ---------- */

export const AVATAR_COOLDOWN_MS = 30_000;
export const AVATAR_DONE = "Done. It can take a moment to show in Telegram.";
export const AVATAR_FALLBACK = "Your Mac couldn't set the picture.";

/* ---------- Hotspot ---------- */

/** What the hotspot form may send: the name 1 to 32 bytes, the password 8 to 63 characters. */
export function hotspotFormValid(ssid, password) {
  return ssid.trim() !== "" && new TextEncoder().encode(ssid.trim()).length <= 32 && password.length >= 8;
}

export function hotspotFooter(hotspot) {
  if (hotspot.configured) {
    return (
      "During an awake session or while an agent works, a Mac that loses its internet for half a minute joins this hotspot. " +
      "Turn Personal Hotspot on before you leave: iOS doesn't let apps turn it on."
    );
  }
  return "Your hotspot's name and password are in Settings › Personal Hotspot. The password is kept only in your Mac's Keychain.";
}

/* ---------- The Mac card ---------- */

/** "64% · on battery · 35 W", "100% · plugged in". */
export function batteryText(power) {
  if (!power || !Number.isFinite(power.percent)) return null;
  const parts = [`${power.percent}%`];
  if (typeof power.onBattery === "boolean") parts.push(power.onBattery ? "on battery" : "plugged in");
  if (Number.isFinite(power.watts)) parts.push(`${power.watts} W`);
  return parts.join(" · ");
}

/** "Chip 62°C · battery 33°C · fans 2,300 rpm" (MacHeat.reading), or null. */
export function heatReading(heat) {
  if (!heat) return null;
  const parts = [];
  if (heat.chip !== null && heat.chip !== undefined) parts.push(`Chip ${heat.chip}°C`);
  if (heat.battery !== null && heat.battery !== undefined) parts.push(`battery ${heat.battery}°C`);
  const speed = fanSpeed(heat.fansRpm);
  if (speed) parts.push(speed === "Off" ? "fans off" : `fans ${speed}${heat.fansMax ? ", full" : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The one line under the Mac's name: awake, power, lid, warm. `{ text, warm }` or null. */
export function glance({ awake, power, heat, live, now = Date.now() }) {
  if (live?.kind === "silent") return null;
  const parts = [];
  let warm = false;
  if (awake) parts.push(awake.until == null ? "Awake" : `Awake · ${left(awake.until, now)} left`);
  if (typeof power?.onBattery === "boolean") parts.push(power.onBattery ? "On battery" : "Plugged in");
  if (power?.lidClosed === true) parts.push("Lid closed");
  if (heat?.level === "warm") {
    parts.push("Running warm");
    warm = true;
  } else if (heat?.level === "hot") {
    parts.push("Running hot");
    warm = true;
  }
  return parts.length ? { text: parts.join(" · "), warm } : null;
}

/** The pill by the Mac's name: `{ text, tone }`; tone is a state word, drawn on the dot only. */
export function routePill({ live, hasView, now = Date.now() }) {
  void now;
  if (live?.kind === "silent") return { text: "Mac offline", tone: "offline" };
  if (!hasView) return { text: "Connecting", tone: "idle" };
  if (live?.kind === "unknown") return { text: "Unverified", tone: "idle" };
  return { text: "Connected", tone: "working" };
}

/* ---------- Which sections the view allows ---------- */

/**
 * Which of the settings sections draw for this view, by their own fields; a Mac that lacks the field hides the
 * section, never an error. `reads` are the view-model readers.
 */
export function sectionsFor(view, reads) {
  const awake = readAwake(view);
  return {
    mac: Boolean(view) && typeof view.mac === "string",
    awake: awake.offered,
    modes: awake.offered && reads.awakeOpenActions(view) !== null,
    lidActions: awake.offered && reads.awakeLidActions(view) !== null,
    notifications: reads.notify(view) !== null,
    hotspot: reads.hotspot(view) !== null,
    voice: reads.voice(view) !== null,
    macControls: reads.macControls(view) !== null,
    telegramAvatar: reads.telegramAvatar(view) === true,
  };
}

/** Whether `awakeFrom` agrees the view runs a session (re-exported for the tests). */
export const runningFrom = awakeFrom;
