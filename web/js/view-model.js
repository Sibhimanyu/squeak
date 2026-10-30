// Typed, defensive readers for the fields of the Mac's phone view the page did
// not read before (shapes: ios/SqueakCore Models.swift, Films.swift). Each takes
// the view (or a session) and returns a clean value, or null when the field is
// missing, from an older Mac, or garbage. None throws, and what they return is
// only strings, finite numbers, booleans and arrays/objects of those, so a screen
// may draw it with `h` without checking again. A null means "this Mac doesn't
// say": a screen hides its control then, as the iPhone does.

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const field = (view, name) => (isObject(view) ? view[name] : undefined);
/** A list field: null when it is absent or not a list; entries that fail `read` are dropped. */
const list = (value, read) => (Array.isArray(value) ? value.map(read).filter((x) => x !== null) : null);
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

/** Models a new chat can start with (`chatModels`); null: this Mac offers no choice. */
export function chatModels(view) {
  return list(field(view, "chatModels"), (m) =>
    isObject(m) && nonEmpty(m.id) && nonEmpty(m.agent) && str(m.label) !== null
      ? {
          id: m.id,
          agent: m.agent,
          label: m.label,
          levels: strings(m.levels),
          defaultLevel: nonEmpty(m.defaultLevel),
          favorite: m.favorite === true,
        }
      : null,
  );
}

/** Models a Claude chat can hand work to (`chatWorkers`); null hides "Split the work". */
export function chatWorkers(view) {
  return list(field(view, "chatWorkers"), (w) =>
    isObject(w) && nonEmpty(w.id) && str(w.label) !== null ? { id: w.id, label: w.label } : null,
  );
}

/** Repositories a workspace can be made in (`repos`); its presence says the Mac archives and makes workspaces. */
export function repos(view) {
  return list(field(view, "repos"), (r) =>
    isObject(r) && nonEmpty(r.id) && str(r.name) !== null ? { id: r.id, name: r.name } : null,
  );
}

/** Workspaces a new chat can start in (`workspaces`); null: this Mac cannot start chats. */
export function workspaces(view) {
  return list(field(view, "workspaces"), (w) =>
    isObject(w) && nonEmpty(w.id) && str(w.label) !== null
      ? { id: w.id, label: w.label, defaultAgent: w.defaultAgent === "codex" ? "codex" : "claude" }
      : null,
  );
}

function usageWindow(w) {
  if (!isObject(w) || num(w.usedPercent) === null) return null;
  return { usedPercent: w.usedPercent, resetsAt: str(w.resetsAt) };
}

/** Plan limits (`usage`): `{ claude: { fiveHour, sevenDay, observedAt } | null, codex: { fiveHour, weekly, observedAt } | null }`; null without any. */
export function usage(view) {
  const raw = field(view, "usage");
  if (!isObject(raw)) return null;
  const claude = isObject(raw.claude)
    ? {
        fiveHour: usageWindow(raw.claude.fiveHour),
        sevenDay: usageWindow(raw.claude.sevenDay),
        observedAt: str(raw.claude.observedAt),
      }
    : null;
  const codex = isObject(raw.codex)
    ? {
        fiveHour: usageWindow(raw.codex.fiveHour),
        weekly: usageWindow(raw.codex.weekly),
        observedAt: str(raw.codex.observedAt),
      }
    : null;
  return claude || codex ? { claude, codex } : null;
}

/** Whether this Mac answers `stats` (Usage details): true, or null (older Mac). */
export function usageStats(view) {
  return field(view, "usageStats") === true ? true : null;
}

/** The result of a `stats` command (`result.stats`), checked; null if it is not one. */
export function statsResult(result) {
  const s = isObject(result) ? result.stats : null;
  if (!isObject(s) || !isObject(s.totals) || int(s.totals.tokens) === null) return null;
  const rows = (value, read) => (Array.isArray(value) ? value.map(read).filter((x) => x !== null) : []);
  return {
    range: str(s.range),
    agent: nonEmpty(s.agent),
    since: nonEmpty(s.since),
    keepDays: int(s.keepDays),
    keptFrom: nonEmpty(s.keptFrom),
    computedAt: str(s.computedAt),
    pending: int(s.pending) ?? 0,
    totals: {
      tokens: s.totals.tokens,
      input: int(s.totals.input) ?? 0,
      output: int(s.totals.output) ?? 0,
      cacheRead: int(s.totals.cacheRead) ?? 0,
      cacheWrite: int(s.totals.cacheWrite) ?? 0,
      messages: int(s.totals.messages) ?? 0,
      sessions: int(s.totals.sessions) ?? 0,
      costUsd: num(s.totals.costUsd),
    },
    activeDays: int(s.activeDays) ?? 0,
    currentStreak: int(s.currentStreak) ?? 0,
    longestStreak: int(s.longestStreak) ?? 0,
    favoriteModel: nonEmpty(s.favoriteModel),
    peakHour: int(s.peakHour),
    longestSession:
      isObject(s.longestSession) && int(s.longestSession.minutes) !== null
        ? { minutes: s.longestSession.minutes, project: nonEmpty(s.longestSession.project) }
        : null,
    models: rows(s.models, (m) =>
      isObject(m) && nonEmpty(m.model) && int(m.tokens) !== null
        ? { model: m.model, agent: str(m.agent), tokens: m.tokens, share: num(m.share) ?? 0, costUsd: num(m.costUsd) }
        : null,
    ),
    daily: rows(s.daily, (d) =>
      isObject(d) && nonEmpty(d.date) && int(d.tokens) !== null ? { date: d.date, tokens: d.tokens } : null,
    ),
    projects: rows(s.projects, (p) =>
      isObject(p) && nonEmpty(p.name) && int(p.tokens) !== null ? { name: p.name, tokens: p.tokens } : null,
    ),
  };
}

/** The Mac controls page (`macControls`); null hides it. Every member is null when the Mac does not say. */
export function macControls(view) {
  const c = field(view, "macControls");
  if (!isObject(c)) return null;
  const fans = isObject(c.fans)
    ? {
        mode: nonEmpty(c.fans.mode),
        choice: nonEmpty(c.fans.choice),
        available: c.fans.available === true,
        rpm: (Array.isArray(c.fans.rpm) ? c.fans.rpm : []).filter((n) => num(n) !== null),
      }
    : null;
  const power = isObject(c.power)
    ? {
        mode: nonEmpty(c.power.mode),
        choice: nonEmpty(c.power.choice),
        available: strings(c.power.available),
        ready: c.power.ready === true,
        overridden: c.power.overridden === true,
      }
    : null;
  return {
    volume: int(c.volume),
    muted: bool(c.muted),
    brightness: int(c.brightness),
    fans,
    power,
    screenAwake: bool(c.screenAwake),
    apps: list(c.apps, (a) =>
      isObject(a) && nonEmpty(a.id) && str(a.name) !== null
        ? { id: a.id, name: a.name, active: a.active === true }
        : null,
    ),
    media: isObject(c.media) ? { playing: c.media.playing === true } : null,
  };
}

const CHANNELS = ["telegram", "cliq"];
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function channelSettings(raw) {
  if (!isObject(raw)) return null;
  const quiet =
    isObject(raw.quiet) &&
    typeof raw.quiet.from === "string" &&
    typeof raw.quiet.to === "string" &&
    CLOCK.test(raw.quiet.from) &&
    CLOCK.test(raw.quiet.to)
      ? { from: raw.quiet.from, to: raw.quiet.to }
      : null;
  return {
    muted: raw.muted === true,
    approval: raw.approval !== false,
    question: raw.question !== false,
    stalled: raw.stalled !== false,
    quota: raw.quota !== false,
    finished: ["conductor", "all", "off"].includes(raw.finished) ? raw.finished : "conductor",
    quiet,
  };
}

/** What Telegram and Cliq may push (`notify`): `{ telegram, cliq, configured: { telegram, cliq } }`; null hides the page. */
export function notify(view) {
  const n = field(view, "notify");
  if (!isObject(n)) return null;
  const configured = isObject(n.channels) ? n.channels : {};
  return {
    ...Object.fromEntries(CHANNELS.map((name) => [name, channelSettings(n[name])])),
    // As on the iPhone: a channel the Mac does not say is set up reads as set up.
    configured: Object.fromEntries(CHANNELS.map((name) => [name, configured[name] !== false])),
  };
}

/** Hotspot failover (`hotspot`); null hides it. */
export function hotspot(view) {
  const h = field(view, "hotspot");
  if (!isObject(h)) return null;
  const last = isObject(h.last)
    ? clean({
        at: str(h.last.at),
        to: h.last.to === "wifi" ? "wifi" : "hotspot",
        ok: h.last.ok === true,
        note: str(h.last.note),
        automatic: h.last.automatic === true,
      })
    : null;
  return {
    configured: h.configured === true,
    ssid: nonEmpty(h.ssid),
    enabled: h.enabled === true,
    onHotspot: h.onHotspot === true,
    last,
  };
}

/** Temperatures and fans during an awake session (`macHeat`); null outside one. */
export function macHeat(view) {
  const m = field(view, "macHeat");
  if (!isObject(m) || !["ok", "warm", "hot"].includes(m.level)) return null;
  return {
    level: m.level,
    chip: int(m.chip),
    battery: int(m.battery),
    fansRpm: Array.isArray(m.fansRpm) ? m.fansRpm.filter((n) => num(n) !== null) : null,
    fansMax: bool(m.fansMax),
    fanControl: bool(m.fanControl),
  };
}

const CALL_KINDS = ["agent", "test", "incoming"];
const CALL_OUTCOMES = ["answered", "unanswered", "failed", "moved_on"];
const EVENT_KINDS = ["step", "said", "heard", "key", "warn"];

function callEvent(e) {
  if (!isObject(e) || typeof e.text !== "string") return null;
  return {
    at: num(e.at) ?? 0,
    source: e.source === "add-on" ? "add-on" : "mac",
    kind: EVENT_KINDS.includes(e.kind) ? e.kind : "step",
    text: e.text,
  };
}

/** One call of `voice.calls`; an unknown word reads as the safest: an agent call nobody answered (the Mac app's rule). */
function callEntry(c) {
  if (!isObject(c)) return null;
  const at = num(c.at) ?? 0;
  return {
    id: nonEmpty(c.id) ?? `call-${Math.trunc(at)}`,
    at,
    kind: CALL_KINDS.includes(c.kind) ? c.kind : "agent",
    reason: nonEmpty(c.reason),
    label: nonEmpty(c.label),
    outcome: CALL_OUTCOMES.includes(c.outcome) ? c.outcome : "unanswered",
    letter: nonEmpty(c.letter),
    sent: bool(c.sent),
    durationMs: num(c.durationMs) ?? 0,
    failure: nonEmpty(c.failure),
    events: list(c.events, callEvent) ?? [],
  };
}

/**
 * Phone calls (`voice`); null hides the page. Every field after `lastTest` is optional (an older Mac omits it):
 * `pin` ("set", "off", "none", "unknown"), `policy`, `pause` (`pauseKnown` says the key was sent at all; `pause`
 * is then null = calls are on, or `{ until }`, until null = until turned back on), `natural` (`voices` is how a
 * Mac says it can change it from a phone), `favorites`, `workspaces` and `calls` (only for a browser whose caps say "calls").
 */
export function voice(view) {
  const v = field(view, "voice");
  if (!isObject(v) || !nonEmpty(v.mode)) return null;
  const t = v.lastTest;
  const p = v.policy;
  const n = v.natural;
  const choice = (x) => (x === "skip" ? "skip" : "ask");
  const voices = isObject(n)
    ? list(n.voices, (x) =>
        isObject(x) && nonEmpty(x.id) && str(x.label) !== null ? { id: x.id, label: x.label } : null,
      )
    : null;
  return {
    mode: v.mode,
    isOn: v.mode !== "off",
    callee: nonEmpty(v.callee),
    defaultCallee: nonEmpty(v.defaultCallee),
    lastTest:
      isObject(t) && num(t.at) !== null && nonEmpty(t.status)
        ? { at: t.at, status: t.status, letter: nonEmpty(t.letter), reason: nonEmpty(t.reason) }
        : null,
    pin: nonEmpty(v.pin),
    policy: isObject(p) ? { outgoing: choice(p.outgoing), incoming: choice(p.incoming) } : null,
    pauseKnown: isObject(v) && "pause" in v,
    pause: isObject(v.pause) ? { until: num(v.pause.until) } : null,
    natural: isObject(n)
      ? {
          installed: n.installed === true,
          enabled: n.enabled === true,
          voice: nonEmpty(n.voice),
          voices: voices && voices.length > 0 ? voices : null,
          // Whether this Mac can make a voice sample and leave it in the channel; absent from an older Mac.
          sample: n.sample === true,
        }
      : null,
    favorites: list(v.favorites, (f) =>
      isObject(f) && int(f.n) !== null && f.n >= 1 && f.n <= 9 && nonEmpty(f.workspace)
        ? { n: f.n, workspace: f.workspace, label: nonEmpty(f.label) ?? f.workspace }
        : null,
    ),
    workspaces: list(v.workspaces, (w) =>
      isObject(w) && nonEmpty(w.key) ? { key: w.key, label: nonEmpty(w.label) ?? w.key } : null,
    ),
    calls: list(v.calls, callEntry),
  };
}

/** Whether this Mac can set the Telegram bot's photo: true, or null (older Mac). */
export function telegramAvatar(view) {
  return field(view, "telegramAvatar") === true ? true : null;
}

function switches(raw, keys, fallback) {
  if (!isObject(raw)) return null;
  return Object.fromEntries(keys.map((key) => [key, typeof raw[key] === "boolean" ? raw[key] : fallback[key]]));
}

/** What a closed lid does in a lid-closed session (`awakeLidActions`); null hides the group. */
export function awakeLidActions(view) {
  return switches(field(view, "awakeLidActions"), ["displayOff", "mute", "lowPower", "freezeApps"], {
    displayOff: true,
    mute: true,
    lowPower: true,
    freezeApps: false,
  });
}

/** What a session does with the lid open (`awakeOpenActions`); its presence is how the Lid open / Lid closed tabs show. */
export function awakeOpenActions(view) {
  return switches(field(view, "awakeOpenActions"), ["screenOn", "mute", "lowPower", "freezeApps"], {
    screenOn: false,
    mute: false,
    lowPower: false,
    freezeApps: false,
  });
}

/** The safety floors (`awakeRules`); null: say 40 and 10, as the iPhone does for an older Mac. */
export function awakeRules(view) {
  const r = field(view, "awakeRules");
  if (!isObject(r) || int(r.lowPowerPercent) === null || int(r.endPercent) === null) return null;
  return { lowPowerPercent: r.lowPowerPercent, endPercent: r.endPercent, heat: r.heat !== false };
}

/** RasanAI films (`films`, only for a client whose caps say "films"); null when the Mac sends none. */
export function films(view) {
  return list(field(view, "films"), (f) => {
    if (!isObject(f) || !nonEmpty(f.id)) return null;
    const d = isObject(f.director) ? f.director : {};
    const states = ["running", "frozen", "stopped", "crashed", "finished", "none"];
    return {
      id: f.id,
      title: str(f.title) ?? "",
      updatedAt: str(f.updatedAt),
      progress: isObject(f.progress) ? f.progress : null,
      director: {
        state: states.includes(d.state) ? d.state : "none",
        since: nonEmpty(d.since),
        detail: nonEmpty(d.detail),
      },
      // The waiting call keeps the Mac's shape (the same as a chat's workflow card): a film screen reads it.
      card: isObject(f.card) ? f.card : null,
      pending: objects(f.pending)
        .filter((p) => nonEmpty(p.id))
        .map((p) => ({ id: p.id, type: str(p.type) ?? "", said: str(p.said) ?? "", t: str(p.t) ?? "" })),
      chat: objects(f.chat)
        .filter((l) => nonEmpty(l.id))
        .map((l) => ({
          id: l.id,
          who: l.who === "you" ? "you" : "rasan",
          text: str(l.text) ?? "",
          t: str(l.t),
          state: nonEmpty(l.state),
        })),
    };
  });
}

/** How to reach this Mac directly on the same Wi-Fi (`local`); a browser cannot use it, so it is only for display. */
export function local(view) {
  const l = field(view, "local");
  if (!isObject(l) || int(l.port) === null) return null;
  return { port: l.port, hosts: strings(l.hosts), tag: str(l.tag) };
}

/** Why a session is stalled (`stalled`: `{ on: "api" | "model", since }`), or null. */
export function stalled(session) {
  const s = field(session, "stalled");
  if (!isObject(s) || !nonEmpty(s.since)) return null;
  return { on: s.on === "api" ? "api" : "model", since: s.since };
}

/** A working chat's subagents and background shells (`background`), at most 50; null when it has none. */
export function tasks(session) {
  const raw = field(session, "background");
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((t) => isObject(t) && nonEmpty(t.id))
    .slice(0, 50)
    .map((t) => ({
      id: t.id,
      kind: t.kind === "shell" ? "shell" : "agent",
      label: str(t.label) ?? "",
      status: ["running", "done", "failed", "stopped"].includes(t.status) ? t.status : "running",
      background: t.background === true,
      startedAt: nonEmpty(t.startedAt),
      endedAt: nonEmpty(t.endedAt),
      summary: nonEmpty(t.summary),
      agentId: nonEmpty(t.agentId),
      canOpenSteps: t.kind !== "shell" && t.hasSteps === true,
    }));
  return out.length > 0 ? out : null;
}

export { tasks as background };
