// The Settings sections for the Mac: the Mac card, Keep awake, Notifications, Hotspot failover and Phone calls.
// Each draws only when the Mac's view has its field (an older Mac hides it, never an error). The page redraws
// whole on every change, so everything a person is in the middle of (a draft, an open disclosure, a flip the Mac
// has not confirmed) lives in `S` below and is laid back over what the Mac says.

import { h } from "./dom.js";
import { liveness } from "./mac-strip.js";
import { heardAgo } from "./presentation.js";
import {
  AVATAR_COOLDOWN_MS,
  AVATAR_DONE,
  AVATAR_FALLBACK,
  DEFAULT_MINUTES,
  DEFAULT_QUIET,
  DURATIONS,
  FINISHED_MODE_LIST,
  LID_ACTION_INFOS,
  OPEN_ACTION_INFOS,
  Overlays,
  QUIET_FOOTNOTE,
  awakeFooter,
  awakeStatus,
  batteryText,
  clockText,
  crossesMidnight,
  ended,
  expectedStatus,
  glance,
  heatReading,
  hotspotFooter,
  hotspotFormValid,
  inputForChange,
  isExtension,
  left,
  lidRowText,
  minutesUntil,
  modeLine,
  normalizedExtension,
  notifyInput,
  notifyShown,
  pinReady,
  quietValid,
  readAwake,
  routePill,
  safetySentence,
  shownChannels,
  testLine,
} from "./settings-mac-logic.js";
import * as view from "./view-model.js";

/** What is in flight or half-typed, kept across redraws. Exported for the Mac controls page and the tests. */
export const S = {
  overlays: new Overlays(),
  problems: {},
  detailsOpen: false,
  moreOpen: false,
  tap: null,
  // On unless turned off, as on the iPhone; this page keeps no storage, so it lasts until it closes.
  withLid: true,
  peak: 60,
  peakUntil: null,
  chosenMinutes: DEFAULT_MINUTES,
  untilClock: "",
  confirmEnd: false,
  hotspot: { editing: false, setupOpen: false, ssid: "", password: "", enabled: true, busy: false },
  voice: {
    typed: null,
    busy: false,
    testing: false,
    pins: { current: "", next: "", again: "" },
    pinBusy: false,
    pinNote: null,
  },
  avatar: { sending: false, lockedUntil: 0, line: null },
};

/* ---------- plumbing ---------- */

/** Sends one command, keeps its problem line, and asks the Mac's view again. Never sends an unconfirmed one twice. */
export async function run(ctx, kind, input, area) {
  S.problems[area] = null;
  let out;
  try {
    out = await ctx.commands[kind](input);
  } catch {
    out = { ok: false, reason: "Couldn't reach your Mac.", unconfirmed: false };
  }
  S.problems[area] = out.ok ? null : out.reason;
  try {
    ctx.sync?.wake?.();
  } catch {
    // The next safety poll reads it.
  }
  ctx.touch();
  return out;
}

const problemLine = (area) =>
  S.problems[area] ? h("p", { class: "note sm-problem", role: "status" }, S.problems[area]) : null;

function liveOf(ctx, now = Date.now()) {
  return liveness({ aliveAt: ctx.sync?.state?.aliveAt, lookingSince: undefined, now });
}

const silentNote = (ctx) =>
  liveOf(ctx).kind === "silent" ? h("p", { class: "note" }, "Your Mac isn't answering. Changes won't reach it.") : null;

function toggle(label, on, onchange, { detail = null, busy = false, disabled = false, id = null } = {}) {
  return h(
    "label",
    { class: "toggle sm-toggle" },
    h("input", {
      type: "checkbox",
      checked: on,
      disabled,
      "data-sm": id,
      onchange: (event) => onchange(event.target.checked),
    }),
    h(
      "span",
      { class: "sm-toggle-text" },
      h("span", null, label, busy ? h("span", { class: "note" }, " …") : null),
      detail ? h("span", { class: "note sm-detail" }, detail) : null,
    ),
  );
}

function segmented(label, options, selected, onpick, disabled = false) {
  return h(
    "div",
    { class: "sm-seg", role: "group", "aria-label": label },
    options.map((option) =>
      h(
        "button",
        {
          class: option.value === selected ? "sm-seg-btn on" : "sm-seg-btn",
          type: "button",
          "aria-pressed": option.value === selected ? "true" : "false",
          disabled,
          onclick: () => onpick(option.value),
        },
        option.title,
      ),
    ),
  );
}

function details(summary, open, ontoggle, ...children) {
  return h(
    "details",
    { class: "sm-details", open, ontoggle: (event) => ontoggle(event.target.open) },
    h("summary", null, summary),
    h("div", { class: "sm-details-body" }, children.flat(Infinity)),
  );
}

/* ---------- Mac card ---------- */

export function macSection(ctx) {
  const v = ctx.view;
  if (!v || typeof v.mac !== "string") return null;
  const now = Date.now();
  const live = liveOf(ctx, now);
  const a = readAwake(v);
  const status = awakeStatus(a.mac, S.tap, now);
  const power = v.macPower ?? null;
  const heat = view.macHeat(v);
  const pill = routePill({ live, hasView: true, now });
  const line = glance({ awake: a.offered ? status : null, power, heat, live, now });
  const controls = view.macControls(v);
  const stale = live.kind === "silent" ? ` · ${heardAgo(live.since, now)}` : "";
  const route =
    live.kind === "silent"
      ? `Not connected · last heard ${heardAgo(live.since, now)}`
      : `Connected${ctx.sync?.state?.streamUp ? " · live" : ""}`;

  const rows = [["Route", route]];
  const battery = batteryText(power);
  if (battery) rows.push(["Battery", battery + stale]);
  if (typeof power?.lidClosed === "boolean") rows.push(["Lid", (power.lidClosed ? "Closed" : "Open") + stale]);
  const reading = heatReading(heat);
  if (reading) rows.push(["Heat", reading + stale]);
  if (typeof v.generatedAt === "string" && Number.isFinite(Date.parse(v.generatedAt))) {
    const ago = heardAgo(Date.parse(v.generatedAt), now);
    rows.push(["Last change", ago === "just now" ? "Just now" : ago]);
  }

  return [
    h(
      "div",
      { class: "sm-card" },
      h(
        "div",
        { class: "sm-card-main" },
        h(
          "div",
          { class: "sm-card-title" },
          h("strong", null, v.mac || "Your Mac"),
          h(
            "span",
            { class: "sm-pill" },
            h("span", { class: `dot d-${pill.tone === "offline" ? "idle" : pill.tone}`, "aria-hidden": "true" }),
            pill.text,
          ),
        ),
        line
          ? h("p", { class: line.warm ? "sm-glance warm" : "sm-glance" }, line.text)
          : live.kind === "silent"
            ? h("p", { class: "sm-glance" }, `Last heard ${heardAgo(live.since, now)}`)
            : h("p", { class: "sm-glance" }, route),
      ),
      controls
        ? h("button", { class: "btn", type: "button", onclick: () => ctx.navigate("mac-controls") }, "Mac controls")
        : null,
    ),
    v.workspaces === undefined || v.workspaces === null
      ? h(
          "p",
          { class: "note" },
          "New chats from this browser need a newer Squeak on your Mac. Update it and the button appears.",
        )
      : null,
    details(
      "Details",
      S.detailsOpen,
      (open) => {
        S.detailsOpen = open;
      },
      h(
        "dl",
        { class: "sm-rows" },
        rows.flatMap(([k, val]) => [h("dt", null, k), h("dd", null, val)]),
      ),
      a.offered ? h("p", { class: "note" }, safetySentence(v.awakeRules && view.awakeRules(v))) : null,
      a.offered && !a.lidReady
        ? h(
            "p",
            { class: "note" },
            "To keep it awake with the lid closed, set that up once in Squeak on your Mac, under Settings, Keep awake.",
          )
        : null,
    ),
  ];
}

/* ---------- Keep awake ---------- */

async function changeAwake(ctx, change) {
  const a = readAwake(ctx.view);
  const now = Date.now();
  const current = awakeStatus(a.mac, S.tap, now);
  S.tap = { change, status: expectedStatus(change, current, now), at: now };
  const refresh = () => ctx.touch();
  globalThis.setTimeout(refresh, 21_000);
  globalThis.setTimeout(refresh, 25_000);
  ctx.touch();
  const out = await run(ctx, "awake", inputForChange(change), "awake");
  if (!out.ok && !out.unconfirmed) S.tap = null;
  ctx.touch();
  return out;
}

async function flipSwitch(ctx, open, key, value) {
  const overlay = `${open ? "open" : "closed"}.${key}`;
  S.overlays.tap(overlay, value);
  ctx.touch();
  const input = { settings: { [key]: value }, ...(open ? { mode: "open" } : {}) };
  const out = await run(ctx, "lidActions", input, "lid");
  if (!out.ok && !out.unconfirmed) S.overlays.drop(overlay);
  ctx.touch();
}

function modeSwitches(ctx, open) {
  const mac = open ? view.awakeOpenActions(ctx.view) : view.awakeLidActions(ctx.view);
  if (!mac) return null;
  const infos = open ? OPEN_ACTION_INFOS : LID_ACTION_INFOS;
  const mode = open ? "open" : "closed";
  return h(
    "div",
    { class: "sm-switches" },
    infos.map((info) =>
      toggle(
        info.title,
        S.overlays.read(`${mode}.${info.key}`, mac[info.key]),
        (value) => void flipSwitch(ctx, open, info.key, value),
        {
          detail: info.detail,
          busy: S.overlays.pending(`${mode}.${info.key}`, mac[info.key]),
          id: `${open ? "open" : "lid"}-action-${info.key}`,
        },
      ),
    ),
    S.problems.lid
      ? h("p", { class: "note sm-problem", role: "status" }, S.problems.lid)
      : h(
          "p",
          { class: "note" },
          open
            ? "While a session runs with the lid open. Undone when it ends."
            : "When the lid closes in a lid closed session. Undone when it opens.",
        ),
  );
}

function modeTabs(ctx, a, status) {
  const closed = status ? status.lid != null : S.withLid;
  const pick = (wantClosed) => {
    S.withLid = wantClosed;
    if (status && (status.lid != null) !== wantClosed) {
      const minutes = status.until === null ? null : Math.max(1, Math.ceil((status.until - Date.now()) / 60_000));
      if (wantClosed && !a.lidReady) return ctx.touch();
      void changeAwake(ctx, {
        kind: "start",
        minutes: minutes ?? (wantClosed ? S.chosenMinutes : null),
        lid: wantClosed,
      });
      return undefined;
    }
    return ctx.touch();
  };
  return h(
    "div",
    { class: "sm-block" },
    segmented(
      "Mode",
      [
        { value: "open", title: "Lid open" },
        { value: "closed", title: "Lid closed" },
      ],
      closed ? "closed" : "open",
      (value) => pick(value === "closed"),
    ),
    closed && !a.lidReady
      ? h(
          "p",
          { class: "note" },
          "Lid closed needs setting up once in Squeak on your Mac, under Settings, Keep awake. Its switches are saved for then.",
        )
      : null,
  );
}

function onCard(ctx, status) {
  const now = Date.now();
  const leftMin = status.until === null ? null : Math.max(0, (status.until - now) / 60_000);
  if (status.until !== S.peakUntil) {
    S.peakUntil = status.until;
    if (leftMin !== null) S.peak = Math.max(Math.ceil(leftMin), 1);
  }
  const peak = Math.max(S.peak, leftMin === null ? 1 : Math.ceil(leftMin), 1);
  const title = status.pending
    ? "Starting…"
    : status.until === null
      ? "On until you end it"
      : `On until ${clockText(status.until)}`;
  const nodes = [
    h(
      "div",
      { class: "sm-on", role: "status" },
      h("span", { class: status.pending ? "dot" : "dot d-working pulse", "aria-hidden": "true" }),
      h(
        "div",
        null,
        h("div", { class: "sm-on-title" }, title),
        status.until !== null && !status.pending
          ? h("div", { class: "note" }, `${left(status.until, now)} left`)
          : null,
      ),
    ),
    leftMin === null
      ? null
      : h("progress", { class: "sm-progress", max: peak, value: Math.min(leftMin, peak), "aria-label": "Time left" }),
  ];
  if (status.lid) {
    const [t, d] = lidRowText(status.lid, status.lidProblem);
    nodes.push(
      h(
        "div",
        { class: "sm-lid" },
        h("span", {
          class: status.lid === "on" ? "dot d-working" : status.lid === "starting" ? "dot" : "dot d-error",
          "aria-hidden": "true",
        }),
        h("div", null, h("div", null, t), h("div", { class: "note" }, d)),
      ),
    );
  }
  if (status.safety) nodes.push(h("p", { class: "note" }, status.safety));
  nodes.push(
    S.confirmEnd
      ? h(
          "div",
          { class: "row-actions", role: "group", "aria-label": "Let your Mac sleep again?" },
          h("span", null, "Let your Mac sleep again?"),
          h(
            "button",
            {
              class: "btn danger",
              type: "button",
              onclick: () => {
                S.confirmEnd = false;
                void changeAwake(ctx, { kind: "end" });
              },
            },
            "End awake session",
          ),
          h(
            "button",
            { class: "btn quiet", type: "button", onclick: () => ((S.confirmEnd = false), ctx.touch()) },
            "Keep it",
          ),
        )
      : h(
          "div",
          { class: "row-actions" },
          status.until !== null
            ? h(
                "button",
                { class: "btn", type: "button", onclick: () => void changeAwake(ctx, { kind: "extend", minutes: 60 }) },
                "+1 hour",
              )
            : null,
          h(
            "button",
            { class: "btn danger", type: "button", onclick: () => ((S.confirmEnd = true), ctx.touch()) },
            "End",
          ),
        ),
  );
  return nodes;
}

function offCard(ctx, a, modes, lidActions) {
  const lid = S.withLid && a.lidReady;
  const endedLine = ended(a.lastEnd);
  const start = (minutes) => void changeAwake(ctx, { kind: "start", minutes, lid });
  return [
    endedLine ? h("p", { class: "note" }, endedLine) : null,
    h(
      "div",
      { class: "sm-chips", role: "group", "aria-label": "How long" },
      DURATIONS.map((d) =>
        h(
          "button",
          {
            class: S.chosenMinutes === d.minutes ? "sm-chip on" : "sm-chip",
            type: "button",
            "aria-pressed": S.chosenMinutes === d.minutes ? "true" : "false",
            "aria-label": d.label,
            onclick: () => ((S.chosenMinutes = d.minutes), ctx.touch()),
          },
          d.id,
        ),
      ),
    ),
    h(
      "button",
      { class: "btn primary sm-start", type: "button", onclick: () => start(S.chosenMinutes) },
      modes ? (lid ? "Keep awake, lid closed" : "Keep awake, lid open") : "Keep Mac awake",
    ),
    a.lidReady && !modes
      ? toggle("With the lid closed", S.withLid, (on) => {
          S.withLid = on;
          ctx.touch();
        })
      : null,
    details(
      "More options",
      S.moreOpen,
      (open) => {
        S.moreOpen = open;
      },
      h(
        "div",
        { class: "row-actions" },
        h("label", { for: "sm-until" }, "Until"),
        h("input", {
          id: "sm-until",
          type: "time",
          class: "sm-input",
          value: S.untilClock,
          "data-keep": "sm-until",
          oninput: (event) => (S.untilClock = event.target.value),
        }),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              const minutes = minutesUntil(S.untilClock);
              if (minutes === null) {
                S.problems.awake = "Pick a time first.";
                return ctx.touch();
              }
              return start(minutes);
            },
          },
          "Start",
        ),
      ),
      !lid
        ? h(
            "button",
            {
              class: "btn quiet",
              type: "button",
              onclick: () => void changeAwake(ctx, { kind: "start", minutes: null }),
            },
            "Until I end it",
          )
        : null,
      !modes && lidActions
        ? h(
            "div",
            { class: "sm-block" },
            h("strong", { class: "sm-sub" }, "When the lid closes"),
            modeSwitches(ctx, false),
          )
        : null,
    ),
  ];
}

export function awakeSection(ctx) {
  const v = ctx.view;
  const a = readAwake(v);
  if (!a.offered) return null;
  const now = Date.now();
  const status = awakeStatus(a.mac, S.tap, now);
  const modes = view.awakeOpenActions(v) !== null;
  const lidActions = view.awakeLidActions(v) !== null;
  const nodes = [silentNote(ctx)];
  const tabs = () => [modeTabs(ctx, a, status), modeSwitches(ctx, !(status ? status.lid != null : S.withLid))];
  if (modes && !status) nodes.push(...tabs());
  nodes.push(...(status ? onCard(ctx, status) : offCard(ctx, a, modes, lidActions)));
  if (a.sleepProblem) {
    nodes.push(
      h(
        "div",
        { class: "sm-lid", role: "alert" },
        h("span", { class: "dot d-error", "aria-hidden": "true" }),
        h("div", null, h("div", null, "Sleep is still turned off"), h("div", { class: "note" }, a.sleepProblem)),
      ),
    );
  }
  if (status && modes) nodes.push(...tabs());
  else if (status && lidActions)
    nodes.push(
      h(
        "div",
        { class: "sm-block" },
        h("strong", { class: "sm-sub" }, "When the lid closes"),
        modeSwitches(ctx, false),
      ),
    );
  nodes.push(problemLine("awake") ?? h("p", { class: "note" }, awakeFooter(view.awakeRules(v), a.lidReady)));
  return nodes.filter(Boolean);
}

/* ---------- Notifications ---------- */

async function changeNotify(ctx, channel, key, value) {
  const overlay = `${channel}.${key}`;
  S.overlays.tap(overlay, key === "quiet" ? JSON.stringify(value) : value);
  ctx.touch();
  const out = await run(ctx, "notify", notifyInput(channel, key, value), "notify");
  if (!out.ok && !out.unconfirmed) S.overlays.drop(overlay);
  ctx.touch();
}

function channelBlock(ctx, channel, settings) {
  const s = notifyShown(S.overlays, channel.id, settings);
  const send = (key, value) => void changeNotify(ctx, channel.id, key, value);
  const quiet = s.quiet;
  const setQuiet = (next) => {
    if (!quietValid(next)) {
      S.problems.notify = "Quiet hours need different start and end times.";
      return ctx.touch();
    }
    S.problems.notify = null;
    return send("quiet", next);
  };
  return h(
    "div",
    { class: "sm-channel", "data-channel": channel.id },
    h("h3", null, channel.title),
    toggle("Mute", s.muted, (on) => send("muted", on), { id: `${channel.id}-muted` }),
    h(
      "fieldset",
      { class: "sm-fieldset", disabled: s.muted },
      toggle("Needs approval", s.approval, (on) => send("approval", on), { id: `${channel.id}-approval` }),
      toggle("Questions", s.question, (on) => send("question", on), { id: `${channel.id}-question` }),
      toggle("Seems stuck", s.stalled, (on) => send("stalled", on), { id: `${channel.id}-stalled` }),
      toggle("Quota alerts", s.quota, (on) => send("quota", on), { id: `${channel.id}-quota` }),
      h(
        "div",
        { class: "sm-field" },
        h("span", null, "Finished"),
        segmented(
          `Finished, ${channel.title}`,
          FINISHED_MODE_LIST.map((m) => ({ value: m.id, title: m.title })),
          s.finished,
          (mode) => send("finished", mode),
          s.muted,
        ),
      ),
      toggle("Quiet hours", quiet !== null, (on) => send("quiet", on ? { ...DEFAULT_QUIET } : null), {
        id: `${channel.id}-quiet`,
      }),
      quiet
        ? h(
            "div",
            { class: "sm-block" },
            h(
              "div",
              { class: "row-actions" },
              h("label", { for: `${channel.id}-from` }, "From"),
              h("input", {
                id: `${channel.id}-from`,
                class: "sm-input",
                type: "time",
                value: quiet.from,
                onchange: (e) => setQuiet({ from: e.target.value, to: quiet.to }),
              }),
              h("label", { for: `${channel.id}-to` }, "To"),
              h("input", {
                id: `${channel.id}-to`,
                class: "sm-input",
                type: "time",
                value: quiet.to,
                onchange: (e) => setQuiet({ from: quiet.from, to: e.target.value }),
              }),
            ),
            crossesMidnight(quiet)
              ? h("p", { class: "note" }, "Ends the next morning. Your Mac's clock decides.")
              : null,
          )
        : null,
    ),
    s.muted
      ? h("p", { class: "note" }, `Nothing is pushed to ${channel.title} while it's muted, quota alerts included.`)
      : null,
  );
}

async function pressAvatar(ctx) {
  S.avatar.sending = true;
  S.avatar.line = null;
  S.avatar.lockedUntil = Date.now() + AVATAR_COOLDOWN_MS;
  ctx.touch();
  globalThis.setTimeout(() => ctx.touch(), AVATAR_COOLDOWN_MS + 50);
  const out = await run(ctx, "telegramAvatar", {}, "avatar");
  S.avatar.sending = false;
  S.avatar.line = out.ok ? AVATAR_DONE : (out.reason ?? AVATAR_FALLBACK);
  ctx.touch();
}

export function notificationsSection(ctx) {
  const notify = view.notify(ctx.view);
  if (!notify) return null;
  const channels = shownChannels(notify);
  const nodes = [silentNote(ctx)];
  if (channels.length === 0) {
    nodes.push(h("p", { class: "note" }, "No channel is set up on your Mac. Add Telegram or Cliq in Squeak there."));
  }
  for (const channel of channels) nodes.push(channelBlock(ctx, channel, notify[channel.id]));
  if (channels.some((c) => c.id === "telegram") && view.telegramAvatar(ctx.view) === true) {
    const locked = S.avatar.sending || Date.now() < S.avatar.lockedUntil;
    nodes.push(
      h(
        "div",
        { class: "sm-channel" },
        h("h3", null, "Telegram bot picture"),
        h(
          "button",
          { class: "btn", type: "button", disabled: locked, onclick: () => void pressAvatar(ctx) },
          S.avatar.sending ? "Setting…" : "Use Squeak logo",
        ),
        S.avatar.line ? h("p", { class: "note", role: "status" }, S.avatar.line) : null,
      ),
    );
  }
  if (channels.some((c) => c.id === "cliq"))
    nodes.push(h("p", { class: "note" }, "Set the Cliq bot picture from Squeak on your Mac."));
  if (channels.length > 0) nodes.push(h("p", { class: "note" }, QUIET_FOOTNOTE));
  nodes.push(problemLine("notify"));
  return nodes.filter(Boolean);
}

/* ---------- Hotspot ---------- */

async function hotspotRun(ctx, input, then = () => {}) {
  S.hotspot.busy = true;
  ctx.touch();
  const out = await run(ctx, "hotspot", input, "hotspot");
  S.hotspot.busy = false;
  if (out.ok) then();
  ctx.touch();
}

export function hotspotSection(ctx) {
  const hs = view.hotspot(ctx.view);
  if (!hs) return null;
  const f = S.hotspot;
  const nodes = [silentNote(ctx)];
  if (hs.configured && !f.editing) {
    nodes.push(
      h(
        "dl",
        { class: "sm-rows" },
        h("dt", null, "Mac is on"),
        h("dd", null, hs.onHotspot ? "Your hotspot" : "Its usual Wi-Fi"),
        h("dt", null, "Hotspot"),
        h("dd", null, hs.ssid ?? ""),
      ),
      toggle(
        "Switch if its Wi-Fi drops",
        S.overlays.read("hotspot.enabled", hs.enabled),
        (on) => {
          S.overlays.tap("hotspot.enabled", on);
          void hotspotRun(ctx, { action: "configure", ssid: hs.ssid ?? "", enabled: on }).then(() => {
            if (S.problems.hotspot) S.overlays.drop("hotspot.enabled");
            ctx.touch();
          });
        },
        { disabled: f.busy },
      ),
      h(
        "div",
        { class: "row-actions" },
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: f.busy,
            onclick: () => void hotspotRun(ctx, { action: hs.onHotspot ? "leave" : "join" }),
          },
          hs.onHotspot ? "Back to Wi-Fi" : "Switch Mac to hotspot now",
        ),
        h(
          "button",
          {
            class: "btn quiet",
            type: "button",
            onclick: () => {
              Object.assign(f, { ssid: hs.ssid ?? "", password: "", enabled: hs.enabled, editing: true });
              ctx.touch();
            },
          },
          "Change name or password",
        ),
      ),
    );
  } else {
    const form = [
      h("label", { class: "sm-label", for: "sm-hs-ssid" }, "Hotspot name"),
      h("input", {
        id: "sm-hs-ssid",
        class: "sm-input wide",
        type: "text",
        autocomplete: "off",
        autocapitalize: "none",
        spellcheck: "false",
        value: f.ssid,
        "data-keep": "sm-hs-ssid",
        oninput: (e) => ((f.ssid = e.target.value), refreshSave()),
      }),
      h("label", { class: "sm-label", for: "sm-hs-password" }, "Hotspot password"),
      h("input", {
        id: "sm-hs-password",
        class: "sm-input wide",
        type: "password",
        autocomplete: "new-password",
        value: f.password,
        "data-keep": "sm-hs-password",
        oninput: (e) => ((f.password = e.target.value), refreshSave()),
      }),
      toggle("Switch if its Wi-Fi drops", f.enabled, (on) => (f.enabled = on)),
    ];
    const save = h(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: f.busy || !hotspotFormValid(f.ssid, f.password),
        onclick: () =>
          void hotspotRun(
            ctx,
            { action: "configure", ssid: f.ssid.trim(), password: f.password, enabled: f.enabled },
            () => {
              f.editing = false;
              f.password = "";
            },
          ),
      },
      f.busy ? "Saving…" : "Save on your Mac",
    );
    function refreshSave() {
      save.disabled = f.busy || !hotspotFormValid(f.ssid, f.password);
    }
    const body = [
      ...form,
      h(
        "div",
        { class: "row-actions" },
        save,
        f.editing
          ? h(
              "button",
              { class: "btn quiet", type: "button", onclick: () => ((f.editing = false), ctx.touch()) },
              "Cancel",
            )
          : null,
      ),
    ];
    nodes.push(
      hs.configured
        ? h("div", { class: "sm-block" }, body)
        : details("Set up hotspot failover", f.setupOpen, (open) => (f.setupOpen = open), body),
    );
  }
  nodes.push(h("p", { class: "note" }, S.problems.hotspot ?? hs.last?.note ?? hotspotFooter(hs)));
  return nodes.filter(Boolean);
}

/* ---------- Phone calls ---------- */

export function voiceSection(ctx) {
  const voice = view.voice(ctx.view);
  if (!voice) return null;
  const f = S.voice;
  const nodes = [silentNote(ctx)];
  if (!voice.isOn) {
    nodes.push(h("p", { class: "note" }, modeLine(voice)));
    return nodes.filter(Boolean);
  }
  const typed = f.typed ?? voice.callee ?? "";
  const normalized = normalizedExtension(typed);
  const changed = normalized !== voice.callee;
  const valid = normalized === null || isExtension(normalized);
  const ringing = voice.lastTest?.status === "ringing";
  const save = async () => {
    f.busy = true;
    ctx.touch();
    const out = await run(ctx, "voice", { change: { callee: normalized } }, "voice");
    f.busy = false;
    if (out.ok) f.typed = null;
    ctx.touch();
  };
  nodes.push(
    h(
      "div",
      { class: "sm-block" },
      h("label", { class: "sm-label", for: "sm-ext" }, "Extension to ring"),
      h(
        "div",
        { class: "row-actions" },
        h("input", {
          id: "sm-ext",
          class: "sm-input",
          type: "text",
          inputmode: "numeric",
          autocomplete: "off",
          placeholder: voice.defaultCallee ?? "101",
          value: typed,
          "data-keep": "sm-ext",
          oninput: (e) => ((f.typed = e.target.value), saveBtn(e.target.value)),
        }),
        saveButton(),
      ),
      h(
        "p",
        { class: valid ? "note" : "note sm-problem" },
        valid
          ? "Your phone's extension in 3CX, like 101. Only an extension is accepted, never an outside number."
          : "An extension is 2 to 6 digits, like 101.",
      ),
    ),
  );
  function saveButton() {
    return h(
      "button",
      {
        class: "btn",
        type: "button",
        id: "sm-ext-save",
        disabled: !changed || !valid || f.busy,
        onclick: () => void save(),
      },
      f.busy ? "Saving…" : "Save",
    );
  }
  function saveBtn(text) {
    const n = normalizedExtension(text);
    const button = globalThis.document?.getElementById("sm-ext-save");
    if (button) button.disabled = n === voice.callee || !(n === null || isExtension(n)) || f.busy;
  }
  const line = testLine(voice.lastTest);
  nodes.push(
    h(
      "div",
      { class: "sm-block" },
      h("strong", { class: "sm-sub" }, "Test call"),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: ringing || f.testing || (voice.callee === null && voice.defaultCallee === null),
          onclick: async () => {
            f.testing = true;
            ctx.touch();
            await run(ctx, "voice", { change: { test: true } }, "voice");
            f.testing = false;
            ctx.touch();
          },
        },
        ringing || f.testing ? "Calling…" : "Call me now",
      ),
      line ? h("p", { class: "note", role: "status" }, line) : null,
      h("p", { class: "note" }, "Rings you with a made-up question. Nothing is sent to any chat."),
    ),
  );
  if (voice.mode === "gateway") {
    const p = f.pins;
    const ready = pinReady(p.current, p.next, p.again);
    const pinField = (id, label, key) => [
      h("label", { class: "sm-label", for: id }, label),
      h("input", {
        id,
        class: "sm-input",
        type: "password",
        inputmode: "numeric",
        autocomplete: "off",
        value: p[key],
        "data-keep": id,
        oninput: (e) => {
          p[key] = e.target.value;
          const b = globalThis.document?.getElementById("sm-pin-save");
          if (b) b.disabled = !pinReady(p.current, p.next, p.again) || f.pinBusy;
        },
      }),
    ];
    nodes.push(
      h(
        "div",
        { class: "sm-block" },
        h("strong", { class: "sm-sub" }, "Pin"),
        pinField("sm-pin-cur", "Current pin", "current"),
        pinField("sm-pin-new", "New pin", "next"),
        pinField("sm-pin-again", "New pin again", "again"),
        h(
          "button",
          {
            id: "sm-pin-save",
            class: "btn",
            type: "button",
            disabled: !ready || f.pinBusy,
            onclick: async () => {
              f.pinBusy = true;
              f.pinNote = null;
              ctx.touch();
              const out = await run(
                ctx,
                "voice",
                { change: { pin: { current: p.current, next: p.next } } },
                "voicepin",
              );
              f.pinBusy = false;
              if (out.ok) {
                f.pinNote = "Your pin is changed. It applies from the next call.";
                Object.assign(p, { current: "", next: "", again: "" });
              } else f.pinNote = out.reason;
              ctx.touch();
            },
          },
          f.pinBusy ? "Changing…" : "Change pin",
        ),
        f.pinNote ? h("p", { class: "note", role: "status" }, f.pinNote) : null,
        h(
          "p",
          { class: "note" },
          "The pin you key in on a call, 4 to 12 digits. It needs your current pin, and is kept on Home Assistant, not on your Mac.",
        ),
      ),
    );
  }
  nodes.push(h("p", { class: "note" }, modeLine(voice)), problemLine("voice"));
  return nodes.filter(Boolean);
}
