import type { FleetDucklings, FleetSession } from "./types.js";

/**
 * A Squeak-run chat's background helpers ("ducklings"), as the session host reports them (`GET /native/sessions`,
 * `ducklings`). They never change the chat's state: its turn ended, so it is finished/idle and a new message starts
 * a turn at once. They ride on the session for the surfaces to draw, and hold its finish push until they end
 * (`attention.ts`).
 */
export function attachDucklings(session: FleetSession, ducklings: FleetDucklings | undefined): FleetSession {
  if (session.origin !== "squeak" || !ducklings || ducklings.items.length === 0) return session;
  return { ...session, ducklings };
}

/** Helpers running across sessions, for `/state`'s `ducklingsRunning`. */
export function ducklingsRunning(sessions: FleetSession[]): number {
  return sessions.reduce((sum, session) => sum + (session.ducklings?.running ?? 0), 0);
}
