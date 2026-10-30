import type { CallEntry } from "./call-history.js";
import type { CallEvent } from "./call-trace.js";
import type { VoiceFavorite } from "./favorites.js";

/**
 * What the phone channel adds to the phone-call settings the Mac app already has (docs/remote-channel.md, "Phone
 * calls"): a bounded recent-calls log, and the two settings the Mac app edits through `POST /control/voice` that a
 * phone could not (the realistic voice, the quick workspaces). Both end in the same stores as the Mac's route.
 */

export const PHONE_CALLS_MAX = 20;
export const PHONE_CALL_EVENTS_MAX = 40;
export const PHONE_EVENT_TEXT_MAX = 200;
export const PHONE_SUMMARY_MAX = 160;

/** The phone's capability name (its presence `caps`) for the calls log. */
export const PHONE_CALLS_CAP = "calls";

export interface PhoneCallEvent {
  at: number;
  source: CallEvent["source"];
  kind: CallEvent["kind"];
  text: string;
}

export type PhoneCall = Omit<CallEntry, "id"> & { id: string; events: PhoneCallEvent[] };

/** The newest calls with their step log, clipped: 20 calls, 40 lines of 200 characters each, oldest line first. */
export function phoneCalls(
  history: { list(limit: number): CallEntry[] },
  trace: { eventsFor(entry: Pick<CallEntry, "at" | "durationMs">): CallEvent[] },
): PhoneCall[] {
  return history.list(PHONE_CALLS_MAX).map((entry) => ({
    ...entry,
    // One optional line of what the call did, clipped again here so no store can widen what leaves the Mac.
    ...(entry.summary ? { summary: entry.summary.slice(0, PHONE_SUMMARY_MAX) } : {}),
    events: trace
      .eventsFor(entry)
      .slice(0, PHONE_CALL_EVENTS_MAX)
      .map((event) => ({
        at: event.at,
        source: event.source,
        kind: event.kind,
        text: event.text.slice(0, PHONE_EVENT_TEXT_MAX),
      })),
  }));
}

export interface PhoneVoiceContext {
  natural: {
    installed(): boolean;
    apply(request: unknown): { ok: true } | { ok: false; reason: string };
  };
  favorites: { apply(request: unknown): { ok: true; favorites: VoiceFavorite[] } | { ok: false; reason: string } };
  /** Workspace keys a favourite may name: the ones on offer now, and the ones already saved. */
  knownWorkspaces(): Set<string>;
  currentFavorites(): VoiceFavorite[];
}

export type PhoneVoiceOutcome = { ok: true } | { ok: false; reason: string };

/**
 * `{ natural: { enabled?, voice? } }` or `{ favorites: [{ n, workspace }] }`, exactly one key. Returns null for any
 * other change (the caller handles callee, pause, policy). A phone may only name a workspace this Mac offers (or one
 * already saved), and the realistic voice must be installed.
 */
export function applyPhoneVoiceChange(request: unknown, ctx: PhoneVoiceContext): PhoneVoiceOutcome | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
  const keys = Object.keys(request);
  if (!keys.includes("natural") && !keys.includes("favorites")) return null;
  if (keys.length !== 1) return { ok: false, reason: "Send exactly one voice setting." };
  if ("natural" in request) {
    if (!ctx.natural.installed()) return { ok: false, reason: "The realistic voice is not installed on this Mac." };
    return ctx.natural.apply(request.natural);
  }
  const list = (request as { favorites: unknown }).favorites;
  if (Array.isArray(list)) {
    const known = ctx.knownWorkspaces();
    for (const saved of ctx.currentFavorites()) known.add(saved.workspace);
    for (const entry of list) {
      const workspace = (entry as { workspace?: unknown } | null)?.workspace;
      if (typeof workspace === "string" && !known.has(workspace)) {
        return { ok: false, reason: "This Mac does not know that workspace." };
      }
    }
  }
  const outcome = ctx.favorites.apply(request);
  return outcome.ok ? { ok: true } : outcome;
}
