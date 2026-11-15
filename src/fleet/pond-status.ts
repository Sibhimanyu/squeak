import { rollupStatus, type StatusRollup } from "./status-rollup.js";
import type { FleetSession } from "./types.js";

/** `/state.pondStatus`: the status rollup of each pond's active chats, keyed by the directory's pond id. */
export function pondStatusOf(
  sessions: readonly FleetSession[],
  pondIdOf: (session: FleetSession) => string | null,
): Record<string, StatusRollup> {
  const groups = new Map<string, FleetSession[]>();
  for (const session of sessions) {
    const id = pondIdOf(session);
    if (id) groups.set(id, [...(groups.get(id) ?? []), session]);
  }
  return Object.fromEntries([...groups].map(([id, list]) => [id, rollupStatus(list)]));
}
