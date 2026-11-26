// What the Ponds screen holds: the overview (Ponds, Invitations, Needs you), the connection state, and the two answers to an
// invitation. Nothing is worked out here: the list is read from the relay (`GET /account/overview`) once on open and again when
// a live notice or the 30 s poll says something changed. Join and Decline change the screen only after the cloud confirms.

import type { PondsOverview } from "../../../src/shared/shapes.js";
import type { Relay } from "../relay/client.js";
import { createLive, type Connection, type LiveOptions } from "../relay/live.js";

export interface PondsState {
  status: "loading" | "ready" | "failed" | "signed-out";
  overview: PondsOverview;
  connection: Connection;
  /** Invitations being answered, and the sentence for one that failed. */
  busy: string[];
  errors: Record<string, string>;
}

export const ANSWER_FAILED = "That didn't go through. Try again.";

const EMPTY: PondsOverview = { ponds: [], invitations: [], needsYou: [] };

export interface PondsStore {
  state(): PondsState;
  subscribe(listener: (state: PondsState) => void): () => void;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  /** Join: the Pond to open once the cloud confirms, or null. */
  join(inviteId: string): Promise<string | null>;
  decline(inviteId: string): Promise<void>;
}

export interface PondsStoreDeps {
  relay: Relay;
  token: string;
  liveBase: string | null;
  deviceId?: string;
  fetch?: LiveOptions["fetch"];
  /** The session ended (a 401): the app signs out. */
  onSignedOut?(): void;
}

export function createPondsStore(deps: PondsStoreDeps): PondsStore {
  let state: PondsState = {
    status: "loading",
    overview: EMPTY,
    connection: deps.liveBase ? "reconnecting" : "polling",
    busy: [],
    errors: {},
  };
  const listeners = new Set<(s: PondsState) => void>();
  const set = (patch: Partial<PondsState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };
  let reading: Promise<void> | null = null;
  let again = false;

  const read = async (): Promise<void> => {
    const result = await deps.relay.overview(deps.token);
    if (result.status === "unauthorized") {
      set({ status: "signed-out" });
      deps.onSignedOut?.();
    } else if (result.status === "ok") {
      const o = result.overview;
      // Newest first, always (docs/spec.md: every list is newest first).
      const ponds = [...o.ponds].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const invitations = [...o.invitations].sort((a, b) => b.at - a.at);
      const needsYou = [...o.needsYou].sort((a, b) => b.at - a.at);
      set({ status: "ready", overview: { ponds, invitations, needsYou } });
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
    set({ busy, errors: { ...state.errors, [inviteId]: ANSWER_FAILED } });
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
    stop: () => live.stop(),
    refresh,
    join: (id) => answer(id, "join"),
    async decline(id) {
      await answer(id, "decline");
    },
  };
}
