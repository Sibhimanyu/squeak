// One place for what a chat can do and how to address it, so no screen reads
// Conductor's fields directly. A new Mac sends `sessionId` (the one handle for
// every command), `actions` (what this chat takes) and `source` ({ id, label });
// an old Mac sends none of them, and the old rules apply: a chat with a
// `conductorSessionId` is the one that can be answered.

const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);

/** The handle every command names: `sessionId`, else the Conductor id (an old Mac); null for a chat that is not actionable. */
export function chatHandle(session) {
  return nonEmpty(session?.sessionId) ?? nonEmpty(session?.conductorSessionId);
}

/** Whether this chat takes `action` (reply, stop, rename, close, model, archive, queue, photos, diff, earlier). */
export function can(session, action) {
  if (!session) return false;
  if (Array.isArray(session.actions)) return session.actions.includes(action) && chatHandle(session) !== null;
  return chatHandle(session) !== null;
}

/** The source's own name (`source.label`), else Conductor for an old Mac's Conductor chat, else null. */
export function sourceLabel(session) {
  return nonEmpty(session?.source?.label) ?? (nonEmpty(session?.conductorSessionId) ? "Conductor" : null);
}

/** The enabled add-on ids the Mac named (`addons`); null from an old Mac that says nothing. */
export function addons(view) {
  return Array.isArray(view?.addons) ? view.addons.filter((a) => typeof a === "string") : null;
}

/** Whether Conductor-only UI shows: the Mac says the add-on is on, or (an old Mac) it says nothing. */
export function conductorUi(view) {
  const list = addons(view);
  return list === null ? true : list.includes("conductor");
}

/**
 * Whether RasanAI screens show (the films card, a film's screen, review and progress): the Mac says the add-on is on,
 * or (an old Mac that names no add-ons) it sent a `films` list or a chat's `workflow`.
 */
export function rasanaiUi(view) {
  const list = addons(view);
  if (list !== null) return list.includes("rasanai");
  const sessions = [
    ...(Array.isArray(view?.sessions) ? view.sessions : []),
    ...(Array.isArray(view?.recent) ? view.recent : []),
  ];
  return Array.isArray(view?.films) || sessions.some((s) => s && typeof s === "object" && s.workflow != null);
}

/** The "Finished" notify mode for chats you can reply to: "replyable" from a new Mac, "conductor" from an old one. */
export function replyableMode(view) {
  return addons(view) === null ? "conductor" : "replyable";
}

/** Reads either spelling as the one we draw. */
export const readFinishedMode = (v) => (v === "conductor" ? "replyable" : v);

/** A front-app tabs answer: `{ title, workspaces }` for the new "groups" kind and the old "conductor" kind alike. */
export function tabsGroups(answer) {
  if (!answer || typeof answer !== "object") return null;
  const workspaces = Array.isArray(answer.workspaces) ? answer.workspaces : [];
  if (answer.kind === "groups") {
    return { kind: "groups", title: nonEmpty(answer.title) ?? "Your Mac", workspaces };
  }
  if (answer.kind === "conductor") return { kind: "conductor", title: "Conductor", workspaces };
  return null;
}
