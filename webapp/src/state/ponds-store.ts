// What the Ponds screen holds: the overview (Ponds and Invitations, metadata only), one open session per Pond (its keys, its
// feed, what it says), the connection state, and the two answers to an invitation.
//
// The relay says which Ponds there are and how far each has got. Everything else the list draws (the line under a name, the
// working mark, Needs you, unread) is worked out here from the Pond's decrypted documents, and until the Owner's Mac has sealed
// the Pond key to this browser a Pond reads "Connecting: waiting for <Owner>'s Mac". The overview is read once on open and again
// when a live notice or the 30 s poll says something changed; each Pond's feed is read on the same cues.

import type { PondsOverview, PondSummary } from "../../../src/shared/shapes.js";
import type { KeyValueStore } from "../auth/session.js";
import type { Device } from "../pond/device.js";
import { lineOf, needsYouOf, type NeedsYouItem, type PondDerived } from "../pond/derive.js";
import { createSession, type PondSession } from "../pond/session.js";
import type { Relay } from "../relay/client.js";
import { createLive, readPresence, type Connection, type LiveOptions } from "../relay/live.js";

export interface PondsState {
  status: "loading" | "ready" | "failed" | "signed-out";
  overview: PondsOverview;
  /** What the browser worked out from each Pond's own documents, by Pond id. */
  derived: Record<string, PondDerived>;
  needsYou: NeedsYouItem[];
  /** Ponds the Owner deleted, by Pond id: the name to say "<name> was deleted." with. They are not in the list and hold no data here. */
  deleted: Record<string, string>;
  connection: Connection;
  /** Invitations being answered, and the sentence for one that failed. */
  busy: string[];
  errors: Record<string, string>;
}

export const ANSWER_FAILED = "That didn't go through. Try again.";
export const connectingLine = (owner: string): string =>
  `Connecting: waiting for ${owner.trim().split(/\s+/)[0]}'s Mac`;

const EMPTY: PondsOverview = { ponds: [], invitations: [] };
const SEEN = "squeak-seen-";

export interface PondsStore {
  state(): PondsState;
  subscribe(listener: (state: PondsState) => void): () => void;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  /** The open session of a Pond in the last overview, or null. */
  session(pondId: string): PondSession | null;
  /** This person has looked at the Pond up to its newest change: it is no longer unread. */
  markSeen(pondId: string): void;
  /** Join: the Pond to open once the cloud confirms, or null. */
  join(inviteId: string): Promise<string | null>;
  decline(inviteId: string): Promise<void>;
}

export interface PondsStoreDeps {
  relay: Relay;
  token: string;
  liveBase: string | null;
  device: Device;
  /** Where "seen up to" is kept (localStorage). */
  seen: KeyValueStore;
  deviceId?: string;
  fetch?: LiveOptions["fetch"];
  now?: () => number;
  /** The session ended (a 401): the app signs out. */
  onSignedOut?(): void;
}

export function createPondsStore(deps: PondsStoreDeps): PondsStore {
  let state: PondsState = {
    status: "loading",
    overview: EMPTY,
    derived: {},
    needsYou: [],
    deleted: {},
    connection: deps.liveBase ? "reconnecting" : "polling",
    busy: [],
    errors: {},
  };
  const listeners = new Set<(s: PondsState) => void>();
  const emit = (): void => listeners.forEach((l) => l(state));
  const set = (patch: Partial<PondsState>): void => {
    state = { ...state, ...patch };
    emit();
  };
  const sessions = new Map<string, { session: PondSession; pond: PondSummary }>();
  let reading: Promise<void> | null = null;
  let again = false;

  const seenOf = (pondId: string): number => Number(deps.seen.getItem(`${SEEN}${pondId}`) ?? "");
  const setSeen = (pondId: string, seq: number): void => {
    try {
      deps.seen.setItem(`${SEEN}${pondId}`, String(seq));
    } catch {
      // storage refused: the Pond stays unread until the next visit
    }
  };

  /** Forgets a deleted Pond here: its open session (keys, token, opened documents) and its "seen up to". */
  const wipe = (pondId: string): void => {
    const held = sessions.get(pondId);
    if (held) {
      held.session.stop();
      sessions.delete(pondId);
    }
    try {
      deps.seen.removeItem(`${SEEN}${pondId}`);
    } catch {
      // storage refused: the mark is harmless
    }
  };

  /** Everything the list draws from the sessions' documents; recomputed whenever a Pond's documents change. */
  const derive = (): void => {
    const derived: Record<string, PondDerived> = {};
    const needsYou: NeedsYouItem[] = [];
    for (const { session, pond } of sessions.values()) {
      const s = session.state();
      const items = s.data ? needsYouOf(pond, s.data) : [];
      needsYou.push(...items);
      const head = Math.max(pond.seqHead, s.data?.head ?? 0);
      const seen = deps.seen.getItem(`${SEEN}${pond.pondId}`);
      derived[pond.pondId] = {
        line: s.data ? lineOf(pond, s.data) : connectingLine(pond.ownerName),
        working: s.data?.ducks.some((d) => d.state === "working") ?? false,
        needsYou: items.length > 0,
        // A Pond never opened on this browser is not "unread": there is nothing to compare to yet.
        unread: seen !== null && head > Number(seen),
        connecting: s.access === "connecting",
      };
    }
    needsYou.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    state = { ...state, derived, needsYou };
    emit();
  };

  const syncSessions = (ponds: PondSummary[]): void => {
    const ids = new Set(ponds.map((p) => p.pondId));
    for (const [id, held] of sessions) {
      if (!ids.has(id)) {
        held.session.stop();
        sessions.delete(id);
      }
    }
    for (const pond of ponds) {
      const held = sessions.get(pond.pondId);
      if (held) {
        held.pond = pond;
        continue;
      }
      if (deps.seen.getItem(`${SEEN}${pond.pondId}`) === null) setSeen(pond.pondId, pond.seqHead);
      const session = createSession({
        relay: deps.relay,
        token: deps.token,
        pond,
        device: () => deps.device.ready(),
        ...(deps.liveBase ? { presence: () => readPresence(deps.liveBase!, deps.token, pond.pondId, deps.fetch) } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        onSignedOut: () => {
          set({ status: "signed-out" });
          deps.onSignedOut?.();
        },
        onChange: derive,
      });
      sessions.set(pond.pondId, { session, pond });
    }
  };

  const read = async (): Promise<void> => {
    const result = await deps.relay.overview(deps.token);
    if (result.status === "unauthorized") {
      set({ status: "signed-out" });
      deps.onSignedOut?.();
    } else if (result.status === "ok") {
      const o = result.overview;
      // A Pond the Owner deleted leaves the list and everything this browser kept of it is wiped.
      const deleted = { ...state.deleted };
      for (const p of o.ponds) if (p.deleted) deleted[p.pondId] = p.name;
      for (const id of Object.keys(deleted)) wipe(id);
      // Newest first, always (docs/spec.md: every list is newest first).
      const ponds = o.ponds.filter((p) => !p.deleted).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const invitations = [...o.invitations].sort((a, b) => b.at - a.at);
      syncSessions(ponds);
      set({ status: "ready", overview: { ponds, invitations }, deleted });
      derive();
      // Each Pond's own feed is read on the same cue; one that cannot be read leaves the list as it was.
      void Promise.all([...sessions.values()].map((h) => h.session.refresh()));
    } else if (state.status !== "ready") {
      set({ status: "failed" });
    }
  };
  // One read at a time; a notice that lands during a read asks for exactly one more.
  const refresh = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = read().finally(() => {
      reading = null;
      if (again) {
        again = false;
        void refresh();
      }
    });
    return reading;
  };

  const live = createLive({
    base: deps.liveBase,
    token: deps.token,
    deviceId: deps.deviceId ?? Math.random().toString(36).slice(2, 12),
    ponds: () => state.overview.ponds.map((p) => p.pondId),
    onChange: () => void refresh(),
    onState: (connection) => set({ connection }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const answer = async (inviteId: string, how: "join" | "decline"): Promise<string | null> => {
    if (state.busy.includes(inviteId)) return null;
    set({ busy: [...state.busy, inviteId], errors: { ...state.errors, [inviteId]: "" } });
    const result = await deps.relay.respond(deps.token, inviteId, how);
    const busy = state.busy.filter((id) => id !== inviteId);
    if (result.status === "ok") {
      set({ busy });
      await refresh();
      return result.pondId;
    }
    if (result.status === "unauthorized") {
      set({ busy, status: "signed-out" });
      deps.onSignedOut?.();
      return null;
    }
    // A refusal is the relay's own sentence ("This invitation was withdrawn."); the list is read again so the row goes or
    // changes from what the relay now says, never left as it was.
    const refused = result.status === "refused";
    set({ busy, errors: { ...state.errors, [inviteId]: (refused && result.message) || ANSWER_FAILED } });
    if (refused) await refresh();
    return null;
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      void refresh().then(() => live.start());
    },
    stop() {
      live.stop();
      for (const { session } of sessions.values()) session.stop();
      sessions.clear();
    },
    refresh,
    session: (pondId) => sessions.get(pondId)?.session ?? null,
    markSeen(pondId) {
      const held = sessions.get(pondId);
      if (!held) return;
      const head = Math.max(held.pond.seqHead, held.session.state().data?.head ?? 0);
      if (head > seenOf(pondId)) {
        setSeen(pondId, head);
        derive();
      }
    },
    join: (id) => answer(id, "join"),
    async decline(id) {
      await answer(id, "decline");
    },
  };
}
