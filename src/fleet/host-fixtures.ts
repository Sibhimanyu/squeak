import { CONDUCTOR_RULES } from "./observers/conductor.js";
import type { SourceRules } from "./types.js";

interface HostLike {
  hostId?: string;
  conductorSessionId?: string | null;
  conductorWorkspaceId?: string | null;
  origin?: string;
  source?: string;
  rules?: SourceRules;
}

/** Test support: what the Conductor observer adds, derived from the legacy conductor* fields of a fixture. */
export function withConductorHost<T extends HostLike>(fixture: T): T {
  if (fixture.hostId) return fixture;
  if (!fixture.conductorSessionId && fixture.origin !== "conductor" && fixture.source !== "conductor") return fixture;
  return {
    ...fixture,
    hostId: "conductor",
    hostSessionId: fixture.conductorSessionId ?? null,
    hostWorkspaceId: fixture.conductorWorkspaceId ?? null,
    rules: CONDUCTOR_RULES,
  };
}
