// Chats put away on this browser only (the iPhone's `hiddenHere`). The Mac and
// Conductor are untouched; a chat comes back by itself when it has newer
// activity. Kept in the browser's preferences under `hiddenChats`
// (`{ [chatKey]: epochMs }`), so Forget this browser wipes it.
//
// The chat menu writes it (chat-extras.js). Home and Settings read it:
//   import { hiddenChats, isHiddenHere, showHiddenAgainChange } from "./hidden-chats.js";
//   const hidden = hiddenChats(ctx.prefs.get("hiddenChats"));          // { key: ms }
//   sessions.filter((s) => !isHiddenHere(hidden, s));                  // Home
//   ctx.prefs.save(showHiddenAgainChange());                           // Settings: "Show hidden chats again"

export const HIDDEN_PREF = "hiddenChats";
const MAX_HIDDEN = 300;

/** The stored value as a clean `{ key: ms }` map; anything else is nothing hidden. */
export function hiddenChats(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out = {};
  for (const [key, at] of Object.entries(stored)) {
    if (typeof key === "string" && key !== "" && typeof at === "number" && Number.isFinite(at)) out[key] = at;
  }
  return out;
}

/** Hidden until the chat has activity after the moment it was put away. */
export function isHiddenHere(hidden, session) {
  const at = hidden?.[session?.key];
  if (typeof at !== "number") return false;
  const last = Date.parse(session.lastActivityAt ?? "");
  return (Number.isFinite(last) ? last : 0) <= at;
}

/** The preference change that hides `session` now: `prefs.save(hideChange(hidden, session))`. */
export function hideChange(hidden, session, now = Date.now()) {
  const next = { ...hiddenChats(hidden), [session.key]: now };
  const keys = Object.keys(next);
  if (keys.length > MAX_HIDDEN) {
    for (const key of keys.sort((a, b) => next[a] - next[b]).slice(0, keys.length - MAX_HIDDEN)) delete next[key];
  }
  return { [HIDDEN_PREF]: next };
}

/** The preference change that shows every hidden chat again. */
export function showHiddenAgainChange() {
  return { [HIDDEN_PREF]: {} };
}

/** How many chats are put away here (for a "Show hidden chats again (3)" row). */
export function hiddenCount(hidden) {
  return Object.keys(hiddenChats(hidden)).length;
}
