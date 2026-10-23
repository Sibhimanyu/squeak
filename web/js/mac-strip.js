// The words of Home's Mac status strip (MacStrip.swift): awake, lid, power, or
// a Mac that is not answering. A pure function of what the Mac already sends;
// null means the strip stays hidden. Also how "not answering" is decided
// (MacLiveness) and when the launch splash is up (Splash.swift).

import { heardAgo } from "./presentation.js";

/** The phone pings every 20 s and the Mac answers within a few; a minute with no answer is a Mac that is not there. */
export const ANSWER_WINDOW_MS = 60_000;
/** Just opened: the answer on record is from the last visit, so the first ping's answer gets this long. */
export const OPEN_GRACE_MS = 30_000;

/** `{ kind: "unknown" | "answering" | "checking" | "silent", since? }` (`MacLiveness.read`). */
export function liveness({ aliveAt, lookingSince, now = Date.now() }) {
  if (typeof aliveAt !== "number") return { kind: "unknown" };
  if (now - aliveAt < ANSWER_WINDOW_MS) return { kind: "answering" };
  if (typeof lookingSince === "number" && now - lookingSince < OPEN_GRACE_MS) return { kind: "checking" };
  return { kind: "silent", since: aliveAt };
}

/** "1h 23m" / "45m" / "under a minute" until `until` (`AwakeFormat.left`). */
export function left(until, now = Date.now()) {
  const minutes = Math.ceil((until - now) / 60_000);
  if (minutes <= 1) return "under a minute";
  const hours = Math.trunc(minutes / 60);
  if (hours >= 24) return `${Math.trunc(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** A line for a session a safety rule ended, within the last 6 hours (`AwakeFormat.ended`). */
export function ended(end, now = Date.now()) {
  if (!end || (end.reason !== "battery" && end.reason !== "heat")) return null;
  const at = typeof end.at === "string" ? Date.parse(end.at) : Number.NaN;
  if (Number.isFinite(at) && now - at > 6 * 3600_000) return null;
  const what =
    end.reason === "battery"
      ? "The last session ended because the battery ran low"
      : "The last session ended because your Mac got too hot";
  return `${what}${end.why ? ` (${end.why})` : ""}.`;
}

/** The awake session the Mac's view describes, or null. */
export function awakeFrom(view) {
  if (view?.keepAwake !== true) return null;
  const until = typeof view.awakeUntil === "string" ? Date.parse(view.awakeUntil) : Number.NaN;
  return {
    until: Number.isFinite(until) ? until : null,
    lid: view.awakeLid ?? null,
    safety: view.awakeSafety ?? null,
    pending: false,
  };
}

function lidText(awake, power) {
  switch (awake?.lid) {
    case "on":
      return { text: "Lid closed OK", failed: false };
    case "starting":
      return { text: "Getting ready for a closed lid", failed: false };
    case "failed":
      return { text: "Lid closed didn't turn on", failed: true };
    default:
      return { text: power?.lidClosed === true ? "Lid closed" : "Lid open only", failed: false };
  }
}

function powerText(awake, power) {
  if (awake.safety) return awake.safety;
  if (typeof power?.percent !== "number") return null;
  if (typeof power.onBattery !== "boolean") return `${power.percent}%`;
  return `${power.percent}% ${power.onBattery ? "on battery" : "plugged in"}`;
}

/**
 * `{ tone: "awake" | "off" | "failed" | "silent", lines, spoken }` or null.
 * `view` is the Mac's snapshot; `live` is `liveness()`.
 */
export function compose({ view, live, now = Date.now(), locale }) {
  const result = (tone, lines) => ({ tone, lines, spoken: spoken(tone, lines) });
  if (live?.kind === "silent") {
    return result("silent", ["Mac not answering", `Last heard ${heardAgo(live.since, now)}`]);
  }
  if (!view || view.keepAwake === undefined || view.keepAwake === null) return null;
  const awake = awakeFrom(view);
  const power = view.macPower ?? null;
  if (!awake) {
    if (view.awakeSleepProblem) return result("failed", ["Sleep is still turned off", view.awakeSleepProblem]);
    const end = ended(view.awakeLastEnd, now);
    if (end) return result("off", [end]);
    if (power?.lidClosed === true) return result("off", ["Lid closed · Sleeps as usual"]);
    return null;
  }
  let first;
  if (awake.pending) first = "Starting…";
  else if (awake.until !== null) {
    const clock = new Date(awake.until).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    first = `Awake until ${clock} · ${left(awake.until, now)} left`;
  } else first = "Kept awake until you end it";
  const lid = lidText(awake, power);
  const second = [lid.text];
  const p = powerText(awake, power);
  if (p) second.push(p);
  return result(lid.failed ? "failed" : "awake", [first, second.join(" · ")]);
}

function spoken(tone, lines) {
  const lead = { awake: "Mac awake", off: "Mac", failed: "Mac needs a look", silent: "Mac not answering" }[tone];
  const body = lines.join(". ");
  return body.startsWith(lead) ? body : `${lead}. ${body}`;
}

/** Longest the launch splash stays without a fresh view; then the last known state shows. */
export const SPLASH_CAP_MS = 2_500;

/** `fresh` is whether a view from the Mac has arrived since this load began. */
export function splashShows({ paired, fresh, elapsedMs }) {
  return paired === true && fresh !== true && elapsedMs < SPLASH_CAP_MS;
}
